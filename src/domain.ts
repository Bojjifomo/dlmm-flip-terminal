export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const POSITION_MAX_BINS = 1400;
export const DEFAULT_POSITION_BINS = 70;
export const BPS = 10_000;
export const PREFERRED_BIN_STEPS = [80, 100] as const;

export type Mode = "dry-run" | "alert" | "auto";
export type Side = "bid" | "ask";
export type TpMode = "close" | "keep_cycling";
export type AdoptOutOfRange = "resting" | "filled";
export type FeeTvlAction = "alert" | "pause";
export type ManualAction = "confirm" | "skip" | "hold" | "recenter" | "cut";
export type PendingKind = "flip" | "take_profit" | "recenter" | "cut";

export interface Settings {
  rangeWidthBins: number | null;
  maxBinsPerPosition: number;
  binGap: number;
  confirmMinutes: number;
  confirmChecks: number;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  maxFlipsPer24h: number;
  minSolReserveLamports: bigint;
  fullBaseBps: number;
  fullQuoteBps: number;
  tpMode: TpMode;
  tpBufferLamports: bigint;
  tpBufferBps: number;
  tpDrawdownArmBps: number;
  tpConfirmChecks: number;
  adoptOutOfRange: AdoptOutOfRange;
  initialSide: "auto" | Side;
  maxDropBelowAskBottomPct: number;
  minPoolTvlUsd: number;
  minVolume24hUsd: number;
  metricsFailClosed: boolean;
  quoteMint: string | null;
  allowInvertedQuote: boolean;
  sendMaxAttempts: number;
  freshRangeBins: number;
  gradualFlip: boolean;
  gradualFlipBins: number;
  minFeeTvl: number;
  feeTvlAction: FeeTvlAction;
  highTvlWarnUsd: number;
  staleAskHours: number;
  skipTransferFee: boolean;
  minMarketCapUsd: number;
  minPairAgeDays: number;
  nearAthDrawdownPct: number;
}

export interface ConfirmState {
  direction: "to_ask" | "to_bid" | "take_profit";
  startedAtMs: number;
  checks: number;
  lastAtMs: number;
}

export interface Cycle {
  cycleId: string;
  pool: string;
  position: string;
  members: string[];
  side: Side;
  adoptedAtMs: number;
  costBasisQuote: bigint;
  claimedFeesQuote: bigint;
  feeBaselineQuote: bigint;
  widthBins: number;
  originPosition: string;
  confirm: ConfirmState | null;
  tpConfirm: ConfirmState | null;
  tpArmed: boolean;
  tpNotified: boolean;
  skipUntilReset: boolean;
  stopped: boolean;
  stopReason?: string;
  dryRunAnnounced: boolean;
  openedByBot: boolean;
  askOorSinceMs: number | null;
  staleAskNotified: boolean;
  staleAskSnoozeUntilMs: number | null;
  gradualAnchorBin: number | null;
}

export interface PositionSnapshot {
  position: string;
  pool: string;
  label: string;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  binStep: number;
  amountX: bigint;
  amountY: bigint;
  feeX: bigint;
  feeY: bigint;
  quoteIsY: boolean;
  inverted: boolean;
  manageable: boolean;
  blockReason?: string;
  quoteDecimals: number;
  baseDecimals: number;
  quoteSymbol: string;
  baseSymbol: string;
  mintX: string;
  mintY: string;
  poolTvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  transferFee: boolean;
  pairCreatedAtMs: number | null;
  baseMarketCapUsd: number | null;
  priceUsd: number | null;
  athUsd: number | null;
  binBalances: BinBalance[];
}

export interface BinBalance {
  binId: number;
  amountX: bigint;
  amountY: bigint;
}

export interface FlipPlan {
  fromSide: Side;
  toSide: Side;
  minBinId: number;
  maxBinId: number;
  widthBins: number;
  gap: number;
  depositX: bigint;
  depositY: bigint;
  reason: string;
  partial: boolean;
  closeAfter: boolean;
  removeFromBin?: number;
  removeToBin?: number;
  nextAnchorBin?: number;
}

