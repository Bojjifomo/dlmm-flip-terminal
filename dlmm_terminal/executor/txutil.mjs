// Shared plumbing for every script that moves money:
//   sendLegacy()   simulate -> send -> confirm a legacy Transaction, with a fresh blockhash on every try. When the
//                  confirmation errors (block height exceeded, websocket timeout), the signature is looked up before
//                  anything is sent again: a transaction that did land is never sent twice, one that expired is.
//   confirmOrCheck()  the same check for a transaction someone else built (Jupiter's VersionedTransaction).
//   withLock()     one process at a time per token / per position (web button, auto exit thread, `monitor --mode auto`
//                  and Cleanup used to sell or close the same thing at once: "insufficient funds", "Position ... not found").
//   tokenHoldings()  what the wallet holds of a mint, and how much of it sits in the associated token account (the
//                  only account Jupiter and the DLMM swap take from).
//   landTx()       broadcast a signed transaction and keep re-broadcasting it every ~2 s while polling its status,
//                  until it lands or its blockhash expires (Nov 2026: getBlockHeight was half of all requests, i.e.
//                  transactions waited ~30-40 s in web3's passive confirm). Each one is timed (rpc.tx in the output).
//   priority fee   from Helius getPriorityFeeEstimate (else getRecentPrioritizationFees), capped per transaction;
//                  a resend after an expiry asks for the next level up.
//   Helius Sender  with a small tip, the same bytes also go to sender.helius-rpc.com (staked connections).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = require("@solana/web3.js");
const bs58 = (() => { const m = require("bs58"); return m.default ?? m; })();
import { noteTx, countCall } from "./rpc.mjs";
import { progress } from "./progress.mjs";

export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
export const TRANSIENT = /blockhash not found|block height exceeded|has expired|expired|timed? ?out|429|too many requests|fetch failed|ECONN|ETIMEDOUT|socket hang up|not confirmed|node is behind|503|502|504|service unavailable|rate limit/i;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const errText = e => String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 400);

// "landed" | "failed" | "missing"
export async function signatureState(connection, signature) {
  try {
    const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const row = st.value[0];
    if (!row) return "missing";
    if (row.err) return "failed";
    return row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized" ? "landed" : "missing";
  } catch {
    return "missing";
  }
}

/** Wait for `signature`; if the wait itself errors, ask the chain what happened. Returns the signature or throws
 *  (err.expired = the transaction is known not to have landed, so sending a new one is safe). */
export async function confirmOrCheck(connection, signature, blockhash, lastValidBlockHeight) {
  try {
    const c = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (c.value.err) throw Object.assign(new Error(`failed on chain: ${JSON.stringify(c.value.err)} (${signature})`), { onChain: true });
    return signature;
  } catch (e) {
    if (e.onChain) throw e;
    // the wait gave up: give the cluster a moment, then look the signature up
    for (let i = 0; i < 3; i++) {
      const s = await signatureState(connection, signature);
      if (s === "landed") return signature;
      if (s === "failed") throw Object.assign(new Error(`failed on chain (${signature})`), { onChain: true });
      await sleep(2000);
    }
    let height = 0;
    try { height = await connection.getBlockHeight("confirmed"); } catch {}
    const expired = !lastValidBlockHeight || height > lastValidBlockHeight;
    throw Object.assign(new Error(`not confirmed: ${errText(e)} (${signature})`), { expired, signature });
  }
}

/** Simulate + send + land a legacy Transaction, up to `tries` times with a fresh blockhash. The priority fee is set
 *  here (any setComputeUnitPrice the caller added is replaced) and, with Helius Sender on, a small tip is added. */
