// Bid-ask flip (mechanism from flip-bot/): one position that the price has run through is closed and opened again
// on the other side of the price, same width in bins, BidAsk shape, with what came out of it.
//
//   bid -> ask   SOL-only below the price, the price fell through it: it is (almost) all token now.
//                Close it, open the token as a token-only BidAsk range ABOVE the price (sell higher, heavier at the top).
//   ask -> bid   token-only above the price, the price ran through it: it is (almost) all SOL now.
//                Close it, open the SOL as a SOL-only BidAsk range BELOW the price (buy lower, heavier at the bottom).
//
//   node flip.mjs --pool P --position X --to ask|bid [--gap 1] [--slippage 1] [--reserve 0.05] [--force]
//        [--dry-run --owner PK]     read + plan, send nothing
//
// "Above / below the price" is in bins: a token that is mint X sits above the active bin, mint Y below it, so the
// same rule works whichever side SOL is on. The flip refuses (notReady) while the position has not been run through
// on chain (Meteora's API can lag a few minutes), unless --force. One JSON line on stdout.
import { createRequire } from "node:module";
import { loadSigner } from "./keys.mjs";
import { tradeConnection, rpcStats } from "./rpc.mjs";
import { sendLegacy, withLock, tokenHoldings, guardMain, sleep } from "./txutil.mjs";

const require = createRequire(import.meta.url);
const DLMMmod = require("@meteora-ag/dlmm");
const { Keypair, PublicKey, ComputeBudgetProgram } = require("@solana/web3.js");
const BN = require("bn.js");
const DLMM = DLMMmod.default ?? DLMMmod;
const { StrategyType } = DLMMmod;

