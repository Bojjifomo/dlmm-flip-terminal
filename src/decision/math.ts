import Decimal from "decimal.js";
import { BPS, type PositionSnapshot, type Side } from "../domain";

export function binPriceYPerX(binId: number, binStep: number): Decimal {
  if (!Number.isInteger(binStep) || binStep <= 0 || binStep >= 10_000) {
    throw new Error(`binStep tidak valid: ${binStep}`);
  }
  return new Decimal(1).plus(new Decimal(binStep).div(10_000)).pow(binId);
}

export function markToQuote(args: {
  amountX: bigint;
  amountY: bigint;
  priceYPerX: Decimal;
  quoteIsY: boolean;
}): bigint {
  if (args.quoteIsY) {
    const y = new Decimal(args.amountY.toString()).plus(
      new Decimal(args.amountX.toString()).mul(args.priceYPerX),
    );
    return BigInt(y.toFixed(0, Decimal.ROUND_DOWN));
  }
  if (args.priceYPerX.lte(0)) return args.amountX;
  const x = new Decimal(args.amountX.toString()).plus(
    new Decimal(args.amountY.toString()).div(args.priceYPerX),
  );
  return BigInt(x.toFixed(0, Decimal.ROUND_DOWN));
}

export interface Composition {
  baseBps: number;
  quoteBps: number;
  principalQuote: bigint;
  baseQuote: bigint;
  quoteQuote: bigint;
}

export function compositionOf(
  snap: Pick<
    PositionSnapshot,
    "amountX" | "amountY" | "activeBinId" | "binStep" | "quoteIsY"
  >,
  priceBinId = snap.activeBinId,
): Composition {
  const price = binPriceYPerX(priceBinId, snap.binStep);
  const baseQuote = markToQuote({
    amountX: snap.quoteIsY ? snap.amountX : 0n,
    amountY: snap.quoteIsY ? 0n : snap.amountY,
    priceYPerX: price,
    quoteIsY: snap.quoteIsY,
  });
  const quoteQuote = snap.quoteIsY ? snap.amountY : snap.amountX;
  const principalQuote = baseQuote + quoteQuote;
  if (principalQuote === 0n) {
    return { baseBps: 0, quoteBps: 0, principalQuote: 0n, baseQuote, quoteQuote };
  }
  const baseBps = Number((baseQuote * BigInt(BPS)) / principalQuote);
  return {
    baseBps,
    quoteBps: BPS - baseBps,
    principalQuote,
    baseQuote,
    quoteQuote,
  };
}

export function feesQuote(
  snap: Pick<PositionSnapshot, "feeX" | "feeY" | "activeBinId" | "binStep" | "quoteIsY">,
): bigint {
  return markToQuote({
    amountX: snap.feeX,
    amountY: snap.feeY,
    priceYPerX: binPriceYPerX(snap.activeBinId, snap.binStep),
    quoteIsY: snap.quoteIsY,
  });
}

export function isBidFilled(
  snap: Pick<
    PositionSnapshot,
    | "activeBinId"
    | "lowerBinId"
    | "upperBinId"
    | "amountX"
    | "amountY"
    | "binStep"
    | "quoteIsY"
  >,
  fullBaseBps: number,
): boolean {
  if (snap.activeBinId < snap.lowerBinId) return true;
  return compositionOf(snap).baseBps >= fullBaseBps;
}

export function isAskFilled(
  snap: Pick<
    PositionSnapshot,
    | "activeBinId"
    | "lowerBinId"
    | "upperBinId"
    | "amountX"
    | "amountY"
    | "binStep"
    | "quoteIsY"
  >,
  fullQuoteBps: number,
): boolean {
  if (snap.activeBinId > snap.upperBinId) return true;
  return compositionOf(snap).quoteBps >= fullQuoteBps;
}

export function classifySide(
  snap: Pick<
    PositionSnapshot,
    | "activeBinId"
    | "lowerBinId"
    | "upperBinId"
    | "amountX"
    | "amountY"
    | "binStep"
    | "quoteIsY"
  >,
  initialSide: "auto" | Side,
  adoptOutOfRange: "resting" | "filled",
  fullBaseBps: number,
  fullQuoteBps: number,
): { side: Side; filled: boolean } {
  const above = snap.activeBinId < snap.lowerBinId;
  const below = snap.activeBinId > snap.upperBinId;
  if (initialSide === "bid" || initialSide === "ask") {
    const filled =
      initialSide === "bid"
        ? isBidFilled(snap, fullBaseBps)
        : isAskFilled(snap, fullQuoteBps);
    return { side: initialSide, filled };
  }
  if (above && adoptOutOfRange === "filled" && isBidFilled(snap, fullBaseBps)) {
    return { side: "bid", filled: true };
  }
  if (below && adoptOutOfRange === "filled" && isAskFilled(snap, fullQuoteBps)) {
    return { side: "ask", filled: true };
  }
  if (below) return { side: "bid", filled: false };
  if (above) return { side: "ask", filled: false };
  const share = compositionOf(snap);
  return { side: share.quoteBps >= share.baseBps ? "bid" : "ask", filled: false };
}