export async function sendLegacy(connection, tx, signers, { tries = 4, simulate = true, label = "" } = {}) {
  const cfg = txConfig();
  const payer = signers[0].publicKey;
  let last;
  for (let n = 0; n < tries; n++) {
    let sig = null;
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = payer;
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      const fee = await applyFee(connection, tx, n ? bump(cfg.level) : cfg.level, cfg);
      let useSender = cfg.sender !== "off" && cfg.tipLamports > 0;
      if (useSender) addTip(tx, payer, cfg.tipLamports);
      tx.signatures = [];
      tx.sign(...signers);
      let raw;
      try { raw = tx.serialize(); }
      catch (e) {
        if (!useSender || !/too large|encoding overruns/i.test(String(e.message))) throw e;
        dropTip(tx); useSender = false;                          // no room for the tip: plain RPC send
        tx.signatures = []; tx.sign(...signers); raw = tx.serialize();
      }
      if (simulate) {
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
          const logs = (sim.value.logs || []).filter(l => !/ invoke \[|success$|consumed /.test(l)).slice(-3).join(" | ");
          const err = new Error(`simulation failed: ${JSON.stringify(sim.value.err)}${logs ? " · " + logs : ""}`);
          if (/BlockhashNotFound/.test(err.message)) { last = err; await sleep(1000); continue; }
          throw Object.assign(err, { simulation: true });
        }
      }
      sig = bs58.encode(tx.signature);
      return await landTx(connection, raw, sig, lastValidBlockHeight,
        { sender: useSender, label, fee: { ...fee, tipLamports: useSender ? cfg.tipLamports : 0 }, attempt: n + 1 });
    } catch (e) {
      last = e;
      if (e.simulation || e.onChain) throw e;
      if (sig && e.sent !== false && !e.expired) throw e;    // sent, outcome unknown and not provably expired: do not resend
      if (!e.expired && !TRANSIENT.test(String(e.message || e))) throw e;
      if (e.expired) progress(`⟳ ${label || "tx"} expired sebelum masuk blok: kirim ulang dengan fee lebih tinggi`);
      await sleep(1000 * (n + 1));
    }
  }
  throw last;
}

// ---------- landing: priority fee, Helius Sender, re-broadcast, timing ----------
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
// Helius Sender's designated tip accounts (helius.dev/docs/sending-transactions/sender, Nov 2026)
export const SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD", "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF", "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey", "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];
const LEVELS = ["Medium", "High", "VeryHigh"];
const bump = level => LEVELS[Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1)] || "VeryHigh";
const envNum = (k, d) => { const v = process.env[k]; return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d; };

/** From config.json "tx" (DLMM Web passes it as env, see node.py tx_env). */
export function txConfig() {
  const sender = String(process.env.DLMM_SENDER || "swqos").toLowerCase();       // off | swqos | max
  const level = LEVELS.includes(process.env.DLMM_FEE_LEVEL) ? process.env.DLMM_FEE_LEVEL : "High";
  return {
    level,
    maxFeeLamports: envNum("DLMM_FEE_MAX_LAMPORTS", 1_000_000),                     // 0.001 SOL per transaction
    minMicro: envNum("DLMM_FEE_MIN_MICRO", 50_000),
    sender: ["off", "swqos", "max"].includes(sender) ? sender : "swqos",
    // Sender minimums: 0.000005 SOL with swqos_only, 0.001 SOL for all routes ("max")
    tipLamports: Math.max(envNum("DLMM_SENDER_TIP_LAMPORTS", sender === "max" ? 1_000_000 : 10_000), sender === "max" ? 1_000_000 : 5_000),
    rebroadcastMs: envNum("DLMM_REBROADCAST_MS", 2000),
  };
}

const isCb = (ix, op) => ix.programId.toBase58() === COMPUTE_BUDGET && ix.data[0] === op;
/** Compute units the transaction may use: its setComputeUnitLimit, else the runtime default. */
export function cuLimit(tx) {
  const ix = tx.instructions.find(i => isCb(i, 2));
  if (ix) return ix.data.readUInt32LE(1);
  return Math.min(1_400_000, 200_000 * Math.max(1, tx.instructions.filter(i => i.programId.toBase58() !== COMPUTE_BUDGET).length));
}

