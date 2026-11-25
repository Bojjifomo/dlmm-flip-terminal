// Close ladder positions of one pool, sell the token that came out back to SOL, and (re-entry) open the
// same ladder again at the current price. Works whether the price ran away above the ladder (all SOL)
// or has come into it (SOL + token): the token is simply whatever the wallet got on top of the SOL.
//
//   node reenter.mjs --pool P --positions A,B,C [--reopen --slices 5 --bottom 70 --top 0 --strategy spot]
//        [--sol N]            re-open with N SOL instead of everything that came back
//        [--maxloss 5]        refuse to sell the token if the swap pays more than this % under the pool price
//        [--dry-run --owner PK]   read positions, quote the sale, print the plan; sends nothing
//
// Without --reopen it is "close and swap to SOL". One JSON line on stdout. Needs the trading key (not --dry-run).
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadSigner } from "./keys.mjs";
import { tradeConnection, rpcStats, noteTx } from "./rpc.mjs";
import { sellToSol } from "./swap.mjs";
import { tokenHoldings } from "./txutil.mjs";
import { progress } from "./progress.mjs";
import { guardMain } from "./txutil.mjs";

const require = createRequire(import.meta.url);
const DLMMmod = require("@meteora-ag/dlmm");
const { PublicKey, VersionedTransaction } = require("@solana/web3.js");
const DLMM = DLMMmod.default ?? DLMMmod;
const here = path.dirname(fileURLToPath(import.meta.url));
const WSOL = "So11111111111111111111111111111111111111112";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes(`--${n}`);
const out = o => process.stdout.write(JSON.stringify({ ...o, rpc: rpcStats() }, (k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
const fail = (error, extra) => { out({ ok: false, error, ...(extra || {}) }); process.exit(1); };
guardMain(out);
const lastJson = s => { const l = s.trim().split("\n").reverse().find(x => x.startsWith("{")); return l ? JSON.parse(l) : null; };
function child(script, args) {
  // stderr passes through, so the child's "@@" progress lines reach DLMM Web's activity panel too
  try { return lastJson(execFileSync("node", [path.join(here, script), ...args], { encoding: "utf8", maxBuffer: 1e8, env: process.env, stdio: ["ignore", "pipe", "inherit"] })); }
  catch (e) { return lastJson(String(e.stdout || "")) || { ok: false, error: String(e.stderr || e.message).slice(-300) }; }
}

// the same, without blocking: several closes run at once
function childAsync(script, args) {
  return new Promise(resolve => {
    let out = "";
    const p = spawn("node", [path.join(here, script), ...args], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", d => { out += d; });
    p.on("error", e => resolve({ ok: false, error: String(e.message || e).slice(0, 300) }));
    p.on("close", code => { let j = null; try { j = lastJson(out); } catch {} resolve(j || { ok: false, error: `close_position exit ${code}` }); });
  });
}

const pool = arg("pool"), positions = (arg("positions") || "").split(",").filter(Boolean);
const reopen = flag("reopen"), dry = flag("dry-run"), maxLoss = Number(arg("maxloss", "5"));
if (!pool || !positions.length) fail("usage: --pool P --positions A,B [--reopen --slices 5 --bottom 70] [--maxloss 5] [--dry-run --owner PK]");
let signer = null, owner;
if (dry) { if (!arg("owner")) fail("--owner PUBKEY is needed for --dry-run"); owner = new PublicKey(arg("owner")); }
else { try { signer = loadSigner(); } catch (e) { fail("trading key: " + e.message); } if (!signer) fail("no trading key: set DLMM_PRIVATE_KEY in .env"); owner = signer.publicKey; }

const connection = tradeConnection();
const dlmm = await DLMM.create(connection, new PublicKey(pool));
const lb = dlmm.lbPair;
const solIsX = lb.tokenXMint.toBase58() === WSOL;
if (!solIsX && lb.tokenYMint.toBase58() !== WSOL) fail("not a SOL pool");
const tokenMint = (solIsX ? lb.tokenYMint : lb.tokenXMint).toBase58();
const active = await dlmm.getActiveBin();

// where each position stands now. A slice that is already closed (by `monitor --mode auto`, by hand, by an earlier
// run; Meteora's data API keeps listing it for a while) is skipped instead of failing the whole exit.
const view = [], gone = [];
for (const p of positions) {
  if (!(await connection.getAccountInfo(new PublicKey(p), "confirmed"))) { gone.push(p); continue; }
  const pos = await dlmm.getPosition(new PublicKey(p));
  const d = pos.positionData;
  const tok = Number(solIsX ? d.totalYAmount : d.totalXAmount), solAmt = Number(solIsX ? d.totalXAmount : d.totalYAmount);
  view.push({ position: p, lo: d.lowerBinId, hi: d.upperBinId, inRange: d.lowerBinId <= active.binId && active.binId <= d.upperBinId,
    solLamports: solAmt, tokenRaw: tok, holdsToken: tok > 0 });
}

// owner index + a direct read of the associated account (the index can lag minutes behind a close)
const tokenBalance = async () => {
  const h = await tokenHoldings(connection, owner, tokenMint);
  return { raw: h.total, dec: h.decimals };
};

// SOL per whole token at the pool's active bin (pricePerToken is Y per X)
const poolPriceSol = () => { const p = Number(active.pricePerToken); return solIsX ? 1 / p : p; };

if (dry) {
  const held = view.reduce((a, v) => a + v.tokenRaw, 0);
  let sale = null;
  if (held > 0) {
    const { dec } = await tokenBalance();
    // `held` is in lamports of the mint's decimals only when the SDK reports raw amounts (it does)
    sale = { tokenRaw: held, ...(await sellToSol(tokenMint, String(Math.floor(held)), { connection, owner, maxLossPct: maxLoss, pool, dry: true })) };
  }
  out({ ok: true, mode: "dry-run", pool, activeId: active.binId, tokenMint, positions: view, ...(gone.length ? { alreadyClosed: gone } : {}), sale, reopen });
  process.exit(0);
}

const solBefore = await connection.getBalance(owner);
const tokBefore = await tokenBalance();
const closed = gone.map(p => ({ position: p, ok: true, alreadyClosed: true }));
progress(`close ${view.length} slice${view.length > 1 ? "s" : ""}${reopen ? " → jual token → buka lagi" : " → jual token"}`);
// Each slice is its own position (and lock), so up to DLMM_PARALLEL_SLICES of them close at once.
const PAR = Math.max(1, Number(process.env.DLMM_PARALLEL_SLICES || 3) || 1);
const tClose = Date.now();
const closeRes = new Array(view.length);
let nextClose = 0;
await Promise.all(Array.from({ length: Math.min(PAR, view.length) }, async () => {
  while (nextClose < view.length) {
    const ci = nextClose++, p = view[ci].position;
    progress(`close slice ${ci + 1}/${view.length} (${p.slice(0, 6)}…)`);
    const r = await childAsync("close_position.mjs", ["--pool", pool, "--position", p]);
    progress(r?.ok ? `✓ slice ${ci + 1}/${view.length} ditutup` : `✗ slice ${ci + 1}/${view.length} gagal ditutup: ${String(r?.error || "?").slice(0, 120)}`, { ok: !!r?.ok });
    closeRes[ci] = { position: p, ok: !!r?.ok, error: r?.error, tx: r?.rpc?.tx };
  }
}));
closed.push(...closeRes.map(({ tx, ...c }) => c));
for (const c of closeRes) for (const t of c.tx || []) noteTx(t);          // the closes' timings, in this run's log
progress(`close ${view.length} slice selesai dalam ${((Date.now() - tClose) / 1000).toFixed(0)}s`);
const badClose = closeRes.find(c => !c.ok);
if (badClose) { out({ ok: false, step: "close", error: `close ${badClose.position} failed: ${badClose.error || "?"}`, closed }); process.exit(1); }
// The token that came out. The RPC can answer with the balance from before the close for a few
// seconds, so wait until it moves (up to ~30 s) when the positions held some token; if it never
// shows, sell what the positions held, capped by what the wallet now holds.
const expected = BigInt(Math.floor(view.reduce((a, v) => a + (Number(v.tokenRaw) || 0), 0)));
progress("cek token hasil close di wallet…");
let tokAfter = await tokenBalance(), gained = tokAfter.raw - tokBefore.raw, waited = 0;
// Wait while the token is short of what the positions held, and ALSO when nothing shows at all although we did
// not expect any: the positions' own numbers can say 0 (price moved during the closes) while token came out
// (FIONA / SIDOOR, 23-24 Nov: "nggak ada token buat dijual" with the token sitting in the wallet).
while (((expected > 0n && gained * 100n < expected * 95n) || (expected === 0n && gained <= 0n && waited < 4)) && waited < 15) {
  await new Promise(r => setTimeout(r, 2000));
  waited++;
  tokAfter = await tokenBalance();
  gained = tokAfter.raw - tokBefore.raw;
}
let gainedNote = null;
if (gained <= 0n && expected > 0n && tokAfter.raw > 0n) {
  gained = tokAfter.raw < expected ? tokAfter.raw : expected;
  gainedNote = "balance did not move after the close; selling what the positions held";
}
// Slices closed elsewhere left their token in the wallet unsold (the monitor never sells): sell it now too, since
// this is "close + swap to SOL" for the whole ladder.
if (gone.length && tokAfter.raw > gained) {
  gained = tokAfter.raw;
  gainedNote = `${gone.length} slice already closed elsewhere; selling the token it left in the wallet too`;
}
let swap = null, swapError = null;
if (gained > 0n) {
  progress(`jual token ke SOL…`);
  // Jupiter, else straight into this pool; never more than --maxloss % under the pool price.
  const res = await sellToSol(tokenMint, gained.toString(), { connection, signer, owner, maxLossPct: maxLoss, pool });
  if (!res.ok) {
    swapError = `token NOT sold: ${res.error}. It stays in the wallet (Cleanup sells it later).`;
    // Close + swap only: that is the whole job, so it failed. Re-entry goes on with the SOL that
    // did come back: a token that will not sell must not stop the ladder from opening again.
    if (!reopen) {
      out({ ok: false, step: "swap", error: `positions closed, ${swapError}`, closed, swap: res, leftover: { mint: tokenMint, pool, raw: gained.toString() } });
      process.exit(1);
    }
    swap = { ok: false, error: res.error, tried: res.tried, leftover: { mint: tokenMint, pool, raw: gained.toString() } };
  } else {
    swap = { ok: true, signature: res.signature, via: res.via, tokenRaw: gained.toString(), sol: res.sol, underPct: res.underPct, note: gainedNote, waitedS: waited * 2 };
  }
}
// Then look again, whatever happened above (sold, or nothing seen to sell): token of a slice whose close the RPC
// reported late (Singularity 22 Nov: 11.7k landed after the sale began) or that no read saw in time is sold now.
// Only this ladder's token: what the wallet holds beyond what it held before the close.
if (swap === null || swap.ok) {
  for (let k = 0; k < 3; k++) {
    await new Promise(r => setTimeout(r, 4000));
    const extra = (await tokenBalance()).raw - tokBefore.raw;
    if (extra <= 0n) break;
    progress(`${swap ? "sisa token" : "token"} (${extra}) ${swap ? "telat masuk" : "kebaca sekarang"}: jual…`);
    const r2 = await sellToSol(tokenMint, extra.toString(), { connection, signer, owner, maxLossPct: maxLoss, pool });
    if (!r2.ok) {
      swapError = `${swap ? "sisa " : ""}token NOT sold: ${r2.error}. It stays in the wallet (Cleanup sells it later).`;
      if (!reopen && !swap) {
        out({ ok: false, step: "swap", error: `positions closed, ${swapError}`, closed, swap: r2, leftover: { mint: tokenMint, pool, raw: extra.toString() } });
        process.exit(1);
      }
      swap = { ...(swap || { ok: false }), leftover: { mint: tokenMint, pool, raw: extra.toString() } };
      break;
    }
    if (!swap) swap = { ok: true, signature: r2.signature, via: r2.via, tokenRaw: "0", sol: 0, note: "token seen only after the first read" };
    swap.sol = (Number(swap.sol) || 0) + (Number(r2.sol) || 0);
    swap.tokenRaw = (BigInt(swap.tokenRaw) + extra).toString();
    swap.extraSales = (swap.extraSales || 0) + 1;
  }
}
// What came back. The RPC can still show the balance from before the close / sale for a few
// seconds: wait (up to ~30 s) until it shows at least 90% of what the positions held in SOL plus
// what the sale paid, so the re-open is not refused (or made smaller) on a stale read.
const expectSol = view.reduce((a, v) => a + (Number(v.solLamports) || 0), 0) / 1e9 + (swap && swap.ok ? Number(swap.sol) || 0 : 0);
progress("nunggu SOL kebaca di wallet…");
let solAfter = await connection.getBalance(owner), balWait = 0;
while ((solAfter - solBefore) / 1e9 < expectSol * 0.9 && balWait < 15) {
  await new Promise(r => setTimeout(r, 2000));
  balWait++;
  solAfter = await connection.getBalance(owner);
}
const back = (solAfter - solBefore) / 1e9;                       // SOL + returned rent − fees
if (!reopen) { out({ ok: true, mode: "close-swap", closed, swap, solBack: back, tokenMint, expectedTokenRaw: expected.toString() }); process.exit(0); }

const rentBack = view.length * 0.0419;               // rent of the slices closed here (not ones closed earlier)
// Re-open with what THIS ladder held (its SOL + what its token sold for), never more: the wallet balance can
// also move because something else ran at the same time (another re-entry, an auto exit, a sale), and that SOL
// is not this ladder's. Fees and the old rent stay in the wallet. The balance only caps it from above.
const own = Math.min(back - rentBack, expectSol);
const ask = arg("sol") ? Number(arg("sol")) : Math.floor(own * 0.999 * 1000) / 1000;
if (!(ask >= 0.01)) { out({ ok: false, step: "reopen", error: `only ${back.toFixed(4)} SOL came back (expected ~${expectSol.toFixed(3)}, waited ${balWait * 2}s): too small to re-open. The SOL is in the wallet.${swapError ? " Also: " + swapError : ""}`, closed, swap, solBack: back }); process.exit(1); }
progress(`buka ladder lagi: ◎${ask} · ${arg("slices", "5")} slice sampai −${arg("bottom", "70")}%`);
const opened = child("open_ladder.mjs", ["--pool", pool, "--sol", String(ask), "--slices", arg("slices", "5"), "--bottom", arg("bottom", "70"),
  "--top", arg("top", "0"), "--strategy", arg("strategy", "spot")]);
for (const t of opened?.rpc?.tx || []) noteTx(t);
const landed = (opened?.results || []).filter(x => x && x.ok).length;
out({ ok: !!opened?.ok, mode: "reenter", closed, swap, swapError, solBack: back, ladderSol: +expectSol.toFixed(4), reopenSol: ask, opened, landedSlices: landed,
  ...(opened?.ok ? {} : { step: "reopen", error: (landed ? `re-opened ${landed} slice(s) only: ` : "re-open failed, the SOL is in the wallet: ") + (opened?.error || "?") }),
  ...(opened?.ok && swapError ? { warning: swapError } : {}) });
process.exit(opened?.ok ? 0 : 1);
