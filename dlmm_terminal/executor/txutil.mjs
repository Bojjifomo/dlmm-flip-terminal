// Shared plumbing for every script that moves money:
//   sendLegacy()   simulate -> send -> confirm a legacy Transaction, with a fresh blockhash on every try. When the
//                  confirmation errors (block height exceeded, websocket timeout), the signature is looked up before
//                  anything is sent again: a transaction that did land is never sent twice, one that expired is.
//   confirmOrCheck()  the same check for a transaction someone else built (Jupiter's VersionedTransaction).
//   withLock()     one process at a time per token / per position (web button, auto exit thread, `monitor --mode auto`
//                  and Cleanup used to sell or close the same thing at once: "insufficient funds", "Position ... not found").
//   tokenHoldings()  what the wallet holds of a mint, and how much of it sits in the associated token account (the
//                  only account Jupiter and the DLMM swap take from).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PublicKey, Transaction } = require("@solana/web3.js");

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

/** Simulate + send + confirm a legacy Transaction, up to `tries` times with a fresh blockhash. */
export async function sendLegacy(connection, tx, signers, { tries = 4, simulate = true } = {}) {
  const payer = signers[0].publicKey;
  let last;
  for (let n = 0; n < tries; n++) {
    let sig = null;
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = payer;
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.signatures = [];
      tx.sign(...signers);
      if (simulate) {
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
          const logs = (sim.value.logs || []).filter(l => !/ invoke \[|success$|consumed /.test(l)).slice(-3).join(" | ");
          const err = new Error(`simulation failed: ${JSON.stringify(sim.value.err)}${logs ? " · " + logs : ""}`);
          if (/BlockhashNotFound/.test(err.message)) { last = err; await sleep(1000); continue; }
          throw Object.assign(err, { simulation: true });
        }
      }
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      return await confirmOrCheck(connection, sig, blockhash, lastValidBlockHeight);
    } catch (e) {
      last = e;
      if (e.simulation || e.onChain) throw e;
      if (sig && !e.expired) throw e;                       // sent, outcome unknown and not provably expired: do not resend
      if (!e.expired && !TRANSIENT.test(String(e.message || e))) throw e;
      await sleep(1500 * (n + 1));
    }
  }
  throw last;
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