/** microlamports per CU for this transaction's writable accounts at `level`; null when nobody answers. */
export async function feeEstimate(connection, tx, level) {
  const msg = tx.compileMessage();
  const writable = msg.accountKeys.filter((k, i) => msg.isAccountWritable(i));
  if (/helius/i.test(connection.rpcEndpoint || "")) {
    try {
      const r = await connection._rpcRequest("getPriorityFeeEstimate",
        [{ accountKeys: writable.map(k => k.toBase58()), options: { priorityLevel: level } }]);
      const v = r && r.result && r.result.priorityFeeEstimate;
      if (Number.isFinite(v)) return Math.ceil(v);
    } catch {}
  }
  try {
    const rows = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    const fees = rows.map(r => r.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
    if (!fees.length) return 0;
    const q = { Medium: 0.5, High: 0.75, VeryHigh: 0.95 }[level] ?? 0.75;
    return fees[Math.min(fees.length - 1, Math.floor(q * fees.length))];
  } catch { return null; }
}

/** The price to pay: the estimate, at least minMicro, never more than maxFeeLamports for the whole transaction. */
export function pickMicro(estimate, limit, cfg) {
  const want = Math.max(cfg.minMicro, estimate ?? cfg.minMicro);
  const cap = Math.floor(cfg.maxFeeLamports * 1e6 / Math.max(limit, 1));
  return Math.max(1, Math.min(want, cap));
}

/** Replace any setComputeUnitPrice with the priced one. Returns {microLamports, feeLamports, level, estimate}. */
export async function applyFee(connection, tx, level, cfg = txConfig()) {
  tx.instructions = tx.instructions.filter(i => !isCb(i, 3) && !i.__tip);
  const estimate = await feeEstimate(connection, tx, level).catch(() => null);
  const limit = cuLimit(tx);
  const micro = pickMicro(estimate, limit, cfg);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  return { level, estimate, microLamports: micro, cuLimit: limit, feeLamports: Math.ceil(micro * limit / 1e6) };
}

function addTip(tx, payer, lamports) {
  const to = new PublicKey(SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)]);
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports });
  ix.__tip = true;
  tx.instructions.push(ix);
}
function dropTip(tx) { tx.instructions = tx.instructions.filter(i => !i.__tip); }

/** Helius Sender URL: swqos_only unless "max"; the api-key from SOLANA_RPC_URL lifts its 1 request/s keyless limit. */
export function senderUrl(cfg = txConfig()) {
  const q = [];
  if (cfg.sender !== "max") q.push("swqos_only=true");
  try {
    const key = new URL(process.env.SOLANA_RPC_URL || "").searchParams.get("api-key");
    if (key && /helius/i.test(process.env.SOLANA_RPC_URL)) q.push("api-key=" + encodeURIComponent(key));
  } catch {}
  return (process.env.DLMM_SENDER_URL || "https://sender.helius-rpc.com/fast") + (q.length ? "?" + q.join("&") : "");
}

async function senderSend(raw) {
  countCall("sender", "sendTransaction");
  const r = await fetch(senderUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "sendTransaction",
      params: [Buffer.from(raw).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`sender: ${r.status} ${(j.error && j.error.message) || ""}`.trim());
  return j.result;
}

/** Send `raw` to the RPC (and Sender) at once; resolves when at least one took it. */
async function broadcast(connection, raw, useSender) {
  const jobs = [connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })];
  if (useSender) jobs.push(senderSend(raw));
  const rs = await Promise.allSettled(jobs);
  const ok = rs.find(r => r.status === "fulfilled");
  if (!ok) throw rs[0].reason;
  return rs.map(r => (r.status === "rejected" ? String(r.reason && r.reason.message || r.reason).slice(0, 120) : null));
}

/** Broadcast and land. Polls the status every ~1 s, broadcasts the same bytes again every `rebroadcastMs` (the same
 *  signature: it can land once only), checks the block height every few polls. Returns the signature, or throws like
 *  confirmOrCheck (err.onChain / err.expired / err.signature; err.sent=false when no endpoint took it at all). */
