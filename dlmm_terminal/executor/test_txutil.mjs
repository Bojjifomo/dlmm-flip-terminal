process.env.DLMM_SENDER = "off";            // no network in tests; the Sender case turns it on itself
process.env.DLMM_REBROADCAST_MS = "300";
// node dlmm_terminal/executor/test_txutil.mjs — send / lock / balance helpers, against a fake connection (no RPC).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sendLegacy, landTx, applyFee, pickMicro, txConfig, senderUrl, SENDER_TIP_ACCOUNTS, withLock, tokenHoldings } from "./txutil.mjs";

const require = createRequire(import.meta.url);
const { Keypair, SystemProgram, Transaction, PublicKey, ComputeBudgetProgram } = require("@solana/web3.js");
const bs58 = (() => { const m = require("bs58"); return m.default ?? m; })();
const spl = require("@solana/spl-token");

const payer = Keypair.generate();
const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));

// statuses: one entry per getSignatureStatuses call (last one repeats); null = not seen yet
function fake({ statuses = [null], height = 0, sim = null, fee = 1000, sendFails = false, helius = true } = {}) {
  let c = 0;
  const sent = [], levels = [];
  return {
    sent, levels,
    rpcEndpoint: helius ? "https://mainnet.helius-rpc.com/?api-key=k" : "https://api.mainnet-beta.solana.com",
    sentCount: () => new Set(sent).size,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: sim, logs: [] } }),
    sendRawTransaction: async raw => { if (sendFails) throw new Error("rpc down"); sent.push(Buffer.from(raw).toString("base64")); return "x"; },
    getSignatureStatuses: async () => ({ value: [statuses[Math.min(c++, statuses.length - 1)]] }),
    getBlockHeight: async () => height,
    _rpcRequest: async (m, params) => { levels.push(params[0].options.priorityLevel); return { result: { priorityFeeEstimate: fee } }; },
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 0 }, { prioritizationFee: 7000 }],
  };
}
const OK = { err: null, confirmationStatus: "confirmed" };