export interface TakeProfitPlan {
  pnlQuote: bigint;
  feesQuote: bigint;
  principalQuote: bigint;
  costBasisQuote: bigint;
  depositX: bigint;
  depositY: bigint;
}

export type Decision =
  | { type: "hold"; reason: string }
  | {
      type: "confirming";
      direction: ConfirmState["direction"];
      checks: number;
      elapsedMs: number;
      needChecks: number;
      needMs: number;
    }
  | { type: "flip"; plan: FlipPlan }
  | { type: "take_profit"; plan: TakeProfitPlan }
  | { type: "take_profit_notice"; pnlQuote: bigint; feesQuote: bigint }
  | { type: "pause"; reason: string }
  | { type: "blocked"; reason: string }
  | { type: "stopped"; reason: string }
  | { type: "skip"; reason: string }
  | { type: "stale_ask"; hours: number };

export type Phase =
  | "awaiting_confirm"
  | "claim"
  | "remove"
  | "close"
  | "open"
  | "swap"
  | "needs_human"
  | "done";

export interface PendingAction {
  id: string;
  kind: PendingKind;
  partial: boolean;
  closeAfter: boolean;
  removeFromBin?: number;
  removeToBin?: number;
  nextAnchorBin?: number;
  phase: Phase;
  pool: string;
  fromPosition: string;
  cycleId: string;
  toSide: Side;
  fromSide: Side;
  widthBins: number;
  binGap: number;
  minBinId?: number;
  maxBinId?: number;
  depositX: string;
  depositY: string;
  feeX: string;
  feeY: string;
  quoteIsY: boolean;
  lastSwapIn?: string;
  claimedFeesQuoteAdded: string;
  feesAccounted: boolean;
  feeApplied?: boolean;
  costBasisQuote: string;
  positionSecret?: string;
  toPosition?: string;
  signature?: string;
  signatures: string[];
  attempts: number;
  lastError?: string;
  createdAtMs: number;
  updatedAtMs: number;
  notified: boolean;
  memberPositions: string[];
}

export interface FlipRecord {
  atMs: number;
  pool: string;
  fromPosition: string;
  toPosition?: string;
  signature?: string;
  kind: PendingKind;
  pnlQuote?: string;
  feesQuote?: string;
}

export interface PauseRecord {
  reason: string;
  atMs: number;
}

export interface BotState {
  version: 1;
  cycles: Record<string, PersistedCycle>;
  positionIndex: Record<string, string>;
  pending: Record<string, PendingAction>;
  flips: FlipRecord[];
  paused: Record<string, PauseRecord>;
  manual: Record<string, ManualAction>;
  botOpened: Record<string, Side>;
  lastDailySummaryDate?: string;
  telegramOffset?: number;
  notifiedErrors: Record<string, number>;
}

export interface PersistedCycle {
  cycleId: string;
  pool: string;
  position: string;
  members: string[];
  side: Side;
  adoptedAtMs: number;
  costBasisQuote: string;
  claimedFeesQuote: string;
  feeBaselineQuote: string;
  widthBins: number;
  originPosition: string;
  confirm: ConfirmState | null;
  tpConfirm: ConfirmState | null;
  tpArmed: boolean;
  tpNotified: boolean;
  skipUntilReset: boolean;
  stopped: boolean;
  stopReason?: string;
  dryRunAnnounced: boolean;
  openedByBot?: boolean;
  askOorSinceMs?: number | null;
  staleAskNotified?: boolean;
  staleAskSnoozeUntilMs?: number | null;
  gradualAnchorBin?: number | null;
}

export function emptyState(): BotState {
  return {
    version: 1,
    cycles: {},
    positionIndex: {},
    pending: {},
    flips: [],
    paused: {},
    manual: {},
    botOpened: {},
    notifiedErrors: {},
  };
}