export async function landTx(connection, raw, signature, lastValidBlockHeight, opts = {}) {
  const cfg = txConfig();
  const { sender = false, label = "", fee = null, attempt = 1, maxMs = 150_000 } = opts;
  const t0 = Date.now();
  let sends = 0, lastSend = 0, polls = 0, sendErrs = [];
  const row = (extra) => {
    const r = { label: label || "tx", sig: signature, ms: Date.now() - t0, sends, sender, attempt, ...(fee ? { microLamports: fee.microLamports, feeLamports: fee.feeLamports, tipLamports: fee.tipLamports || 0, level: fee.level } : {}), ...extra };
    noteTx(r);
    return r;
  };
  const send = async () => {
    sends++; lastSend = Date.now();
    try { sendErrs = await broadcast(connection, raw, sender); }
    catch (e) { if (sends === 1) throw Object.assign(e, { sent: false }); }
  };
  await send();
  const finish = (r, state) => {
    const fees = r.feeLamports != null ? ` · fee ◎${((r.feeLamports + (r.tipLamports || 0)) / 1e9).toFixed(6)}` : "";
    progress(`⏱ ${r.label} ${state} ${(r.ms / 1000).toFixed(1)}s · kirim ${r.sends}x${r.sender ? " (+Sender)" : ""}${fees}`, { ok: state === "masuk" });
  };
  for (;;) {
    await sleep(polls < 8 ? 700 : 1200);
    polls++;
    let st = null;
    try { st = (await connection.getSignatureStatuses([signature])).value[0]; } catch {}
    if (st && st.err) {
      finish(row({ ok: false, err: JSON.stringify(st.err).slice(0, 120) }), "gagal on-chain");
      throw Object.assign(new Error(`failed on chain: ${JSON.stringify(st.err)} (${signature})`), { onChain: true, signature });
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      finish(row({ ok: true }), "masuk");
      return signature;
    }
    if (polls % 4 === 0 || Date.now() - t0 > maxMs) {
      let height = 0;
      try { height = await connection.getBlockHeight("confirmed"); } catch {}
      const timeUp = Date.now() - t0 > maxMs;
      if ((lastValidBlockHeight && height > lastValidBlockHeight) || timeUp) {
        const s = await signatureState(connection, signature);           // one last look, with history
        if (s === "landed") { finish(row({ ok: true }), "masuk"); return signature; }
        if (s === "failed") { finish(row({ ok: false }), "gagal on-chain"); throw Object.assign(new Error(`failed on chain (${signature})`), { onChain: true, signature }); }
        const expired = !!(lastValidBlockHeight && height > lastValidBlockHeight);
        finish(row({ ok: false, expired }), expired ? "expired" : "belum kepastian");
        throw Object.assign(new Error(`not confirmed: ${expired ? "block height exceeded" : "timed out"}${sendErrs.some(Boolean) ? " · " + sendErrs.filter(Boolean).join(" · ") : ""} (${signature})`), { expired, signature });
      }
    }
    if (Date.now() - lastSend >= cfg.rebroadcastMs) await send();
  }
}

// ---------- locks ----------
const LOCK_DIR = fileURLToPath(new URL("../data/locks/", import.meta.url));
const STALE_MS = 15 * 60 * 1000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Run `fn` holding the lock `name`; when another live process holds it, throw (err.busy). */
// waitMs: how long to wait for another live holder to finish before giving up (0 = refuse at once). Waiting is safe
// because every holder re-reads the chain inside the lock (a close finds the position gone, a sale sees what is left).
export async function withLock(name, fn, { waitMs = 0, onWait = null } = {}) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, name.replace(/[^A-Za-z0-9_.-]/g, "_") + ".lock");
  const t0 = Date.now();
  let told = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, t: Date.now() }), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let held = {};
      try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (held.pid && held.pid !== process.pid && alive(held.pid) && Date.now() - (held.t || 0) < STALE_MS) {
        if (Date.now() - t0 < waitMs) {
          if (onWait && Date.now() - told > 30000) { told = Date.now(); try { onWait(held.pid, Math.round((Date.now() - t0) / 1000)); } catch {} }
          await sleep(2000);
          continue;
        }
        throw Object.assign(new Error(`lagi diproses proses lain (pid ${held.pid})${waitMs ? ` dan belum selesai setelah ${Math.round(waitMs / 1000)} detik` : ""}: tunggu sebentar lalu coba lagi`), { busy: true });
      }
      try { fs.unlinkSync(file); } catch {}                  // stale: its process is gone
      if (attempt >= 3) throw Object.assign(new Error("lock file kepake"), { busy: true });
    }
  }
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file); } catch {}
  };
  process.once("exit", release);
  try { return await fn(); } finally { release(); }
}

// ---------- token holdings ----------
/** {total, ata, ataAddress, program, decimals, others: [{address, amount, frozen}]} for `mint` in `owner`'s wallet. */
/** The wallet's associated token account for `mint`, read DIRECTLY by address (always current), with the token
 *  program taken from the mint itself. getTokenAccountsByOwner goes through the RPC's owner index, which can lag far
 *  behind (SIDOOR, 23 Nov: 79,916 tokens landed at 23:35 and the index said 0 until about 00:05, so five sales
 *  reported "nothing held"). Returns {amount, address, program, decimals, exists, frozen}. */
