import { BN } from "@coral-xyz/anchor";
import DLMM, { ResizeSide, StrategyType } from "@meteora-ag/dlmm";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
  type Transaction,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { decodeBase58, encodeBase58 } from "../base58";
import { simplePositionLimit } from "../decision/defaults";
import { computeFlipRange, markToQuote, binPriceYPerX } from "../decision/math";
import type { PendingAction, Settings } from "../domain";
import { loadPool } from "./pools";
import { sendAndConfirm, signatureConfirmed } from "./tx";

export async function progressPending(args: {
  connection: Connection;
  owner: Keypair;
  pending: PendingAction;
  settings: Settings;
  commitment?: Commitment;
  onCheckpoint?: (pending: PendingAction) => void;
}): Promise<PendingAction> {
  const pending: PendingAction = { ...args.pending, updatedAtMs: Date.now() };
  if (pending.phase === "done" || pending.phase === "needs_human" || pending.phase === "awaiting_confirm") {
    return pending;
  }
  if (pending.signature) {
    const status = await signatureConfirmed(args.connection, pending.signature, args.commitment);
    if (status === "pending") return pending;
    if (status === "failed") {
      pending.signature = undefined;
      pending.lastError = "tx sebelumnya gagal on-chain";
      pending.attempts += 1;
      if (pending.attempts >= args.settings.sendMaxAttempts) {
        pending.phase = "needs_human";
        pending.lastError = "tx gagal berulang. Cek Solscan, terus `ack` kalau udah beres manual.";
      }
      return pending;
    }
    pending.signatures = [...pending.signatures, pending.signature];
    if (pending.lastSwapIn && pending.phase === "swap") {
      subtractSwap(pending);
    }
    pending.signature = undefined;
    pending.attempts = 0;
  }

  const dlmm = await loadPool(args.connection, pending.pool, true);
  switch (pending.phase) {
    case "claim":
      return claimStep(args, pending, dlmm);
    case "remove":
      return removeStep(args, pending, dlmm);
    case "close":
      return closeStep(args, pending, dlmm);
    case "open":
      return openStep(args, pending, dlmm);
    case "swap":
      return swapStep(args, pending, dlmm);
    default:
      return pending;
  }
}

async function claimStep(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
): Promise<PendingAction> {
  const position = await readPosition(dlmm, pending.fromPosition);
  if (!position) {
    pending.phase = "remove";
    return pending;
  }
  try {
    const txs = await dlmm.claimAllRewardsByPosition({
      owner: args.owner.publicKey,
      position,
    });
    if (txs.length === 0) {
      pending.phase = "remove";
      return pending;
    }
    pending.signature = await send(args, pending, txs[0], [args.owner]);
    return pending;
  } catch (error) {
    if (isEmptyClaim(error)) {
      pending.phase = "remove";
      return pending;
    }
    throw error;
  }
}

async function removeStep(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
): Promise<PendingAction> {
  accountFees(pending, dlmm);
  const position = await readPosition(dlmm, pending.fromPosition);
  if (!position) {
    return afterMemberClosed(pending);
  }
  const data = position.positionData;
  const fromBinId = pending.removeFromBin ?? data.lowerBinId;
  const toBinId = pending.removeToBin ?? data.upperBinId;
  try {
    const txs = await dlmm.removeLiquidity({
      user: args.owner.publicKey,
      position: position.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: false,
    });
    if (txs.length === 0) {
      pending.phase = pending.closeAfter === false ? "open" : "close";
      return pending;
    }
    pending.signature = await send(args, pending, txs[0], [args.owner]);
    return pending;
  } catch (error) {
    if (String(error).includes("No liquidity")) {
      pending.phase = pending.closeAfter === false ? "open" : "close";
      return pending;
    }
    throw error;
  }
}

async function closeStep(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
): Promise<PendingAction> {
  if (pending.closeAfter === false) {
    pending.phase = "open";
    return pending;
  }
  const position = await readPosition(dlmm, pending.fromPosition);
  if (!position) return afterMemberClosed(pending);
  const data = position.positionData;
  const dust = asBigint(data.totalXAmount) + asBigint(data.totalYAmount);
  if (dust > 0n) {
    pending.phase = "remove";
    return pending;
  }
  const tx = await dlmm.closePosition({ owner: args.owner.publicKey, position });
  pending.signature = await send(args, pending, tx, [args.owner]);
  return pending;
}

