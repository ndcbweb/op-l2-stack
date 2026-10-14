import { existsSync } from "node:fs";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { getDeployment, getTimings, hostStatus, l1, l2, operatorAddresses, syncStatus } from "./chain.js";
import { ENV } from "./config.js";
import { getWithdrawal, withdrawalCounts, withdrawalsFor } from "./db.js";
import { buildProveArgs, relayer, startRelayer, state } from "./relayer.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const RPC_PREFIXES = ["eth_", "net_", "web3_"];

const app = Fastify({ trustProxy: "127.0.0.1", logger: { level: "info" }, disableRequestLogging: true, bodyLimit: 1024 * 1024 });
app.setReplySerializer((payload) => JSON.stringify(payload, (key, value) => (typeof value === "bigint" ? value.toString() : value)));

app.addHook("onSend", async (request, reply, payload) => {
  reply.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  return payload;
});

await app.register(rateLimit, {
  global: true,
  max: 900,
  timeWindow: "1 minute",
  allowList: (request) => request.url === "/api/health",
});

app.setErrorHandler((error, request, reply) => {
  if (error.name === "TimeoutError" || error.message === "fetch failed") {
    return reply.code(503).send({ ok: false, error: "The chain is not reachable right now" });
  }
  reply.code(error.statusCode || 500).send({ ok: false, error: error.shortMessage || error.message || "Request failed" });
});

const settle = (promise) => promise.then((v) => v, () => null);

async function balances(addresses) {
  const entries = await Promise.all(
    Object.entries(addresses)
      .filter(([role, address]) => ADDRESS.test(address || "") && role !== "owner" && role !== "sequencer")
      .map(async ([role, address]) => [role, { address, wei: await settle(l1.getBalance({ address })) }])
  );
  return Object.fromEntries(entries);
}

app.get("/api/health", async () => {
  const host = hostStatus();
  const sync = host.stage === "live" ? await settle(syncStatus()) : null;
  return {
    ok: host.stage === "live" && !!sync,
    stage: host.stage,
    detail: host.detail,
    needWei: host.needWei,
    deployed: !!getDeployment(),
    sync,
    relayer: { enabled: !!relayer, indexed: state.indexed, error: state.lastError || undefined },
  };
});

app.get("/api/status", async () => {
  const host = hostStatus();
  const dep = getDeployment();
  const addresses = operatorAddresses();
  const [sync, operators, timings, l2Head] = await Promise.all([
    host.stage === "live" ? settle(syncStatus()) : null,
    balances(addresses),
    dep ? settle(getTimings()) : null,
    host.stage === "live" ? settle(l2.getBlockNumber()) : null,
  ]);
  return {
    host,
    addresses,
    operators,
    sync,
    l2Head,
    timings,
    latestGame: state.game,
    withdrawals: withdrawalCounts(),
    contracts: dep && {
      optimismPortal: dep.portal,
      disputeGameFactory: dep.factory,
      anchorStateRegistry: dep.registry,
      systemConfig: dep.systemConfig,
      l1StandardBridge: dep.l1StandardBridge,
      l1CrossDomainMessenger: dep.l1Messenger,
    },
    relayer: { enabled: !!relayer, address: relayer?.account.address, error: state.lastError || undefined },
  };
});

app.get("/api/config", async () => {
  const dep = getDeployment();
  return {
    l1: { id: ENV.l1ChainId, name: ENV.l1Name, rpcUrl: ENV.l1PublicRpcUrl, explorerUrl: ENV.l1ExplorerUrl },
    l2: { id: ENV.l2ChainId, name: ENV.chainName, rpcUrl: ENV.l2PublicRpcUrl, explorerUrl: ENV.l2ExplorerUrl, blockTime: ENV.blockTime },
    native: { symbol: ENV.nativeSymbol, name: ENV.nativeName, decimals: 18 },
    deployed: !!dep,
    contracts: dep && { optimismPortal: dep.portal, l1StandardBridge: dep.l1StandardBridge, messagePasser: "0x4200000000000000000000000000000000000016" },
    timings: dep ? await settle(getTimings()) : null,
    relayer: !!relayer,
  };
});

app.get("/api/balances", async (request, reply) => {
  const address = String(request.query.address || "");
  if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: "address must be a 0x address" });
  const [onL1, onL2] = await Promise.all([settle(l1.getBalance({ address })), settle(l2.getBalance({ address }))]);
  return { l1: onL1, l2: onL2 };
});

app.get("/api/withdrawals", async (request, reply) => {
  const address = String(request.query.address || "").toLowerCase();
  if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: "address must be a 0x address" });
  return { withdrawals: withdrawalsFor(address), latestGame: state.game, now: Math.floor(Date.now() / 1000) };
});

app.get("/api/withdrawals/:hash", async (request, reply) => {
  const w = HASH.test(request.params.hash) ? getWithdrawal(request.params.hash.toLowerCase()) : null;
  if (!w) return reply.code(404).send({ ok: false, error: "Unknown withdrawal (it may not be indexed yet)" });
  return { withdrawal: w };
});

app.get("/api/withdrawals/:hash/prove", async (request, reply) => {
  const w = HASH.test(request.params.hash) ? getWithdrawal(request.params.hash.toLowerCase()) : null;
  if (!w) return reply.code(404).send({ ok: false, error: "Unknown withdrawal (it may not be indexed yet)" });
  return buildProveArgs(w);
});

/** Public L2 JSON-RPC for wallets and the bridge site; only the eth/net/web3 namespaces pass through. */
app.post("/rpc", async (request, reply) => {
  const body = request.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 50 || calls.some((c) => !c || typeof c.method !== "string" || !RPC_PREFIXES.some((p) => c.method.startsWith(p)))) {
    return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } });
  }
  const res = await fetch(ENV.l2RpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  reply.code(res.status).header("content-type", "application/json");
  return reply.send(await res.text());
});

if (existsSync(ENV.webDir)) {
  await app.register(fastifyStatic, { root: ENV.webDir, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
    reply.code(404).send({ ok: false, error: "Not found" });
  });
}

startRelayer(app.log);
await app.listen({ host: "0.0.0.0", port: ENV.port });
