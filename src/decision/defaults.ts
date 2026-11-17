import { DEFAULT_POSITION_BINS, POSITION_MAX_BINS, type Settings } from "../domain";

export function defaultSettings(): Settings {
  return {
    rangeWidthBins: null,
    maxBinsPerPosition: POSITION_MAX_BINS,
    binGap: 1,
    confirmMinutes: 4,
    confirmChecks: 2,
    slippageBps: 100,
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 1_400_000,
    maxFlipsPer24h: 8,
    minSolReserveLamports: 50_000_000n,
    fullBaseBps: 9900,
    fullQuoteBps: 9900,
    tpMode: "keep_cycling",
    tpBufferLamports: 0n,
    tpBufferBps: 0,
    tpDrawdownArmBps: 50,
    tpConfirmChecks: 2,
    adoptOutOfRange: "resting",
    initialSide: "auto",
    maxDropBelowAskBottomPct: 25,
    minPoolTvlUsd: 0,
    minVolume24hUsd: 0,
    metricsFailClosed: false,
    quoteMint: null,
    allowInvertedQuote: false,
    sendMaxAttempts: 3,
    freshRangeBins: DEFAULT_POSITION_BINS,
    gradualFlip: false,
    gradualFlipBins: 20,
    minFeeTvl: 0.2,
    feeTvlAction: "alert",
    highTvlWarnUsd: 100_000,
    staleAskHours: 12,
    skipTransferFee: true,
    minMarketCapUsd: 1_000_000,
    minPairAgeDays: 2,
    nearAthDrawdownPct: 30,
  };
}

export function capBins(width: number, maxBins: number): number {
  const max = Math.max(1, Math.min(maxBins, POSITION_MAX_BINS));
  return Math.max(1, Math.min(Math.floor(width), max));
}

export function positionWidth(lowerBinId: number, upperBinId: number): number {
  return upperBinId - lowerBinId + 1;
}

export function simplePositionLimit(): number {
  return DEFAULT_POSITION_BINS;
}