async function openStep(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
): Promise<PendingAction> {
  if (!pending.positionSecret || pending.minBinId == null || pending.maxBinId == null) {
    const kp = pending.positionSecret
      ? Keypair.fromSecretKey(decodeBase58(pending.positionSecret))
      : Keypair.generate();
    pending.positionSecret = encodeBase58(kp.secretKey);
    pending.toPosition = kp.publicKey.toBase58();
    const active = toNum(dlmm.lbPair.activeId);
    const range = computeFlipRange({
      activeBinId: active,
      toSide: pending.toSide,
      widthBins: pending.widthBins,
      gap: pending.binGap,
    });
    pending.minBinId = range.minBinId;
    pending.maxBinId = range.maxBinId;
    return pending;
  }

  const positionKp = Keypair.fromSecretKey(decodeBase58(pending.positionSecret));
  const info = await args.connection.getAccountInfo(positionKp.publicKey);
  const minBinId = pending.minBinId;
  const maxBinId = pending.maxBinId;
  const strategy = {
    minBinId,
    maxBinId,
    strategyType: StrategyType.BidAsk,
    singleSidedX: pending.toSide === "ask",
  };
  await assertSol(args, pending, dlmm, strategy);

  if (!info) {
    const width = maxBinId - minBinId + 1;
    if (width <= simplePositionLimit()) {
      const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: args.owner.publicKey,
        totalXAmount: new BN(pending.depositX),
        totalYAmount: new BN(pending.depositY),
        strategy,
        slippage: args.settings.slippageBps / 100,
      });
      pending.signature = await send(args, pending, tx, [args.owner, positionKp]);
      return pending;
    }
    const base = baseWindow(pending.toSide, minBinId, maxBinId, simplePositionLimit());
    const tx = await dlmm.createEmptyPosition({
      positionPubKey: positionKp.publicKey,
      minBinId: base.minBinId,
      maxBinId: base.maxBinId,
      user: args.owner.publicKey,
    });
    pending.signature = await send(args, pending, tx, [args.owner, positionKp]);
    return pending;
  }

  const position = await dlmm.getPosition(positionKp.publicKey);
  const haveX = asBigint(position.positionData.totalXAmount);
  const haveY = asBigint(position.positionData.totalYAmount);
  const widthNow = position.positionData.upperBinId - position.positionData.lowerBinId + 1;
  const widthTarget = maxBinId - minBinId + 1;
  if (widthNow < widthTarget) {
    const extra = widthTarget - widthNow;
    const side = pending.toSide === "ask" ? ResizeSide.Upper : ResizeSide.Lower;
    const txs = await dlmm.increasePositionLength(
      positionKp.publicKey,
      side,
      new BN(extra),
      args.owner.publicKey,
      false,
    );
    if (!txs || txs.length === 0) {
      pending.phase = "needs_human";
      pending.lastError = "gagal susun transaksi perlebar posisi";
      return pending;
    }
    pending.signature = await send(args, pending, txs[0], [args.owner]);
    return pending;
  }

  if (filledEnough(haveX, haveY, BigInt(pending.depositX), BigInt(pending.depositY))) {
    return finishOpen(pending);
  }
  if (haveX > 0n || haveY > 0n) {
    pending.phase = "needs_human";
    pending.lastError =
      "likuiditas masuk sebagian. Bot berhenti biar nggak dobel deposit. Selesain manual, lalu `ack`.";
    return pending;
  }

  const chunks = await dlmm.addLiquidityByStrategyChunkable({
    positionPubKey: positionKp.publicKey,
    user: args.owner.publicKey,
    totalXAmount: new BN(pending.depositX),
    totalYAmount: new BN(pending.depositY),
    strategy,
    slippage: args.settings.slippageBps / 100,
  });
  if (chunks.length === 0) {
    pending.phase = "needs_human";
    pending.lastError = "SDK nggak ngasih transaksi deposit";
    return pending;
  }
  for (const tx of chunks) {
    const signature = await send(args, pending, tx, [args.owner]);
    pending.signatures = [...pending.signatures, signature];
  }
  return finishOpen(pending);
}

