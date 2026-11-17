// node dlmm_terminal/executor/test_txutil.mjs — send / lock / balance helpers, against a fake connection (no RPC).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sendLegacy, confirmOrCheck, withLock, tokenHoldings } from "./txutil.mjs";

const require = createRequire(import.meta.url);
const { Keypair, SystemProgram, Transaction, PublicKey } = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const payer = Keypair.generate();
const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));

function fake({ confirm = [], status = [], height = 0, sim = null } = {}) {
  let sent = 0, c = 0, s = 0;
  return {
    sentCount: () => sent,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: sim, logs: [] } }),
    sendRawTransaction: async () => `sig${++sent}`,
    confirmTransaction: async () => { const f = confirm[c++]; return f ? f() : { value: { err: null } }; },
    getSignatureStatuses: async () => ({ value: [status[s++] ?? null] }),
    getBlockHeight: async () => height,
  };
}

// 1. a confirmation that times out but the tx landed: no second send
{
  const conn = fake({ confirm: [() => Promise.reject(new Error("Transaction was not confirmed in 30.00 seconds"))],
    status: [{ err: null, confirmationStatus: "confirmed" }] });
  assert.equal(await sendLegacy(conn, tx(), [payer]), "sig1");
  assert.equal(conn.sentCount(), 1, "landed tx is not sent again");
}
// 2. expired (block height exceeded) and not on chain: sent again with a fresh blockhash
{
  const conn = fake({ confirm: [() => Promise.reject(new Error("Signature sig1 has expired: block height exceeded."))], height: 200 });
  assert.equal(await sendLegacy(conn, tx(), [payer]), "sig2");
  assert.equal(conn.sentCount(), 2);
}
// 3. timed out, not found, blockhash still valid: unknown outcome -> no resend, error says so
{
  const conn = fake({ confirm: [() => Promise.reject(new Error("timed out"))], height: 50 });
  await assert.rejects(sendLegacy(conn, tx(), [payer]), /not confirmed/);
  assert.equal(conn.sentCount(), 1, "never resend while the first may still land");
}
// 4. simulation error: nothing sent
{
  const conn = fake({ sim: { InstructionError: [3, { Custom: 1 }] } });
  await assert.rejects(sendLegacy(conn, tx(), [payer]), /simulation failed/);
  assert.equal(conn.sentCount(), 0);
}
// 5. failed on chain is final
{
  const conn = fake({ confirm: [() => Promise.resolve({ value: { err: { InstructionError: [0, "x"] } } })] });
  await assert.rejects(confirmOrCheck(conn, "s", "b", 100), /failed on chain/);
}

// 6. lock: a second holder is refused while the first runs, free again afterwards
{
  const name = `test-${process.pid}`;
  let inner = null;
  await withLock(name, async () => {
    // a live other process holds it: simulate by writing the parent's pid
    const file = fileURLToPath(new URL(`../data/locks/${name}-2.lock`, import.meta.url));
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, t: Date.now() }));
    await assert.rejects(withLock(`${name}-2`, async () => 1), e => e.busy === true);
    fs.unlinkSync(file);
    inner = await withLock(`${name}-2`, async () => "ran");
  });
  assert.equal(inner, "ran");
  // stale lock of a dead process is taken over
  const stale = fileURLToPath(new URL(`../data/locks/${name}-3.lock`, import.meta.url));
  fs.writeFileSync(stale, JSON.stringify({ pid: 999999999, t: Date.now() }));
  assert.equal(await withLock(`${name}-3`, async () => "ok"), "ok");
  assert.ok(!fs.existsSync(stale));
}

// 7. holdings: only the associated account counts as spendable
{
  const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const ata = spl.getAssociatedTokenAddressSync(mint, owner, true, T22);
  const other = Keypair.generate().publicKey;
  const acc = (pubkey, amount) => ({ pubkey, account: { data: { parsed: { info: { state: "initialized", tokenAmount: { amount: String(amount), decimals: 6 } } } } } });
  const conn = { getParsedTokenAccountsByOwner: async (_o, f) => ({ value: f.programId.equals(T22) ? [acc(ata, 500), acc(other, 1500)] : [] }) };
  const h = await tokenHoldings(conn, owner, mint.toBase58());
  assert.equal(h.total, 2000n);
  assert.equal(h.ata, 500n, "half the token sits outside the associated account");
  assert.equal(h.others.length, 1);
  assert.equal(h.program, T22.toBase58());
}
console.log("txutil tests ok");
