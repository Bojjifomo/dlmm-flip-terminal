// Sell a token for SOL: Jupiter first, then straight into the token's Meteora DLMM SOL pool when
// Jupiter cannot be reached or has no route (rate limit, blocked network, a token it does not list yet).
// Both refuse a sale paying more than `maxLossPct` % under the fair price:
//   Jupiter: price impact it reports, and (when a pool is known) the pool's active price.
//   DLMM:    the pool's active price vs. what the swap quote returns.
// Used by reenter.mjs (Close+swap / Re-entry / auto exit) and cleanup.mjs.
import { progress } from "./progress.mjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DLMMmod = require("@meteora-ag/dlmm");
const { PublicKey, VersionedTransaction, ComputeBudgetProgram } = require("@solana/web3.js");
import { confirmOrCheck, sendLegacy, withLock, tokenHoldings, consolidateToAta } from "./txutil.mjs";
const BN = require("bn.js");
const DLMM = DLMMmod.default ?? DLMMmod;

export const WSOL = "So11111111111111111111111111111111111111112";
const DATAPI = "https://dlmm.datapi.meteora.ag";
const jupBase = () => (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
const jupHeaders = extra => ({ ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}), ...(extra || {}) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// JSON with the real reason when it fails ("HTTP 429: Rate limit exceeded"), retrying 429 / 5xx / network errors.
async function getJson(url, init, tries = 3) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch {}
      if (r.ok && j) return j;
      last = `HTTP ${r.status}: ${(j && (j.error || j.message || j.errorCode)) || text.slice(0, 120).replace(/\s+/g, " ")}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = String(e.cause?.code || e.message || e).slice(0, 120);
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(last || "no answer");
}

export async function jupQuote(mint, rawAmount, slippageBps = 300) {
  const q = await getJson(`${jupBase()}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${rawAmount}&slippageBps=${slippageBps}`, { headers: jupHeaders() });
  if (!q.outAmount) throw new Error("Jupiter: no route" + (q.error ? ` (${q.error})` : ""));
  return q;
}

// The token's deepest Meteora DLMM pool against SOL (either side), or null.
export async function bestDlmmPool(mint) {
  let best = null;
  for (const f of [`token_x=${mint} && token_y=${WSOL}`, `token_x=${WSOL} && token_y=${mint}`]) {
    try {
      const d = await getJson(`${DATAPI}/pools?filter_by=${encodeURIComponent(f)}&sort_by=tvl:desc&page_size=1`, {}, 2);
      const p = (d.data || [])[0];
      if (p && (!best || (p.tvl || 0) > (best.tvl || 0))) best = p;
    } catch {}
  }
  return best ? best.address : null;
}

// What the pool says the amount is worth in SOL right now, and its quote for selling it there.
async function dlmmQuote(connection, pool, mint, rawAmount) {
  const dlmm = await DLMM.create(connection, new PublicKey(pool));
  const x = dlmm.lbPair.tokenXMint.toBase58(), y = dlmm.lbPair.tokenYMint.toBase58();
  if (![x, y].includes(mint) || ![x, y].includes(WSOL)) throw new Error("pool is not TOKEN/SOL");
  const swapForY = x === mint;                              // selling X for Y when the token is X
  const binArrays = await dlmm.getBinArrayForSwap(swapForY, 8);
  const q = dlmm.swapQuote(new BN(String(rawAmount)), swapForY, new BN(300), binArrays, true);
  // fair: the active bin's price (Y per X, in lamports per lamport) times the amount
  const active = await dlmm.getActiveBin();
  const pricePerLamport = Number(active.price);              // Y lamports per X lamport
  const fairLamports = swapForY ? Number(rawAmount) * pricePerLamport : Number(rawAmount) / pricePerLamport;
  return { dlmm, q, swapForY, fairLamports };
}

// Guard numbers in SOL: how much the sale pays under the pool price.
const under = (gotLamports, fairLamports) => (fairLamports > 0 ? (1 - gotLamports / fairLamports) * 100 : 0);

// Pools to try for the DLMM sale: the hint (the pool of the position that was just closed), then the token's deepest ones.
export async function dlmmPools(mint, hint, n = 3) {
  const out = hint ? [hint] : [];
  for (const f of [`token_x=${mint} && token_y=${WSOL}`, `token_x=${WSOL} && token_y=${mint}`]) {
    try {
      const d = await getJson(`${DATAPI}/pools?filter_by=${encodeURIComponent(f)}&sort_by=tvl:desc&page_size=${n}`, {}, 2);
      for (const p of d.data || []) if ((p.tvl || 0) > 50 && !out.includes(p.address)) out.push(p.address);
    } catch {}
  }
  return out.slice(0, n + (hint ? 1 : 0));
}

// "Simulation failed ... custom program error: 0x1788 ... last log lines": one readable line, nothing cut that matters.
const clip = (t, n = 420) => String(t || "").replace(/\s+/g, " ").slice(0, n);
function simErr(sim) {
  const logs = (sim.value.logs || []).filter(l => !/ invoke \[|success$|consumed /.test(l)).slice(-3).map(l => l.replace(/^Program log: /, ""));
  return `${JSON.stringify(sim.value.err)}${logs.length ? " · " + logs.join(" | ") : ""}`;
}

/**
 * Sell `rawAmount` of `mint` for SOL, trying every way there is before giving up:
 *   1. Jupiter, best route            2. Jupiter without the exchange the first route used (a pool that refuses)
 *   3. Jupiter, direct routes only    4. the token's own Meteora DLMM pools, deepest first
 *   5. the same again in 2 and then 4 smaller pieces (a size that overflows one pool's math)
 * Every transaction is simulated first and only sent when the simulation is clean, so a failing route costs nothing;
 * each route refuses a price more than maxLossPct % under the pool price. The error of every route is kept, in full.
 * opts: {connection, signer (Keypair, null = dry run), owner (PublicKey), maxLossPct, pool (hint), dry, verify}
 *   dry + verify: also simulate the transaction (a dry run otherwise only quotes).
 * Returns {ok, via, sol, underPct, signature?, dryRun?, pieces?, tried: [...]} or {ok:false, error, tried, soldRaw?, soldSol?}.
 */
// Every real sale (not dry runs) goes to data/swaps.jsonl: what was tried, what landed, the exact error.
function logSale(row) {
  try {
    const dir = fileURLToPath(new URL("../data/", import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dir + "swaps.jsonl", JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {}
}

export async function sellToSol(mint, rawAmount, opts) {
  let res;
  if (opts.dry) res = await sellToSolInner(mint, rawAmount, opts);
  else {
    // One sale per token at a time: the web button, Cleanup, the auto exit retry and Close+swap used to sell the
    // same token at once, each from the balance it read at its start -> "insufficient funds" on the second half.
    try { res = await withLock(`sell-${mint}`, () => sellToSolInner(mint, rawAmount, opts)); }
    catch (e) { if (!e.busy) throw e; res = { ok: false, busy: true, error: e.message, tried: [] }; }
  }
  if (!opts.dry) logSale({ mint, raw: String(rawAmount), ok: res.ok, via: res.via, sol: res.sol, signature: res.signature, error: res.error, pieces: res.pieces, soldRaw: res.soldRaw, tried: res.tried });
  return res;
}

async function sellToSolInner(mint, rawAmount, opts) {
  const { connection, signer, owner, maxLossPct = 5, dry } = opts;
  const verify = !dry || opts.verify;
  const tried = [];
  const pools = await dlmmPools(mint, opts.pool || null);
  const raw = BigInt(rawAmount);

  // the pool price the sale is judged against: the first pool that quotes
  const fairOf = async amount => {
    for (const p of pools) { try { return (await dlmmQuote(connection, p, mint, amount)).fairLamports; } catch {} }
    return null;
  };

  // --- one Jupiter attempt: quote -> guard -> build -> simulate -> send
  async function jup(amount, extra, label) {
    const qs = `inputMint=${mint}&outputMint=${WSOL}&amount=${amount}&slippageBps=300${extra.excludeDexes ? "&excludeDexes=" + encodeURIComponent(extra.excludeDexes) : ""}${extra.onlyDirectRoutes ? "&onlyDirectRoutes=true" : ""}`;
    const q = await getJson(`${jupBase()}/quote?${qs}`, { headers: jupHeaders() });
    if (!q.outAmount) throw new Error("no route" + (q.error ? ` (${q.error})` : ""));
    const labels = [...new Set((q.routePlan || []).map(r => (r.swapInfo || {}).label).filter(Boolean))];
    const fair = await fairOf(amount);
    const u = fair ? under(Number(q.outAmount), fair) : Number(q.priceImpactPct || 0) * 100;
    if (u > maxLossPct) { const e = new Error(`pays ${u.toFixed(1)}% under the ${fair ? "pool price" : "market (price impact)"} (max ${maxLossPct}%) via ${labels.join("+")}`); e.guard = true; e.labels = labels; throw e; }
    const out = { ok: true, via: "jupiter" + (label ? " " + label : ""), pool: pools[0] || null, sol: Number(q.outAmount) / 1e9, underPct: u, labels };
    if (dry && !verify) return { ...out, dryRun: true };
    const sw = await getJson(`${jupBase()}/swap`, { method: "POST", headers: jupHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ quoteResponse: q, userPublicKey: owner.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } } }) }, 2);
    if (!sw.swapTransaction) { const e = new Error("swap build failed: " + clip(JSON.stringify(sw), 200)); e.labels = labels; throw e; }
    const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) { const e = new Error(`simulation failed via ${labels.join("+")}: ${simErr(sim)}`); e.labels = labels; throw e; }
    if (dry) return { ...out, dryRun: true, simulated: true };
    tx.sign([signer]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    try {
      // a confirmation that times out is looked up on chain before it counts as a failure (it often landed)
      await confirmOrCheck(connection, sig, tx.message.recentBlockhash, sw.lastValidBlockHeight || (await connection.getBlockHeight()) + 150);
    } catch (e) {
      const err = new Error(`${e.onChain ? "failed on chain" : e.expired ? "expired before landing (block height exceeded)" : "not confirmed"} via ${labels.join("+")} (${sig})`);
      err.labels = labels; err.sent = true; err.expired = !!e.expired;
      throw err;
    }
    return { ...out, signature: sig };
  }

  // --- one DLMM attempt on one pool
  async function dlmmSale(amount, pool) {
    const { dlmm, q, fairLamports } = await dlmmQuote(connection, pool, mint, amount);
    const got = Number(q.outAmount.toString()), u = under(got, fairLamports);
    if (q.consumedInAmount.lt(new BN(String(amount)))) throw new Error("the pool cannot take the whole amount");
    if (u > maxLossPct) throw new Error(`pays ${u.toFixed(1)}% under its own price (max ${maxLossPct}%)`);
    const out = { ok: true, via: "dlmm", pool, sol: got / 1e9, underPct: u };
    if (dry && !verify) return { ...out, dryRun: true };
    const tx = await dlmm.swap({ inToken: new PublicKey(mint), outToken: new PublicKey(WSOL), inAmount: new BN(String(amount)),
      minOutAmount: q.minOutAmount, lbPair: dlmm.pubkey, user: owner, binArraysPubkey: q.binArraysPubkey });
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`simulation failed: ${simErr(sim)}`);
    if (dry) return { ...out, dryRun: true, simulated: true };
    try {
      return { ...out, signature: await sendLegacy(connection, tx, [signer], { simulate: false }) };
    } catch (e) {
      throw Object.assign(new Error(clip(e.message || e)), { sent: !e.simulation });
    }
  }

  // --- all the ways to sell `amount`, in order; the first that works wins
  const balance = async () => (await tokenHoldings(connection, owner, mint)).ata;
  async function sellAll(amount, tag) {
    const errs = [];
    const note = (name, e) => errs.push(`${tag}${name}: ${clip(e.message || e)}`);
    const before = dry ? null : await balance();
    // A sent transaction that errored may still have landed: look at the balance before trying another route,
    // or the next route sells tokens that are no longer there ("insufficient funds").
    const landedAnyway = async e => {
      if (dry || !e.sent || before == null) return null;
      const gone = before - (await balance());
      return gone * 100n >= amount * 99n ? { ok: true, via: "?", sol: 0, note: "reported an error but landed" } : null;
    };
    const attempt = async (name, fn) => {
      progress(`jual ${tag}lewat ${name}…`);
      try { const res = await fn(); progress(`✓ kejual ${tag}lewat ${name}${res && res.sol ? ` · ◎${Number(res.sol).toFixed(4)}` : ""}`, { ok: true }); return { res }; }
      catch (e) { note(name, e); progress(`✗ ${tag}${name}: ${clip(e.message || e, 120)}`, { ok: false }); return { err: e, res: await landedAnyway(e) }; }
    };
    let r = await attempt("Jupiter", () => jup(amount, {}, ""));
    if (r.res) return r.res;
    const labels = r.err.labels || [];
    const noMarket = /not tradable|No routes found|no route/i.test(String(r.err.message));
    if (r.err.expired) { const r2 = await attempt("Jupiter kirim ulang", () => jup(amount, {}, "(kirim ulang)")); if (r2.res) return r2.res; }
    if (!noMarket && labels.length) {
      const r3 = await attempt(`Jupiter tanpa ${labels.join("+")}`, () => jup(amount, { excludeDexes: labels.join(",") }, `(tanpa ${labels.join("+")})`));
      if (r3.res) return r3.res;
    }
    if (!noMarket) { const r4 = await attempt("Jupiter rute langsung", () => jup(amount, { onlyDirectRoutes: true }, "(rute langsung)")); if (r4.res) return r4.res; }
    for (const p of pools) { const r5 = await attempt(`pool DLMM ${p.slice(0, 6)}…`, () => dlmmSale(amount, p)); if (r5.res) return r5.res; }
    tried.push(...errs);
    return null;
  }

  // What the swap can actually spend: the associated token account. Token sitting in another account of the same
  // mint (bought elsewhere, an old account) is moved into it first; the amount is capped by what is there.
  let spendable = raw;
  let startBal = null;
  if (!dry) {
    let h = await tokenHoldings(connection, owner, mint);
    if (h.others.length && h.ata < raw) {
      try { await consolidateToAta(connection, signer, mint, h); h = await tokenHoldings(connection, owner, mint); }
      catch (e) { tried.push(`gabung token account: ${clip(e.message || e, 160)}`); }
    }
    startBal = h.ata;
    if (startBal <= 0n) return { ok: true, raw: "0", note: "nothing held: already sold or moved", tried };
    if (startBal < spendable) spendable = startBal;
  }
  // sold so far, from the balance itself (a sale that errored but landed still counts, a double sale cannot happen)
  const soldSoFar = async () => {
    const now = await balance();
    const gone = startBal - now;
    return gone > spendable ? spendable : gone > 0n ? gone : 0n;
  };

  // 1) the whole amount
  const whole = await sellAll(spendable, "");
  if (whole) return { ...whole, raw: spendable.toString(), tried };
  if (!dry) {
    const gone = await soldSoFar();
    if (gone * 100n >= spendable * 99n) return { ok: true, via: "?", sol: 0, raw: spendable.toString(), note: "an attempt reported an error but landed", tried };
  }

  // 2) in smaller pieces (2, then 4): some pools' math refuses a big amount. Every piece is sized from what is still
  //    in the wallet right now, never from the number read at the start.
  if (!dry && spendable >= 8n) {
    for (const n of [2, 4]) {
      const part = spendable / BigInt(n);
      let soldSol = 0, last = null, vias = [];
      for (let i = 0; i < n; i++) {
        const done = await soldSoFar();
        const left = spendable - done;
        if (left <= 0n) break;
        const amt = i === n - 1 || left < part ? left : part;
        const r = await sellAll(amt, `${n} bagian #${i + 1}: `);
        if (!r) break;
        soldSol += r.sol; last = r; vias.push(r.via);
      }
      const soldRaw = await soldSoFar();
      if (soldRaw * 100n >= spendable * 99n) return { ok: true, via: [...new Set(vias)].join("+") || "?", pieces: n, sol: soldSol, underPct: last?.underPct, signature: last?.signature, raw: spendable.toString(), tried };
      if (soldRaw > 0n) return { ok: false, error: `sold ${soldRaw}/${spendable} in ${n} pieces (◎${soldSol.toFixed(4)}), the rest failed: ${tried.slice(-3).join(" · ")}`, soldRaw: String(soldRaw), soldSol, tried };
    }
  }
  return { ok: false, error: tried.join(" · ") || "no way to sell this token", tried };
}
