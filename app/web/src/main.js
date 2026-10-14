import { createWalletClient, custom, formatEther, parseAbi, parseEther } from "viem";

const portalAbi = parseAbi([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
  "function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _disputeGameIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)",
  "function finalizeWithdrawalTransactionExternalProof((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, address _proofSubmitter)",
]);
const passerAbi = parseAbi(["function initiateWithdrawal(address _target, uint256 _gasLimit, bytes _data) payable"]);

const $ = (id) => document.getElementById(id);
const api = async (path) => {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let config;
let account = null;
let wallet = null;

const fmt = (wei, digits = 6) => {
  const [whole, frac = ""] = formatEther(BigInt(wei || 0)).split(".");
  const cut = frac.slice(0, digits).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
};
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const duration = (s) => {
  if (s <= 0) return "now";
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
};
const txLink = (explorer, hash) => (explorer ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>` : esc(short(hash)));

function toast(text, ms = 5000) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

const l2RpcUrl = () => config.l2.rpcUrl || `${location.origin}/rpc`;

function chainParams(which) {
  const c = which === "l1" ? config.l1 : config.l2;
  const rpcUrl = which === "l1" ? c.rpcUrl : l2RpcUrl();
  return {
    chainId: `0x${c.id.toString(16)}`,
    chainName: c.name,
    nativeCurrency: config.native,
    rpcUrls: rpcUrl ? [rpcUrl] : [],
    blockExplorerUrls: c.explorerUrl ? [c.explorerUrl] : undefined,
  };
}

async function ensureChain(which) {
  const want = which === "l1" ? config.l1.id : config.l2.id;
  const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (current === want) return;
  const params = chainParams(which);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
  } catch (error) {
    if (error.code !== 4902 || !params.rpcUrls.length) throw new Error(`Switch your wallet to ${params.chainName} and try again`);
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

async function waitReceipt(hash) {
  for (let i = 0; i < 180; i++) {
    const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function connect() {
  if (!window.ethereum) return toast("No browser wallet found. Install MetaMask or a similar wallet.");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = address;
  wallet = createWalletClient({ account, transport: custom(window.ethereum) });
  $("connect").textContent = short(address);
  window.ethereum.on?.("accountsChanged", (list) => {
    account = list[0] || null;
    wallet = account ? createWalletClient({ account, transport: custom(window.ethereum) }) : null;
    $("connect").textContent = account ? short(account) : "Connect wallet";
    refresh();
  });
  refresh();
}

async function refresh() {
  if (!account) return;
  const b = await api(`/api/balances?address=${account}`).catch(() => null);
  if (b) {
    $("dep-balance").textContent = b.l1 != null ? `Balance on ${config.l1.name}: ${fmt(b.l1)} ${config.native.symbol}` : "";
    $("wd-balance").textContent = b.l2 != null ? `Balance on ${config.l2.name}: ${fmt(b.l2)} ${config.native.symbol}` : "";
  }
  renderActivity();
}

const LABELS = {
  "waiting-proposal": ["Waiting for the next state proposal", "wait"],
  "ready-to-prove": ["Ready to prove", "go"],
  proven: ["Proven, in the withdrawal delay", "wait"],
  "ready-to-finalize": ["Ready to claim", "go"],
  finalized: ["Completed", "ok"],
};

async function renderActivity() {
  const box = $("activity");
  if (!account) return;
  const data = await api(`/api/withdrawals?address=${account}`).catch((e) => ({ error: e.message }));
  if (data.error) {
    box.innerHTML = `<p class="err">${esc(data.error)}</p>`;
    return;
  }
  if (!data.withdrawals.length) {
    box.innerHTML = `<p class="muted">No withdrawals from this wallet yet.</p>`;
    return;
  }
  box.innerHTML = "";
  for (const w of data.withdrawals) {
    const [label, tone] = LABELS[w.status] || [w.status, ""];
    let hint = "";
    if (w.status === "waiting-proposal" && config.timings) {
      hint = `Proposals are posted about every ${duration(config.timings.proposalInterval)}.`;
    } else if (w.status === "proven" && w.readyAt) {
      hint = `Claimable in ${duration(w.readyAt - data.now)}.`;
    } else if (config.relayer && (w.status === "ready-to-prove" || w.status === "ready-to-finalize")) {
      hint = "The relayer will do this automatically; you can also do it yourself.";
    }
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="row"><strong>${fmt(w.tx.value)} ${config.native.symbol}</strong><span class="pill ${tone}">${label}</span></div>
      <div class="row small muted"><span>L2 tx ${txLink(config.l2.explorerUrl, w.l2Tx)}</span><span>${new Date(w.l2Time * 1000).toLocaleString()}</span></div>
      ${hint ? `<div class="small muted">${hint}</div>` : ""}
      ${w.finalizeTx ? `<div class="small muted">Claimed in ${txLink(config.l1.explorerUrl, w.finalizeTx)}</div>` : ""}
      ${w.error && w.status !== "finalized" ? `<div class="err">${esc(w.error)}</div>` : ""}`;
    if (w.status === "ready-to-prove" || w.status === "ready-to-finalize") {
      const btn = document.createElement("button");
      btn.className = "btn primary small";
      btn.textContent = w.status === "ready-to-prove" ? "Prove" : "Claim";
      btn.onclick = () => (w.status === "ready-to-prove" ? prove(w, btn) : finalize(w, btn));
      el.appendChild(btn);
    }
    box.appendChild(el);
  }
}

async function run(btn, label, action) {
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await action();
  } catch (error) {
    toast(error.shortMessage || error.message || String(error), 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = text;
    refresh();
  }
}

