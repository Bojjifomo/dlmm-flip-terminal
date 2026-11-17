import type { Cycle, PositionSnapshot, Settings } from "../src/domain";
import { defaultSettings } from "../src/decision/defaults";

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), confirmMinutes: 0, confirmChecks: 1, tpConfirmChecks: 1, ...patch };
}

export function snap(patch: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    position: "POS",
    pool: "POOL",
    label: "MEME/SOL",
    activeBinId: 1000,
    lowerBinId: 980,
    upperBinId: 999,
    binStep: 100,
    amountX: 0n,
    amountY: 1_000_000_000n,
    feeX: 0n,
    feeY: 0n,
    quoteIsY: true,
    inverted: false,
    manageable: true,
    quoteDecimals: 9,
    baseDecimals: 6,
    quoteSymbol: "SOL",
    baseSymbol: "MEME",
    mintX: "MEME",
    mintY: "SOL",
    poolTvlUsd: 50_000,
    volume24hUsd: 500_000,
    fees24hUsd: null,
    transferFee: false,
    pairCreatedAtMs: null,
    baseMarketCapUsd: null,
    priceUsd: null,
    athUsd: null,
    binBalances: [],
    ...patch,
  };
}

export function cycle(patch: Partial<Cycle> = {}): Cycle {
  return {
    cycleId: "c1",
    pool: "POOL",
    position: "POS",
    members: ["POS"],
    side: "bid",
    adoptedAtMs: 0,
    costBasisQuote: 1_000_000_000n,
    claimedFeesQuote: 0n,
    feeBaselineQuote: 0n,
    widthBins: 20,
    originPosition: "POS",
    confirm: null,
    tpConfirm: null,
    tpArmed: false,
    tpNotified: false,
    skipUntilReset: false,
    stopped: false,
    dryRunAnnounced: false,
    openedByBot: false,
    askOorSinceMs: null,
    staleAskNotified: false,
    staleAskSnoozeUntilMs: null,
    gradualAnchorBin: null,
    ...patch,
  };
}