export function computeFlipRange(args: {
  activeBinId: number;
  toSide: Side;
  widthBins: number;
  gap: number;
}): { minBinId: number; maxBinId: number } {
  const gap = Math.max(1, Math.floor(args.gap));
  const width = Math.max(1, Math.floor(args.widthBins));
  if (args.toSide === "ask") {
    const minBinId = args.activeBinId + gap;
    return { minBinId, maxBinId: minBinId + width - 1 };
  }
  const maxBinId = args.activeBinId - gap;
  return { minBinId: maxBinId - width + 1, maxBinId };
}

export function oneSidedDeposit(
  snap: Pick<PositionSnapshot, "amountX" | "amountY" | "feeX" | "feeY" | "quoteIsY">,
  toSide: Side,
): { x: bigint; y: bigint } {
  const x = snap.amountX + snap.feeX;
  const y = snap.amountY + snap.feeY;
  if (!snap.quoteIsY) {
    return toSide === "ask" ? { x, y: 0n } : { x: 0n, y };
  }
  return toSide === "ask" ? { x, y: 0n } : { x: 0n, y };
}

export function dropBelowLowerBps(
  activeBinId: number,
  lowerBinId: number,
  binStep: number,
): number {
  if (activeBinId >= lowerBinId) return 0;
  const active = binPriceYPerX(activeBinId, binStep);
  const lower = binPriceYPerX(lowerBinId, binStep);
  if (lower.lte(0)) return 0;
  return lower.minus(active).div(lower).mul(BPS).floor().toNumber();
}

export interface TakeProfitMath {
  principalQuote: bigint;
  feesEarnedQuote: bigint;
  equityQuote: bigint;
  pnlQuote: bigint;
  bufferQuote: bigint;
  armed: boolean;
  hit: boolean;
}

export function takeProfitMath(args: {
  principalQuote: bigint;
  unclaimedFeesQuote: bigint;
  claimedFeesQuote: bigint;
  feeBaselineQuote: bigint;
  costBasisQuote: bigint;
  bufferLamports: bigint;
  bufferBps: number;
  drawdownArmBps: number;
  alreadyArmed: boolean;
}): TakeProfitMath {
  const feesEarned =
    args.unclaimedFeesQuote + args.claimedFeesQuote - args.feeBaselineQuote;
  const equity = args.principalQuote + args.unclaimedFeesQuote + args.claimedFeesQuote;
  const pnl = equity - args.costBasisQuote;
  const buffer =
    args.bufferLamports +
    (args.costBasisQuote * BigInt(Math.max(0, args.bufferBps))) / BigInt(BPS);
  const armLine =
    (args.costBasisQuote * BigInt(BPS - Math.max(0, args.drawdownArmBps))) / BigInt(BPS);
  const armed = args.alreadyArmed || args.principalQuote < armLine;
  const hit =
    armed && args.costBasisQuote > 0n && args.principalQuote >= args.costBasisQuote + buffer;
  return {
    principalQuote: args.principalQuote,
    feesEarnedQuote: feesEarned,
    equityQuote: equity,
    pnlQuote: pnl,
    bufferQuote: buffer,
    armed,
    hit,
  };
}

export function advanceConfirm(
  prev: { startedAtMs: number; checks: number; lastAtMs: number; direction: string } | null,
  direction: string,
  nowMs: number,
): { startedAtMs: number; checks: number; lastAtMs: number } {
  if (!prev || prev.direction !== direction) {
    return { startedAtMs: nowMs, checks: 1, lastAtMs: nowMs };
  }
  return {
    startedAtMs: prev.startedAtMs,
    checks: prev.checks + 1,
    lastAtMs: nowMs,
  };
}

export function confirmReady(
  state: { startedAtMs: number; checks: number },
  nowMs: number,
  needChecks: number,
  needMinutes: number,
): boolean {
  const checks = Math.max(1, needChecks);
  const needMs = Math.max(0, needMinutes) * 60_000;
  return state.checks >= checks && nowMs - state.startedAtMs >= needMs;
}

/**
 * Jumlah yang direncanain bisa lebih gede dari yang beneran masuk wallet (pembulatan,
 * fee transfer, dust yang ketinggalan). Kirim lebih dari saldo = "insufficient funds".
 * Jadi potong ke saldo nyata. Nggak pernah nambah di atas rencana. SOL native dilewatin
 * (dicek terpisah di assertSol).
 */
export function capToBalance(planned: bigint, balance: bigint): bigint {
  if (planned <= 0n) return 0n;
  return balance < planned ? (balance > 0n ? balance : 0n) : planned;
}