const parseAmount = (id) => {
  const value = parseEther($(id).value.trim() || "0");
  if (value <= 0n) throw new Error("Enter an amount");
  return value;
};

async function deposit() {
  if (!account) return connect();
  await run($("dep-send"), "Confirm in wallet…", async () => {
    const value = parseAmount("dep-amount");
    await ensureChain("l1");
    const hash = await wallet.writeContract({
      chain: null,
      address: config.contracts.optimismPortal,
      abi: portalAbi,
      functionName: "depositTransaction",
      args: [account, value, 100000n, false, "0x"],
      value,
    });
    toast("Deposit sent. Waiting for the parent chain to include it…", 10000);
    const receipt = await waitReceipt(hash);
    if (receipt?.status !== "0x1") throw new Error("The deposit transaction failed");
    $("dep-amount").value = "";
    toast(`Deposit confirmed on ${config.l1.name}. It will show on ${config.l2.name} in a few minutes.`, 10000);
  });
}

async function withdraw() {
  if (!account) return connect();
  await run($("wd-send"), "Confirm in wallet…", async () => {
    const value = parseAmount("wd-amount");
    await ensureChain("l2");
    const hash = await wallet.writeContract({
      chain: null,
      address: config.contracts.messagePasser,
      abi: passerAbi,
      functionName: "initiateWithdrawal",
      args: [account, 100000n, "0x"],
      value,
    });
    const receipt = await waitReceipt(hash);
    if (receipt?.status !== "0x1") throw new Error("The withdrawal transaction failed");
    $("wd-amount").value = "";
    toast("Withdrawal started. Track it under Withdrawals.", 8000);
    selectTab("activity");
  });
}

async function prove(w, btn) {
  await run(btn, "Preparing proof…", async () => {
    const args = await api(`/api/withdrawals/${w.hash}/prove`);
    await ensureChain("l1");
    btn.textContent = "Confirm in wallet…";
    const tx = { ...args.tx, nonce: BigInt(args.tx.nonce), value: BigInt(args.tx.value), gasLimit: BigInt(args.tx.gasLimit) };
    const hash = await wallet.writeContract({
      chain: null,
      address: args.portal,
      abi: portalAbi,
      functionName: "proveWithdrawalTransaction",
      args: [tx, BigInt(args.gameIndex), args.outputRootProof, args.withdrawalProof],
    });
    const receipt = await waitReceipt(hash);
    if (receipt?.status !== "0x1") throw new Error("The prove transaction failed");
    toast("Withdrawal proven. It can be claimed after the withdrawal delay.", 8000);
  });
}

async function finalize(w, btn) {
  await run(btn, "Confirm in wallet…", async () => {
    await ensureChain("l1");
    const tx = { ...w.tx, nonce: BigInt(w.tx.nonce), value: BigInt(w.tx.value), gasLimit: BigInt(w.tx.gasLimit) };
    const hash = await wallet.writeContract({
      chain: null,
      address: config.contracts.optimismPortal,
      abi: portalAbi,
      functionName: "finalizeWithdrawalTransactionExternalProof",
      args: [tx, w.provenBy],
    });
    const receipt = await waitReceipt(hash);
    if (receipt?.status !== "0x1") throw new Error("The claim transaction failed");
    toast(`Withdrawal claimed on ${config.l1.name}.`, 8000);
  });
}

function selectTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "activity") renderActivity();
}

function renderNetwork() {
  const facts = [
    ["Network", config.l2.name],
    ["Chain ID", config.l2.id],
    ["RPC", l2RpcUrl()],
    ["Explorer", config.l2.explorerUrl || "—"],
    ["Gas token", `${config.native.name} (${config.native.symbol})`],
    ["Parent chain", `${config.l1.name} (${config.l1.id})`],
    ["Block time", `${config.l2.blockTime}s`],
  ];
  if (config.timings) facts.push(["Withdrawal delay", duration(config.timings.proofMaturityDelay)]);
  if (config.contracts) facts.push(["Portal", config.contracts.optimismPortal], ["L1 bridge", config.contracts.l1StandardBridge]);
  $("network").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
}

async function init() {
  config = await api("/api/config");
  document.title = `${config.l2.name} Bridge`;
  $("chain-name").textContent = `${config.l2.name} Bridge`;
  for (const el of document.querySelectorAll(".sym")) el.textContent = config.native.symbol;
  $("dep-from").textContent = config.l1.name;
  $("dep-to").textContent = config.l2.name;
  $("wd-from").textContent = config.l2.name;
  $("wd-to").textContent = config.l1.name;
  if (config.timings) {
    $("wd-note").textContent = `Withdrawals take about ${duration(config.timings.proposalInterval)} to be proposed, then a ${duration(config.timings.proofMaturityDelay)} delay before they can be claimed on ${config.l1.name}.`;
  }
  if (!config.deployed) {
    const banner = $("banner");
    banner.hidden = false;
    banner.textContent = "This L2 is still being set up. The bridge opens once the rollup contracts are deployed.";
    $("dep-send").disabled = $("wd-send").disabled = true;
  }
  renderNetwork();
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => selectTab(b.dataset.tab);
  $("connect").onclick = connect;
  $("dep-send").onclick = deposit;
  $("wd-send").onclick = withdraw;
  $("add-l2").onclick = async () => {
    if (!window.ethereum) return toast("No browser wallet found.");
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [chainParams("l2")] }).catch((e) => toast(e.message));
  };
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (accounts[0]) connect();
  }
  setInterval(() => account && !document.hidden && refresh(), 15000);
}

init().catch((error) => toast(error.message, 15000));
