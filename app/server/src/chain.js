import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { ENV } from "./config.js";

export const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

export const portalAbi = parseAbi([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
  "function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _disputeGameIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)",
  "function finalizeWithdrawalTransactionExternalProof((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, address _proofSubmitter)",
  "function checkWithdrawal(bytes32 _withdrawalHash, address _proofSubmitter) view",
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function numProofSubmitters(bytes32) view returns (uint256)",
  "function proofSubmitters(bytes32, uint256) view returns (address)",
  "function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)",
  "function proofMaturityDelaySeconds() view returns (uint256)",
  "function paused() view returns (bool)",
]);
export const factoryAbi = parseAbi([
  "function gameCount() view returns (uint256)",
  "function gameAtIndex(uint256) view returns (uint32 gameType, uint64 timestamp, address proxy)",
]);
export const gameAbi = parseAbi([
  "function l2SequenceNumber() view returns (uint256)",
  "function rootClaimByChainId(uint256) view returns (bytes32)",
  "function createdAt() view returns (uint64)",
  "function resolvedAt() view returns (uint64)",
]);
export const registryAbi = parseAbi([
  "function disputeGameFinalityDelaySeconds() view returns (uint256)",
  "function isGameClaimValid(address) view returns (bool)",
]);
export const passerAbi = parseAbi([
  "function initiateWithdrawal(address _target, uint256 _gasLimit, bytes _data) payable",
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);

const native = { name: ENV.nativeName, symbol: ENV.nativeSymbol, decimals: 18 };
export const l1Chain = defineChain({ id: ENV.l1ChainId, name: ENV.l1Name, nativeCurrency: native, rpcUrls: { default: { http: [ENV.l1RpcUrl] } } });
export const l2Chain = defineChain({ id: ENV.l2ChainId, name: ENV.chainName, nativeCurrency: native, rpcUrls: { default: { http: [ENV.l2RpcUrl] } } });

export const l1 = createPublicClient({ chain: l1Chain, transport: http(ENV.l1RpcUrl, { timeout: 20_000, retryCount: 1 }) });
export const l2 = createPublicClient({ chain: l2Chain, transport: http(ENV.l2RpcUrl, { timeout: 20_000, retryCount: 1 }) });

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(join(ENV.l2Dir, file), "utf8"));
  } catch {
    return null;
  }
};

export const hostStatus = () => readJson("status/status.json") || { stage: "booting", detail: "The host is starting up" };
export const operatorAddresses = () => readJson("status/addresses.json") || {};

let deployment = null;
/** The rollup addresses and genesis, available once op-deployer has finished. */
export function getDeployment() {
  if (deployment) return deployment;
  const addresses = readJson("node/l1-addresses.json");
  const rollup = readJson("node/rollup.json");
  if (!addresses?.OptimismPortalProxy || !rollup?.genesis) return null;
  deployment = {
    portal: addresses.OptimismPortalProxy.toLowerCase(),
    factory: addresses.DisputeGameFactoryProxy.toLowerCase(),
    registry: addresses.AnchorStateRegistryProxy.toLowerCase(),
    systemConfig: addresses.SystemConfigProxy.toLowerCase(),
    l1StandardBridge: addresses.L1StandardBridgeProxy.toLowerCase(),
    l1Messenger: addresses.L1CrossDomainMessengerProxy.toLowerCase(),
    genesisTime: BigInt(rollup.genesis.l2_time),
    genesisL1Block: Number(rollup.genesis.l1.number),
    blockTime: BigInt(rollup.block_time || ENV.blockTime),
  };
  return deployment;
}

export async function syncStatus() {
  const res = await fetch(ENV.opNodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "optimism_syncStatus", params: [] }),
    signal: AbortSignal.timeout(5000),
  });
  const { result } = await res.json();
  if (!result) return null;
  return {
    l1Head: result.head_l1.number,
    unsafe: result.unsafe_l2.number,
    safe: result.safe_l2.number,
    finalized: result.finalized_l2.number,
  };
}

/** Protocol timings read from the deployed contracts; cached since they never change. */
let timings = null;
export async function getTimings() {
  const dep = getDeployment();
  if (!dep) return null;
  if (timings) return timings;
  const [maturity, finality] = await Promise.all([
    l1.readContract({ address: dep.portal, abi: portalAbi, functionName: "proofMaturityDelaySeconds" }),
    l1.readContract({ address: dep.registry, abi: registryAbi, functionName: "disputeGameFinalityDelaySeconds" }),
  ]);
  timings = { proofMaturityDelay: Number(maturity), finalityDelay: Number(finality), proposalInterval: ENV.proposalInterval };
  return timings;
}

/** The newest dispute game, whose super root covers every L2 timestamp up to its sequence number. */
export async function latestGame() {
  const dep = getDeployment();
  if (!dep) return null;
  const count = await l1.readContract({ address: dep.factory, abi: factoryAbi, functionName: "gameCount" });
  if (count === 0n) return null;
  const index = count - 1n;
  const [gameType, timestamp, proxy] = await l1.readContract({ address: dep.factory, abi: factoryAbi, functionName: "gameAtIndex", args: [index] });
  const seq = await l1.readContract({ address: proxy, abi: gameAbi, functionName: "l2SequenceNumber" });
  return { index, gameType, createdAt: Number(timestamp), proxy, l2Timestamp: seq };
}
