import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const env = process.env;
const clean = (value, fallback = "") => String(value ?? "").replace(/[\r\n]+/g, " ").trim() || fallback;
const key = (value) => {
  const text = clean(value);
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? text : "";
};

/** Parses Go-style durations ("30s", "1h", "15m") into seconds. */
function seconds(value, fallback) {
  const match = /^(\d+)(s|m|h)?$/.exec(clean(value));
  if (!match) return fallback;
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] || "s"];
}

export const ENV = {
  port: Number(env.PORT) || 4400,
  dataDir: resolve(clean(env.DATA_DIR, "./.data")),
  l2Dir: resolve(clean(env.L2_DIR, "/l2")),
  webDir: resolve(clean(env.WEB_DIR, "../web/dist")),

  l1RpcUrl: clean(env.L1_RPC_URL, "http://127.0.0.1:18545"),
  /** Shown to wallets; L1_RPC_URL may carry a private API key and never leaves the host. */
  l1PublicRpcUrl: clean(env.L1_PUBLIC_RPC_URL),
  l1ChainId: Number(env.L1_CHAIN_ID) || 0,
  l1Name: clean(env.L1_NAME, "Parent chain"),
  l1ExplorerUrl: clean(env.L1_EXPLORER_URL).replace(/\/+$/, ""),
  nativeSymbol: clean(env.NATIVE_SYMBOL, "ETH"),
  nativeName: clean(env.NATIVE_NAME, clean(env.NATIVE_SYMBOL, "Ether")),

  l2RpcUrl: clean(env.L2_RPC_URL, "http://127.0.0.1:8545"),
  opNodeUrl: clean(env.OP_NODE_URL, "http://127.0.0.1:9545"),
  l2ChainId: Number(env.L2_CHAIN_ID) || 0,
  chainName: clean(env.CHAIN_NAME, "L2 chain"),
  l2PublicRpcUrl: clean(env.L2_PUBLIC_RPC_URL),
  l2ExplorerUrl: clean(env.L2_EXPLORER_URL).replace(/\/+$/, ""),
  blockTime: Number(env.L2_BLOCK_TIME) || 2,
  proposalInterval: seconds(env.PROPOSAL_INTERVAL, 3600),

  relayerKey: key(env.RELAYER_KEY),
  pollMs: Math.max(2000, Number(env.POLL_MS) || 10_000),
  logChunk: Math.max(100, Number(env.LOG_CHUNK) || 5000),
};

if (!ENV.l1ChainId || !ENV.l2ChainId) throw new Error("L1_CHAIN_ID and L2_CHAIN_ID are required");
mkdirSync(ENV.dataDir, { recursive: true });
