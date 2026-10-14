import { createWalletClient, encodeAbiParameters, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gameAbi, getDeployment, getTimings, l1, l1Chain, l2, latestGame, MESSAGE_PASSER, passerAbi, portalAbi } from "./chain.js";
import { ENV } from "./config.js";
import { getMeta, insertWithdrawal, openWithdrawals, setMeta, updateWithdrawal } from "./db.js";

const ZERO32 = `0x${"00".repeat(32)}`;
const now = () => Math.floor(Date.now() / 1000);

export const relayer = ENV.relayerKey
  ? (() => {
      const account = privateKeyToAccount(ENV.relayerKey);
      return { account, wallet: createWalletClient({ account, chain: l1Chain, transport: http(ENV.l1RpcUrl, { timeout: 30_000 }) }) };
    })()
  : null;

export const state = { indexed: -1, l2Head: -1, game: null, lastError: "", lastRunAt: 0 };

const toTx = (w) => ({
  nonce: BigInt(w.tx.nonce),
  sender: w.tx.sender,
  target: w.tx.target,
  value: BigInt(w.tx.value),
  gasLimit: BigInt(w.tx.gasLimit),
  data: w.tx.data,
});

async function indexWithdrawals() {
  const head = Number(await l2.getBlockNumber());
  state.l2Head = head;
  let from = Number(getMeta("indexed", "-1")) + 1;
  while (from <= head) {
    const to = Math.min(head, from + ENV.logChunk - 1);
    const logs = await l2.getContractEvents({ address: MESSAGE_PASSER, abi: passerAbi, eventName: "MessagePassed", fromBlock: BigInt(from), toBlock: BigInt(to) });
    const times = new Map();
    for (const log of logs) {
      if (!times.has(log.blockNumber)) times.set(log.blockNumber, (await l2.getBlock({ blockNumber: log.blockNumber })).timestamp);
      const a = log.args;
      insertWithdrawal({
        hash: a.withdrawalHash,
        nonce: a.nonce.toString(),
        sender: a.sender.toLowerCase(),
        target: a.target.toLowerCase(),
        value: a.value.toString(),
        gasLimit: a.gasLimit.toString(),
        data: a.data,
        l2Block: Number(log.blockNumber),
        l2Time: Number(times.get(log.blockNumber)),
        l2Tx: log.transactionHash,
      });
    }
    setMeta("indexed", to);
    state.indexed = to;
    from = to + 1;
  }
}

/** Everything a wallet (or the relayer) needs to call proveWithdrawalTransaction against the newest game. */
export async function buildProveArgs(w, game) {
  const dep = getDeployment();
  if (!dep) throw Object.assign(new Error("The rollup is not deployed yet"), { statusCode: 409 });
  game ||= await latestGame();
  if (!game || game.l2Timestamp < BigInt(w.l2Time)) {
    throw Object.assign(new Error("No proposal covers this withdrawal yet"), { statusCode: 409 });
  }
  const blockNumber = (game.l2Timestamp - dep.genesisTime) / dep.blockTime;
  const block = await l2.getBlock({ blockNumber });
  if (block.timestamp !== game.l2Timestamp) throw new Error(`L2 block ${blockNumber} is not at the proposal timestamp`);
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [w.hash, 0n]));
  const proof = await l2.getProof({ address: MESSAGE_PASSER, storageKeys: [slot], blockNumber });
  const outputRootProof = { version: ZERO32, stateRoot: block.stateRoot, messagePasserStorageRoot: proof.storageHash, latestBlockhash: block.hash };
  const computed = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [outputRootProof.version, outputRootProof.stateRoot, outputRootProof.messagePasserStorageRoot, outputRootProof.latestBlockhash]
    )
  );
  const claimed = await l1.readContract({ address: game.proxy, abi: gameAbi, functionName: "rootClaimByChainId", args: [BigInt(ENV.l2ChainId)] });
  if (computed !== claimed) throw new Error("The L2 output root does not match the proposal; the node may still be syncing");
  return { portal: dep.portal, tx: toTx(w), gameIndex: game.index, outputRootProof, withdrawalProof: proof.storageProof[0].proof };
}

