import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ENV } from "./config.js";

export const db = new DatabaseSync(join(ENV.dataDir, "bridge.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS withdrawals (
    hash TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    sender TEXT NOT NULL,
    target TEXT NOT NULL,
    value TEXT NOT NULL,
    gas_limit TEXT NOT NULL,
    data TEXT NOT NULL,
    l2_block INTEGER NOT NULL,
    l2_time INTEGER NOT NULL,
    l2_tx TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting-proposal',
    proven_by TEXT,
    proven_at INTEGER,
    ready_at INTEGER,
    prove_tx TEXT,
    finalize_tx TEXT,
    error TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS withdrawals_sender ON withdrawals (sender);
  CREATE INDEX IF NOT EXISTS withdrawals_target ON withdrawals (target);
  CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals (status);
`);

export function getMeta(key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function insertWithdrawal(w) {
  db.prepare(
    `INSERT OR IGNORE INTO withdrawals (hash, nonce, sender, target, value, gas_limit, data, l2_block, l2_time, l2_tx, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(w.hash, w.nonce, w.sender, w.target, w.value, w.gasLimit, w.data, w.l2Block, w.l2Time, w.l2Tx, Math.floor(Date.now() / 1000));
}

export function updateWithdrawal(hash, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE withdrawals SET ${sets}, updated_at = ? WHERE hash = ?`).run(
    ...keys.map((k) => fields[k] ?? null),
    Math.floor(Date.now() / 1000),
    hash
  );
}

const shape = (row) =>
  row && {
    hash: row.hash,
    tx: { nonce: row.nonce, sender: row.sender, target: row.target, value: row.value, gasLimit: row.gas_limit, data: row.data },
    l2Block: row.l2_block,
    l2Time: row.l2_time,
    l2Tx: row.l2_tx,
    status: row.status,
    provenBy: row.proven_by,
    provenAt: row.proven_at,
    readyAt: row.ready_at,
    proveTx: row.prove_tx,
    finalizeTx: row.finalize_tx,
    error: row.error,
  };

export const getWithdrawal = (hash) => shape(db.prepare("SELECT * FROM withdrawals WHERE hash = ?").get(hash));

export const withdrawalsFor = (address) =>
  db
    .prepare("SELECT * FROM withdrawals WHERE sender = ? OR target = ? ORDER BY l2_block DESC LIMIT 100")
    .all(address, address)
    .map(shape);

export const openWithdrawals = () => db.prepare("SELECT * FROM withdrawals WHERE status != 'finalized' ORDER BY l2_block ASC LIMIT 200").all().map(shape);

export const withdrawalCounts = () =>
  Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM withdrawals GROUP BY status").all().map((r) => [r.status, Number(r.n)]));