async function swapStep(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
): Promise<PendingAction> {
  const quoteIsY = pending.quoteIsY !== false;
  const amount = quoteIsY ? BigInt(pending.depositX) : BigInt(pending.depositY);
  if (amount <= 0n) return finishSwap(pending);
  const swapForY = quoteIsY;
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  let quote;
  try {
    quote = dlmm.swapQuote(
      new BN(amount.toString()),
      swapForY,
      new BN(args.settings.slippageBps),
      binArrays,
      true,
    );
  } catch (error) {
    pending.phase = "needs_human";
    pending.lastError = `swap quote gagal, token masih di wallet: ${error instanceof Error ? error.message : error}`;
    return pending;
  }
  if (quote.consumedInAmount.isZero()) {
    pending.phase = "needs_human";
    pending.lastError = "pool nggak cukup likuid buat swap sisa token ke quote";
    return pending;
  }
  const tx = await dlmm.swap({
    inToken: swapForY ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey,
    outToken: swapForY ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: args.owner.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  pending.lastSwapIn = quote.consumedInAmount.toString();
  pending.signature = await send(args, pending, tx, [args.owner]);
  return pending;
}

function finishOpen(pending: PendingAction): PendingAction {
  pending.phase = "done";
  delete pending.positionSecret;
  pending.lastError = undefined;
  return pending;
}

function finishSwap(pending: PendingAction): PendingAction {
  pending.phase = "done";
  pending.lastSwapIn = undefined;
  return pending;
}

function afterMemberClosed(pending: PendingAction): PendingAction {
  const closed = pending.fromPosition;
  pending.memberPositions = pending.memberPositions.filter((id) => id !== closed);
  if (pending.memberPositions.length > 0) {
    pending.fromPosition = pending.memberPositions[0];
    pending.phase = "claim";
    return pending;
  }
  pending.phase = pending.kind === "take_profit" || pending.kind === "cut" ? "swap" : "open";
  return pending;
}

function accountFees(pending: PendingAction, dlmm: DLMM): void {
  if (pending.feesAccounted) return;
  const price = binPriceYPerX(toNum(dlmm.lbPair.activeId), toNum(dlmm.lbPair.binStep));
  const quote = markToQuote({
    amountX: BigInt(pending.feeX || "0"),
    amountY: BigInt(pending.feeY || "0"),
    priceYPerX: price,
    quoteIsY: pending.quoteIsY !== false,
  });
  pending.claimedFeesQuoteAdded = quote.toString();
  pending.feesAccounted = true;
}

function subtractSwap(pending: PendingAction): void {
  const used = BigInt(pending.lastSwapIn ?? "0");
  if (pending.quoteIsY !== false) {
    const left = BigInt(pending.depositX) - used;
    pending.depositX = (left > 0n ? left : 0n).toString();
  } else {
    const left = BigInt(pending.depositY) - used;
    pending.depositY = (left > 0n ? left : 0n).toString();
  }
  const left = pending.quoteIsY !== false ? BigInt(pending.depositX) : BigInt(pending.depositY);
  const original = used + left;
  pending.lastSwapIn = undefined;
  if (left === 0n || (original > 0n && left * 100n < original)) {
    pending.phase = "done";
  }
}

async function assertSol(
  args: StepArgs,
  pending: PendingAction,
  dlmm: DLMM,
  strategy: { minBinId: number; maxBinId: number; strategyType: StrategyType; singleSidedX?: boolean },
): Promise<void> {
  const balance = BigInt(await args.connection.getBalance(args.owner.publicKey));
  let rentSol = 0.2;
  try {
    const quote = await dlmm.quoteCreatePosition({ strategy });
    rentSol = quote.positionCost + quote.positionReallocCost + quote.binArrayCost + quote.bitmapExtensionCost + 0.02;
  } catch {
    rentSol = 0.25;
  }
  const rent = BigInt(Math.ceil(rentSol * 1_000_000_000));
  const wrap = nativeDeposit(dlmm, pending);
  const need = wrap + rent + args.settings.minSolReserveLamports;
  if (balance < need) {
    throw new Error(
      `SOL kurang buat buka posisi. Saldo ${balance} lamports, butuh ${need} termasuk cadangan ${args.settings.minSolReserveLamports}.`,
    );
  }
}

function nativeDeposit(dlmm: DLMM, pending: PendingAction): bigint {
  let total = 0n;
  if (dlmm.tokenX.publicKey.equals(NATIVE_MINT)) total += BigInt(pending.depositX);
  if (dlmm.tokenY.publicKey.equals(NATIVE_MINT)) total += BigInt(pending.depositY);
  return total;
}

function baseWindow(
  toSide: PendingAction["toSide"],
  minBinId: number,
  maxBinId: number,
  base: number,
): { minBinId: number; maxBinId: number } {
  const width = maxBinId - minBinId + 1;
  if (width <= base) return { minBinId, maxBinId };
  if (toSide === "ask") return { minBinId, maxBinId: minBinId + base - 1 };
  return { minBinId: maxBinId - base + 1, maxBinId };
}

function filledEnough(haveX: bigint, haveY: bigint, wantX: bigint, wantY: bigint): boolean {
  const ok = (have: bigint, want: bigint) => want === 0n || have * 100n >= want * 95n;
  return ok(haveX, wantX) && ok(haveY, wantY);
}

async function readPosition(dlmm: DLMM, position: string) {
  try {
    return await dlmm.getPosition(new PublicKey(position));
  } catch (error) {
    if (String(error).includes("not found")) return null;
    throw error;
  }
}

async function send(args: StepArgs, pending: PendingAction, tx: Transaction, signers: Keypair[]): Promise<string> {
  return sendAndConfirm({
    connection: args.connection,
    tx,
    signers,
    priorityFeeMicroLamports: args.settings.priorityFeeMicroLamports,
    computeUnitLimit: args.settings.computeUnitLimit,
    maxAttempts: args.settings.sendMaxAttempts,
    commitment: args.commitment,
    onSignature: (signature) => {
      pending.signature = signature;
      pending.updatedAtMs = Date.now();
      args.onCheckpoint?.({ ...pending, positionSecret: pending.positionSecret });
    },
  });
}

function isEmptyClaim(error: unknown): boolean {
  const text = String(error);
  return text.includes("No fee") || text.includes("No reward") || text.includes("no fee");
}

function asBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (value && typeof (value as { toString: () => string }).toString === "function") {
    const text = (value as { toString: () => string }).toString();
    if (/^-?\d+$/.test(text)) return BigInt(text);
  }
  return 0n;
}

function toNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

interface StepArgs {
  connection: Connection;
  owner: Keypair;
  pending: PendingAction;
  settings: Settings;
  commitment?: Commitment;
  onCheckpoint?: (pending: PendingAction) => void;
}
