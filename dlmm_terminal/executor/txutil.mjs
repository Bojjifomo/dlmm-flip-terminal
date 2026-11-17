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
export async function withLock(name, fn) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, name.replace(/[^A-Za-z0-9_.-]/g, "_") + ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, t: Date.now() }), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let held = {};
      try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (held.pid && held.pid !== process.pid && alive(held.pid) && Date.now() - (held.t || 0) < STALE_MS) {
        throw Object.assign(new Error(`lagi diproses proses lain (pid ${held.pid}): tunggu sebentar lalu coba lagi`), { busy: true });
      }
      try { fs.unlinkSync(file); } catch {}                  // stale: its process is gone
      if (attempt === 1) throw Object.assign(new Error("lock file kepake"), { busy: true });
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
export async function tokenHoldings(connection, owner, mint) {
  const spl = require("@solana/spl-token");
  const mintPk = new PublicKey(mint);
  let total = 0n, decimals = 0, program = null;
  const accounts = [];
  for (const programId of TOKEN_PROGRAMS) {
    const r = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk, programId: new PublicKey(programId) });
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      decimals = info.tokenAmount.decimals;
      program = programId;
      total += amount;
      accounts.push({ address: a.pubkey, amount, frozen: info.state === "frozen" });
    }
  }
  if (!program) return { total: 0n, ata: 0n, ataAddress: null, program: null, decimals, others: [] };
  const ataAddress = spl.getAssociatedTokenAddressSync(mintPk, owner, true, new PublicKey(program));
  let ata = 0n;
  const others = [];
  for (const a of accounts) {
    if (a.address.equals(ataAddress)) ata = a.frozen ? 0n : a.amount;
    else if (a.amount > 0n) others.push(a);
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