export async function directAta(connection, owner, mint) {
  const spl = require("@solana/spl-token");
  const mintPk = new PublicKey(mint);
  const mintAcc = await connection.getAccountInfo(mintPk, "confirmed");
  if (!mintAcc) return { amount: 0n, address: null, program: null, decimals: 0, exists: false, frozen: false };
  const program = mintAcc.owner.toBase58();
  const address = spl.getAssociatedTokenAddressSync(mintPk, owner, true, mintAcc.owner);
  const decimals = mintAcc.data[44];                                   // spl mint layout: decimals at byte 44
  const acc = await connection.getAccountInfo(address, "confirmed");
  if (!acc || acc.data.length < 109) return { amount: 0n, address, program, decimals, exists: !!acc, frozen: false };
  const amount = acc.data.readBigUInt64LE(64);                         // spl account layout: amount at byte 64
  const frozen = acc.data[108] === 2;                                  // state: 0 uninit, 1 initialized, 2 frozen
  return { amount, address, program, decimals, exists: true, frozen };
}

export async function tokenHoldings(connection, owner, mint) {
  const spl = require("@solana/spl-token");
  const mintPk = new PublicKey(mint);
  let decimals = 0;
  // Each account once, with its program from the account itself: some RPCs answer a {mint, programId} filter by
  // mint alone, so asking per program returned the same accounts twice (total doubled, and the associated account
  // was looked for under the wrong program -> "nothing held" while the wallet held the token).
  const byAddr = new Map();
  for (const programId of TOKEN_PROGRAMS) {
    const r = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk, programId: new PublicKey(programId) });
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      if (info.mint && info.mint !== mintPk.toBase58()) continue;
      decimals = info.tokenAmount.decimals;
      const prog = a.account.owner ? new PublicKey(a.account.owner).toBase58() : programId;
      byAddr.set(a.pubkey.toBase58(), { address: a.pubkey, amount: BigInt(info.tokenAmount.amount), frozen: info.state === "frozen", program: prog });
    }
  }
  const accounts = [...byAddr.values()];
  // the associated account read directly by address: the owner index above can be minutes behind
  const d = await directAta(connection, owner, mint).catch(() => null);
  const program = (d && d.program) || (accounts[0] && accounts[0].program) || null;
  if (!program) return { total: 0n, ata: 0n, ataAddress: null, program: null, decimals, others: [] };
  if (d && d.program) decimals = d.decimals || decimals;
  const ataAddress = spl.getAssociatedTokenAddressSync(mintPk, owner, true, new PublicKey(program));
  let ata = 0n, total = 0n, seenAta = false;
  const others = [];
  for (const a of accounts) {
    if (a.address.equals(ataAddress)) { seenAta = true; ata = a.frozen ? 0n : a.amount; total += a.amount; }
    else { total += a.amount; if (a.amount > 0n) others.push(a); }
  }
  if (d && d.address && d.address.equals(ataAddress) && d.exists) {        // trust the direct read for the ATA
    const idx = seenAta ? ata : 0n;
    const fresh = d.frozen ? 0n : d.amount;
    total += d.amount - (seenAta ? (accounts.find(a => a.address.equals(ataAddress)) || { amount: 0n }).amount : 0n);
    ata = fresh;
    void idx;
  }
  return { total, ata, ataAddress, program, decimals, others };
}

/** Move the token sitting in other (non-associated) accounts into the associated one, so a swap can spend all of it.
 *  Returns the signature, or null when there was nothing to move. */
export async function consolidateToAta(connection, signer, mint, holdings) {
  const movable = holdings.others.filter(a => !a.frozen && a.amount > 0n);
  if (!movable.length) return null;
  const spl = require("@solana/spl-token");
  const owner = signer.publicKey, mintPk = new PublicKey(mint), programId = new PublicKey(holdings.program);
  const tx = new Transaction().add(spl.createAssociatedTokenAccountIdempotentInstruction(owner, holdings.ataAddress, owner, mintPk, programId));
  for (const a of movable.slice(0, 8)) {
    tx.add(spl.createTransferCheckedInstruction(a.address, mintPk, holdings.ataAddress, owner, a.amount, holdings.decimals, [], programId));
    tx.add(spl.createCloseAccountInstruction(a.address, owner, owner, [], programId));
  }
  return sendLegacy(connection, tx, [signer]);
}

/** The one JSON line every script prints, also when it crashes: never a raw stack trace in the web page. */
export function guardMain(print) {
  const handler = e => {
    const msg = String((e && e.message) || e).split("\n").find(l => l.trim()) || "error";
    print({ ok: false, error: msg.replace(/^Error:\s*/, "").slice(0, 400) });
    process.exit(1);
  };
  process.on("uncaughtException", handler);
  process.on("unhandledRejection", handler);
}