async function send(functionName, args) {
  const dep = getDeployment();
  const { request } = await l1.simulateContract({ account: relayer.account, address: dep.portal, abi: portalAbi, functionName, args });
  const hash = await relayer.wallet.writeContract(request);
  const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return hash;
}

async function advance(w, game, timings, l1Time) {
  const dep = getDeployment();
  const finalized = await l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "finalizedWithdrawals", args: [w.hash] });
  if (finalized) return updateWithdrawal(w.hash, { status: "finalized", error: null });

  const submitters = Number(await l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "numProofSubmitters", args: [w.hash] }));
  if (submitters === 0) {
    if (!game || game.l2Timestamp < BigInt(w.l2Time)) return updateWithdrawal(w.hash, { status: "waiting-proposal" });
    if (w.status !== "ready-to-prove") updateWithdrawal(w.hash, { status: "ready-to-prove" });
    // The portal rejects proofs against a game created in the current L1 block.
    if (!relayer || game.createdAt >= l1Time) return;
    const args = await buildProveArgs(w, game);
    const hash = await send("proveWithdrawalTransaction", [args.tx, args.gameIndex, args.outputRootProof, args.withdrawalProof]);
    updateWithdrawal(w.hash, { status: "proven", prove_tx: hash, error: null });
    return;
  }

  // Prefer the relayer's own proof, otherwise the first one on record.
  let submitter = await l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "proofSubmitters", args: [w.hash, 0n] });
  if (relayer && submitters > 1) {
    for (let i = 1; i < submitters; i++) {
      const s = await l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "proofSubmitters", args: [w.hash, BigInt(i)] });
      if (s.toLowerCase() === relayer.account.address.toLowerCase()) submitter = s;
    }
  }
  const [gameProxy, provenAt] = await l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "provenWithdrawals", args: [w.hash, submitter] });
  const resolvedAt = Number(await l1.readContract({ address: gameProxy, abi: gameAbi, functionName: "resolvedAt" }));
  const readyAt = Math.max(Number(provenAt) + timings.proofMaturityDelay, resolvedAt + timings.finalityDelay) + 1;
  const fields = { proven_by: submitter.toLowerCase(), proven_at: Number(provenAt), ready_at: readyAt };

  let ready = false;
  if (now() >= readyAt) {
    ready = await l1
      .readContract({ address: dep.portal, abi: portalAbi, functionName: "checkWithdrawal", args: [w.hash, submitter] })
      .then(() => true, () => false);
  }
  if (!ready) return updateWithdrawal(w.hash, { ...fields, status: "proven" });
  updateWithdrawal(w.hash, { ...fields, status: "ready-to-finalize" });
  if (!relayer) return;
  const hash = await send("finalizeWithdrawalTransactionExternalProof", [toTx(w), submitter]);
  updateWithdrawal(w.hash, { status: "finalized", finalize_tx: hash, error: null });
}

async function tick() {
  if (!getDeployment()) return;
  await indexWithdrawals();
  const [game, timings, l1Block] = await Promise.all([latestGame(), getTimings(), l1.getBlock()]);
  state.game = game && { index: Number(game.index), createdAt: game.createdAt, l2Timestamp: Number(game.l2Timestamp), proxy: game.proxy };
  for (const w of openWithdrawals()) {
    try {
      await advance(w, game, timings, Number(l1Block.timestamp));
    } catch (error) {
      updateWithdrawal(w.hash, { error: (error.shortMessage || error.message || String(error)).slice(0, 300) });
    }
  }
}

export function startRelayer(log) {
  const loop = async () => {
    try {
      await tick();
      state.lastError = "";
    } catch (error) {
      state.lastError = (error.shortMessage || error.message || String(error)).slice(0, 300);
      log.warn({ err: state.lastError }, "relayer tick failed");
    }
    state.lastRunAt = now();
    setTimeout(loop, ENV.pollMs);
  };
  loop();
}