// 1. lands after a few polls; meanwhile the same bytes are broadcast again (one signature)
{
  const conn = fake({ statuses: [null, null, null, null, OK] });
  const t = tx();
  const sig = await sendLegacy(conn, t, [payer]);
  assert.equal(sig, bs58.encode(t.signature));
  assert.ok(conn.sent.length >= 2, "re-broadcast while waiting");
  assert.equal(conn.sentCount(), 1, "always the same transaction");
}
// 2. expired and not on chain: sent again with a fresh blockhash, one priority level higher
{
  let n = 0;
  const conn = fake({ height: 200 });
  conn.getSignatureStatuses = async () => ({ value: [n++ > 8 ? OK : null] });
  const t = tx();
  await sendLegacy(conn, t, [payer]);
  assert.equal(conn.sentCount(), 2);
  assert.deepEqual(conn.levels.slice(0, 2), ["High", "VeryHigh"]);
}
// 3. no answer and the blockhash still valid: unknown outcome -> no resend, error says so
{
  const conn = fake({ height: 50 });
  const t = tx(); t.recentBlockhash = Keypair.generate().publicKey.toBase58(); t.feePayer = payer.publicKey; t.sign(payer);
  await assert.rejects(landTx(conn, t.serialize(), bs58.encode(t.signature), 100, { maxMs: 1200 }), e => /not confirmed/.test(e.message) && e.expired === false);
}
// 4. simulation error: nothing sent
{
  const conn = fake({ sim: { InstructionError: [3, { Custom: 1 }] } });
  await assert.rejects(sendLegacy(conn, tx(), [payer]), /simulation failed/);
  assert.equal(conn.sent.length, 0);
}
// 5. failed on chain is final (no resend)
{
  const conn = fake({ statuses: [{ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }] });
  await assert.rejects(sendLegacy(conn, tx(), [payer]), /failed on chain/);
  assert.equal(conn.sentCount(), 1);
}
// 5b. priority fee: the estimate, at least the floor, never more than the cap for the whole transaction
{
  const cfg = { ...txConfig(), minMicro: 50_000, maxFeeLamports: 1_000_000 };
  assert.equal(pickMicro(1_000, 200_000, cfg), 50_000, "floor");
  assert.equal(pickMicro(120_000, 200_000, cfg), 120_000, "estimate");
  assert.equal(pickMicro(50_000_000, 200_000, cfg), 5_000_000, "cap: 0.001 SOL / 200k CU");
  // a caller's fixed price is replaced, not stacked
  const t = tx(); t.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  t.recentBlockhash = Keypair.generate().publicKey.toBase58(); t.feePayer = payer.publicKey;
  const f = await applyFee(fake({ fee: 300_000 }), t, "High", cfg);
  const prices = t.instructions.filter(i => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].data.readBigUInt64LE(1), 300_000n);
  assert.equal(f.feeLamports, Math.ceil(300_000 * 200_000 / 1e6));
  // not Helius: the recent fees of the same accounts
  const g = await applyFee(fake({ helius: false }), t, "High", cfg);
  assert.equal(g.estimate, 7000);
}
// 5c. Helius Sender: a tip to one of its accounts, sent to Sender (swqos_only, the RPC's api key) AND the RPC;
//     the RPC refusing is fine while Sender took it
{
  process.env.DLMM_SENDER = "swqos";
  process.env.SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=abc";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ result: "s" }) }; };
  try {
    const conn = fake({ statuses: [null, OK], sendFails: true });
    const t = tx();
    await sendLegacy(conn, t, [payer]);
    const tip = t.instructions.find(i => i.programId.equals(SystemProgram.programId) && SENDER_TIP_ACCOUNTS.includes(i.keys[1].pubkey.toBase58()));
    assert.ok(tip, "tip transfer added");
    assert.ok(calls.length >= 1 && /sender\.helius-rpc\.com\/fast\?swqos_only=true&api-key=abc/.test(calls[0].url));
    assert.equal(calls[0].body.method, "sendTransaction");
    assert.equal(calls[0].body.params[1].encoding, "base64");
    assert.equal(senderUrl({ sender: "max" }), "https://sender.helius-rpc.com/fast?api-key=abc");
  } finally {
    globalThis.fetch = realFetch;
    process.env.DLMM_SENDER = "off";
    delete process.env.SOLANA_RPC_URL;
  }
}
// 5d. nobody takes the transaction at all: not sent -> safe to try again (transient), then a clear error
{
  const conn = fake({ sendFails: true });
  await assert.rejects(sendLegacy(conn, tx(), [payer], { tries: 2 }), /rpc down/);
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

// 6b. lock with waitMs: waits for the other holder to finish instead of refusing (22-23 Nov "lagi diproses proses lain")
{
  const name = `test-wait-${process.pid}`;
  const file = fileURLToPath(new URL(`../data/locks/${name}.lock`, import.meta.url));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, t: Date.now() }));
  setTimeout(() => fs.unlinkSync(file), 2500);                 // the other process finishes after 2.5 s
  const t0 = Date.now();
  assert.equal(await withLock(name, async () => "waited", { waitMs: 10000 }), "waited");
  assert.ok(Date.now() - t0 >= 2000);
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, t: Date.now() }));
  await assert.rejects(withLock(name, async () => 1, { waitMs: 2500 }), e => e.busy === true && /2 detik|3 detik/.test(e.message));
  fs.unlinkSync(file);
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
// 8. the owner index lags (SIDOOR 23 Nov): it lists nothing, the associated account read directly holds the token
{
  const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const TK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ata = spl.getAssociatedTokenAddressSync(mint, owner, true, TK);
  const mintData = Buffer.alloc(82); mintData[44] = 6;
  const accData = Buffer.alloc(165); accData.writeBigUInt64LE(79916192917n, 64); accData[108] = 1;
  const conn = {
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),                     // stale index: nothing
    getAccountInfo: async pk => pk.equals(mint) ? { owner: TK, data: mintData } : pk.equals(ata) ? { owner: TK, data: accData } : null,
  };
  const h = await tokenHoldings(conn, owner, mint.toBase58());
  assert.equal(h.total, 79916192917n);
  assert.equal(h.ata, 79916192917n);
  assert.equal(h.program, TK.toBase58());
  assert.equal(h.decimals, 6);
  // index and direct read agree: counted once
  const conn2 = { ...conn, getParsedTokenAccountsByOwner: async (_o, f) => ({ value: f.programId.equals(TK)
    ? [{ pubkey: ata, account: { data: { parsed: { info: { state: "initialized", tokenAmount: { amount: "79916192917", decimals: 6 } } } } } }] : [] }) };
  assert.equal((await tokenHoldings(conn2, owner, mint.toBase58())).total, 79916192917n);
}
// 9. an RPC that answers {mint, programId} by mint alone: the same account comes back for both programs
{
  const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const TK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ata = spl.getAssociatedTokenAddressSync(mint, owner, true, TK);
  const one = { pubkey: ata, account: { owner: TK, data: { parsed: { info: { mint: mint.toBase58(), state: "initialized", tokenAmount: { amount: "500", decimals: 6 } } } } } };
  const conn = { getParsedTokenAccountsByOwner: async () => ({ value: [one] }) };   // ignores programId
  const h = await tokenHoldings(conn, owner, mint.toBase58());
  assert.equal(h.total, 500n, "counted once");
  assert.equal(h.ata, 500n, "found as the associated account, not 'nothing held'");
  assert.equal(h.program, TK.toBase58());
}
console.log("txutil tests ok");