const WSOL = "So11111111111111111111111111111111111111112";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes(`--${n}`);
const out = o => process.stdout.write(JSON.stringify({ ...o, rpc: rpcStats() }, (k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
const fail = (error, extra) => { out({ ok: false, error, ...(extra || {}) }); process.exit(1); };

// ---- pure plan (exported for the tests) ----
const BINS_PER_POSITION = 70;
/** Bins of the new range. tokenIsX: the token is mint X (lives above the active bin). */
export function flipRange({ to, activeId, width, gap = 1, tokenIsX }) {
  const g = Math.max(1, Math.floor(gap));
  // which side of the price the deposit goes on: token-only (ask) on the token's side, SOL-only (bid) on SOL's side
  const above = to === "ask" ? tokenIsX : !tokenIsX;
  return above ? { lo: activeId + g, hi: activeId + g + width - 1 } : { lo: activeId - g - width + 1, hi: activeId - g };
}
/** Has the price run through the position, on chain? (bid: the active bin is past it on the token's side.) */
export function crossed({ from, activeId, lo, hi, tokenIsX }) {
  // the token's side of a range is where the price has to go for a SOL-only range to fill with token
  const pastTokenSide = tokenIsX ? activeId < lo : activeId > hi;   // SOL-only range filled: price went the token way
  const pastSolSide = tokenIsX ? activeId > hi : activeId < lo;
  return from === "bid" ? pastTokenSide : pastSolSide;
}
export const rentLamports = width => Math.round(0.0419e9 + Math.max(0, width - BINS_PER_POSITION) * 0.0006e9);

if (process.argv[1] && /(^|[\\/])flip\.mjs$/.test(process.argv[1])) await main();

async function main() {
  guardMain(out);
  const pool = arg("pool"), positionAddr = arg("position"), to = arg("to");
  const dry = flag("dry-run"), force = flag("force");
  const gap = Number(arg("gap", "1")), slippagePct = Number(arg("slippage", "1")), reserveLamports = Math.round(Number(arg("reserve", "0.05")) * 1e9);
  if (!pool || !positionAddr || !["ask", "bid"].includes(to)) fail("usage: --pool P --position X --to ask|bid [--gap 1] [--slippage 1] [--force] [--dry-run --owner PK]");
  const from = to === "ask" ? "bid" : "ask";

  let signer = null, owner;
  if (dry) { if (!arg("owner")) fail("--owner PUBKEY is needed for --dry-run"); owner = new PublicKey(arg("owner")); }
  else { try { signer = loadSigner(); } catch (e) { fail("trading key: " + e.message); } if (!signer) fail("no trading key: set DLMM_PRIVATE_KEY in .env"); owner = signer.publicKey; }

  const connection = tradeConnection();
  const positionPk = new PublicKey(positionAddr);
  if (!(await connection.getAccountInfo(positionPk, "confirmed"))) fail("posisi udah ditutup", { gone: true });
  const dlmm = await DLMM.create(connection, new PublicKey(pool));
  const lb = dlmm.lbPair;
  const solIsX = lb.tokenXMint.toBase58() === WSOL;
  if (!solIsX && lb.tokenYMint.toBase58() !== WSOL) fail("not a SOL pool");
  const tokenIsX = !solIsX;
  const tokenMint = (tokenIsX ? lb.tokenXMint : lb.tokenYMint).toBase58();
  const pos = await dlmm.getPosition(positionPk);
  const { lowerBinId: lo, upperBinId: hi } = pos.positionData;
  const width = hi - lo + 1;
  const active = (await dlmm.getActiveBin()).binId;
  const tokenRaw = BigInt(String(tokenIsX ? pos.positionData.totalXAmount : pos.positionData.totalYAmount).split(".")[0] || "0");
  const solRaw = BigInt(String(tokenIsX ? pos.positionData.totalYAmount : pos.positionData.totalXAmount).split(".")[0] || "0");
  const isCrossed = crossed({ from, activeId: active, lo, hi, tokenIsX });
  const plan = { pool, position: positionAddr, from, to, activeId: active, lo, hi, width, tokenMint, tokenRaw, solRaw,
    newRange: flipRange({ to, activeId: active, width, gap, tokenIsX }) };
  if (!isCrossed && !force) {
    out({ ok: false, notReady: true, error: `harga belum nembus posisi ini on chain (bin aktif ${active}, range ${lo}..${hi})`, plan });
    process.exit(1);
  }
  if (dry) { out({ ok: true, mode: "dry-run", plan }); process.exit(0); }

  try {
    await withLock(`position-${positionAddr}`, () => flip({ connection, dlmm, signer, owner, positionPk, plan, tokenIsX, solIsX, gap, slippagePct, reserveLamports }), { waitMs: 60000 });
  } catch (e) {
    fail(String(e.message || e).slice(0, 400), { busy: !!e.busy, ...(e.extra || {}) });
  }
}

async function flip({ connection, dlmm, signer, owner, positionPk, plan, tokenIsX, solIsX, gap, slippagePct, reserveLamports }) {
  const { to, width, tokenMint } = plan;
  const sigs = [];
  const solBefore = BigInt(await connection.getBalance(owner, "confirmed"));
  const tokBefore = (await tokenHoldings(connection, owner, tokenMint)).ata;

  // 1) remove 100% + claim fees + close (same as close_position.mjs, inline: this process holds the position lock)
  const exists = async () => !!(await connection.getAccountInfo(positionPk, "confirmed"));
  for (let round = 0; round < 3 && (await exists()); round++) {
    try {
      if (round) await dlmm.refetchStates();
      const p = await dlmm.getPosition(positionPk);
      const txs = await dlmm.removeLiquidity({ user: owner, position: positionPk, fromBinId: p.positionData.lowerBinId,
        toBinId: p.positionData.upperBinId, bps: new BN(10_000), shouldClaimAndClose: true });
      for (const tx of txs) {
        tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
        sigs.push(await sendLegacy(connection, tx, [signer]));
      }
    } catch (e) {
      await sleep(2000);
      if (!(await exists())) break;
      if (round === 2) throw Object.assign(new Error("close gagal: " + (e.message || e)), { extra: { step: "close", signatures: sigs } });
    }
  }

  // 2) what came out. The RPC can show the old balance for a few seconds: wait until it moves.
  let solGot = 0n, tokGot = 0n;
  for (let i = 0; i < 15; i++) {
    solGot = BigInt(await connection.getBalance(owner, "confirmed")) - solBefore;
    tokGot = (await tokenHoldings(connection, owner, tokenMint)).ata - tokBefore;
    if (to === "ask" ? tokGot > 0n : solGot > 0n) break;
    await sleep(2000);
  }
  const balance = BigInt(await connection.getBalance(owner, "confirmed"));
  const rent = BigInt(rentLamports(width)) + 10_000_000n;            // the new position's rent + fees and bin arrays margin
  let depositSol = 0n, depositTok = 0n;
  if (to === "ask") {
    const ata = (await tokenHoldings(connection, owner, tokenMint)).ata;
    depositTok = tokGot > ata ? ata : tokGot;                        // never more than is really there
    if (balance < rent + BigInt(reserveLamports)) throw Object.assign(new Error(`SOL kurang buat rent posisi baru (${Number(balance) / 1e9} SOL)`), { extra: { step: "reopen", closed: true, signatures: sigs } });
  } else {
    // the SOL that came out includes the old position's rent back; the new one costs about the same
    const free = balance - rent - BigInt(reserveLamports);
    depositSol = solGot - rent;
    if (depositSol > free) depositSol = free;
  }
  if (depositTok <= 0n && depositSol <= 0n) {
    throw Object.assign(new Error(`posisi ditutup, tapi nggak ada ${to === "ask" ? "token" : "SOL"} buat dibuka lagi (balik: ${Number(solGot) / 1e9} SOL, token ${tokGot})`),
      { extra: { step: "reopen", closed: true, signatures: sigs } });
  }

  // 3) open the other side, same width, BidAsk, built from the pool's current state
  await dlmm.refetchStates();
  const activeNow = (await dlmm.getActiveBin()).binId;
  const range = flipRange({ to, activeId: activeNow, width, gap, tokenIsX });
  const depositX = tokenIsX ? depositTok : depositSol, depositY = tokenIsX ? depositSol : depositTok;
  const posKp = Keypair.generate();
  const params = {
    positionPubKey: posKp.publicKey, user: owner,
    totalXAmount: new BN(depositX.toString()), totalYAmount: new BN(depositY.toString()),
    strategy: { minBinId: range.lo, maxBinId: range.hi, strategyType: StrategyType.BidAsk, ...(depositX > 0n ? { singleSidedX: true } : {}) },
    slippage: slippagePct,
  };
  try {
    let txs;
    if (width <= BINS_PER_POSITION) txs = [await dlmm.initializePositionAndAddLiquidityByStrategy(params)];
    else txs = [await dlmm.createExtendedEmptyPosition(range.lo, range.hi, posKp.publicKey, owner), ...(await dlmm.addLiquidityByStrategyChunkable(params))];
    for (const [i, tx] of txs.entries()) {
      tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
      const signers = i === 0 ? [signer, posKp] : [signer];
      try { sigs.push(await sendLegacy(connection, tx, signers)); }
      catch (e) {
        // a create that landed although the send errored: do not report it as failed (and never open it twice)
        if (i === 0 && (await connection.getAccountInfo(posKp.publicKey, "confirmed"))) { sigs.push("(landed)"); continue; }
        throw e;
      }
    }
  } catch (e) {
    throw Object.assign(new Error(`posisi lama ditutup, buka ${to} gagal: ${String(e.message || e).slice(0, 200)}. Dana ada di wallet.`),
      { extra: { step: "reopen", closed: true, signatures: sigs, leftover: { mint: tokenMint, raw: depositTok.toString(), sol: Number(depositSol) / 1e9 } } });
  }
  out({ ok: true, from: plan.from, to, position: plan.position, newPosition: posKp.publicKey.toBase58(), range, width,
    activeId: activeNow, depositSol: Number(depositSol) / 1e9, depositToken: depositTok.toString(), tokenMint, signatures: sigs });
  process.exit(0);
}
