import {
  type Cycle,
  type Decision,
  type FlipPlan,
  type PositionSnapshot,
  type Settings,
  type Side,
  type TakeProfitPlan,
} from "../domain";
import { positionWidth } from "./defaults";
import {
  amountInBins,
  feeTvlRatio,
  gradualSlice,
  poolAdvisories,
  reopenWidth,
  staleAskHours,
} from "./guards";
import {
  advanceConfirm,
  classifySide,
  compositionOf,
  computeFlipRange,
  confirmReady,
  dropBelowLowerBps,
  feesQuote,
  isAskFilled,
  isBidFilled,
  oneSidedDeposit,
  takeProfitMath,
} from "./math";

export interface EngineInput {
  nowMs: number;
  snapshot: PositionSnapshot;
  cycle: Cycle | null;
  settings: Settings;
  flipsLast24h: number;
  pausedReason: string | null;
  openedHint?: boolean;
}

export interface EngineResult {
  decision: Decision;
  cycle: Cycle | null;
  advisories: string[];
}

export function evaluate(input: EngineInput): EngineResult {
  const { snapshot: snap, settings, nowMs } = input;
  const guard = poolAdvisories(snap, settings, nowMs);
  const advisories = guard.notes;
  if (snap.transferFee && settings.skipTransferFee) {
    return {
      decision: { type: "skip", reason: snap.blockReason ?? "token punya transfer tax (Token-2022)" },
      cycle: input.cycle,
      advisories,
    };
  }
  if (!snap.manageable) {
    return { decision: { type: "skip", reason: snap.blockReason ?? "pool di-skip" }, cycle: input.cycle, advisories };
  }
  const comp = compositionOf(snap);
  if (comp.principalQuote === 0n && snap.amountX === 0n && snap.amountY === 0n) {
    return { decision: { type: "skip", reason: "posisi kosong" }, cycle: input.cycle, advisories };
  }

  let cycle = input.cycle;
  if (!cycle) {
    const classified = classifySide(
      snap,
      settings.initialSide,
      settings.adoptOutOfRange,
      settings.fullBaseBps,
      settings.fullQuoteBps,
    );
    const width = reopenWidth(snap.lowerBinId, snap.upperBinId, settings);
    cycle = {
      cycleId: `${snap.position}:${nowMs}`,
      pool: snap.pool,
      position: snap.position,
      members: [snap.position],
      side: classified.side,
      adoptedAtMs: nowMs,
      costBasisQuote: comp.principalQuote,
      claimedFeesQuote: 0n,
      feeBaselineQuote: feesQuote(snap),
      widthBins: width,
      originPosition: snap.position,
      confirm: null,
      tpConfirm: null,
      tpArmed: false,
      tpNotified: false,
      skipUntilReset: false,
      stopped: false,
      dryRunAnnounced: false,
      openedByBot: Boolean(input.openedHint),
      askOorSinceMs: null,
      staleAskNotified: false,
      staleAskSnoozeUntilMs: null,
      gradualAnchorBin: classified.side === "bid" ? snap.upperBinId : snap.lowerBinId,
    };
  }

  if (cycle.stopped) {
    return { decision: { type: "stopped", reason: cycle.stopReason ?? "siklus berhenti" }, cycle, advisories };
  }
  if (input.pausedReason) {
    return { decision: { type: "pause", reason: input.pausedReason }, cycle, advisories };
  }

  const stale = staleAskHours(cycle, snap, nowMs, settings.staleAskHours);
  cycle = {
    ...cycle,
    askOorSinceMs: stale.sinceMs,
    staleAskNotified: stale.sinceMs == null ? false : cycle.staleAskNotified,
  };
  if (stale.due) {
    return { decision: { type: "stale_ask", hours: stale.hours }, cycle, advisories };
  }

  if (
    cycle.side === "ask" &&
    settings.maxDropBelowAskBottomPct > 0 &&
    snap.activeBinId < snap.lowerBinId
  ) {
    const dropBps = dropBelowLowerBps(snap.activeBinId, snap.lowerBinId, snap.binStep);
    const limitBps = Math.round(settings.maxDropBelowAskBottomPct * 100);
    if (dropBps >= limitBps) {
      return {
        decision: {
          type: "pause",
          reason: `harga jatuh ${(dropBps / 100).toFixed(2)}% di bawah lantai ask (batas ${settings.maxDropBelowAskBottomPct}%)`,
        },
        cycle,
        advisories,
      };
    }
  }

  if (guard.pauseFeeTvl) {
    const ratio = feeTvlRatio(snap.fees24hUsd, snap.poolTvlUsd);
    return {
      decision: {
        type: "pause",
        reason: `fee/TVL 24h ${((ratio ?? 0) * 100).toFixed(1)}% di bawah ${(settings.minFeeTvl * 100).toFixed(0)}% dan harga di tengah range`,
      },
      cycle,
      advisories,
    };
  }

  if (settings.minPoolTvlUsd > 0) {
    if (snap.poolTvlUsd == null) {
      if (settings.metricsFailClosed) {
        return { decision: { type: "blocked", reason: "TVL pool nggak kebaca" }, cycle, advisories };
      }
    } else if (snap.poolTvlUsd < settings.minPoolTvlUsd) {
      return {
        decision: { type: "pause", reason: `TVL pool ${snap.poolTvlUsd.toFixed(0)} USD di bawah batas` },
        cycle,
        advisories,
      };
    }
  }
  if (settings.minVolume24hUsd > 0) {
    if (snap.volume24hUsd == null) {
      if (settings.metricsFailClosed) {
        return { decision: { type: "blocked", reason: "volume 24h nggak kebaca" }, cycle, advisories };
      }
    } else if (snap.volume24hUsd < settings.minVolume24hUsd) {
      return {
        decision: {
          type: "pause",
          reason: `volume 24h ${snap.volume24hUsd.toFixed(0)} USD di bawah batas`,
        },
        cycle,
        advisories,
      };
    }
  }

  const unclaimed = feesQuote(snap);
  const tp = takeProfitMath({
    principalQuote: comp.principalQuote,
    unclaimedFeesQuote: unclaimed,
    claimedFeesQuote: cycle.claimedFeesQuote,
    feeBaselineQuote: cycle.feeBaselineQuote,
    costBasisQuote: cycle.costBasisQuote,
    bufferLamports: settings.tpBufferLamports,
    bufferBps: settings.tpBufferBps,
    drawdownArmBps: settings.tpDrawdownArmBps,
    alreadyArmed: cycle.tpArmed,
  });
  cycle = { ...cycle, tpArmed: tp.armed };

  const filled =
    cycle.side === "bid"
      ? isBidFilled(snap, settings.fullBaseBps)
      : isAskFilled(snap, settings.fullQuoteBps);
  const direction = cycle.side === "bid" ? "to_ask" : "to_bid";
  const chunk = settings.gradualFlip
    ? gradualSlice({
        side: cycle.side,
        activeBinId: snap.activeBinId,
        lowerBinId: snap.lowerBinId,
        upperBinId: snap.upperBinId,
        anchorBin: cycle.gradualAnchorBin,
        chunkBins: settings.gradualFlipBins,
      })
    : null;

  if (tp.hit) {
    const tpState = advanceConfirm(cycle.tpConfirm, "take_profit", nowMs);
    cycle = { ...cycle, tpConfirm: { ...tpState, direction: "take_profit" } };
    const tpReady = confirmReady(tpState, nowMs, settings.tpConfirmChecks, 0);
    if (tpReady && settings.tpMode === "close") {
      const plan: TakeProfitPlan = {
        pnlQuote: tp.pnlQuote,
        feesQuote: tp.feesEarnedQuote,
        principalQuote: tp.principalQuote,
        costBasisQuote: cycle.costBasisQuote,
        depositX: snap.amountX + snap.feeX,
        depositY: snap.amountY + snap.feeY,
      };
      return { decision: { type: "take_profit", plan }, cycle, advisories };
    }
    if (tpReady && !cycle.tpNotified) {
      cycle = { ...cycle, tpNotified: true };
      return {
        decision: { type: "take_profit_notice", pnlQuote: tp.pnlQuote, feesQuote: tp.feesEarnedQuote },
        cycle,
        advisories,
      };
    }
    if (!tpReady && (settings.tpMode === "close" || (!filled && !chunk))) {
      return {
        decision: {
          type: "confirming",
          direction: "take_profit",
          checks: tpState.checks,
          elapsedMs: nowMs - tpState.startedAtMs,
          needChecks: Math.max(1, settings.tpConfirmChecks),
          needMs: 0,
        },
        cycle,
        advisories,
      };
    }
  } else {
    cycle = { ...cycle, tpConfirm: null };
  }

  if (!filled && !chunk) {
    cycle = { ...cycle, confirm: null, skipUntilReset: false };
    return { decision: { type: "hold", reason: holdReason(snap, cycle.side) }, cycle, advisories };
  }
  if (cycle.skipUntilReset) {
    return { decision: { type: "hold", reason: "flip di-skip, nunggu harga balik ke range dulu" }, cycle, advisories };
  }

  const confirmDirection = filled ? direction : direction;
  const confirm = advanceConfirm(cycle.confirm, confirmDirection, nowMs);
  cycle = { ...cycle, confirm: { ...confirm, direction: confirmDirection } };
  const needChecks = Math.max(1, settings.confirmChecks);
  const needMs = Math.max(0, settings.confirmMinutes) * 60_000;
  if (!confirmReady(confirm, nowMs, needChecks, settings.confirmMinutes)) {
    return {
      decision: {
        type: "confirming",
        direction: confirmDirection,
        checks: confirm.checks,
        elapsedMs: nowMs - confirm.startedAtMs,
        needChecks,
        needMs,
      },
      cycle,
      advisories,
    };
  }
  if (input.flipsLast24h >= settings.maxFlipsPer24h) {
    return {
      decision: {
        type: "blocked",
        reason: `sudah ${input.flipsLast24h} flip / 24 jam (batas ${settings.maxFlipsPer24h})`,
      },
      cycle,
      advisories,
    };
  }

  if (!filled && chunk) {
    const plan = chunkPlan(snap, cycle.side, chunk);
    if (!plan) {
      return { decision: { type: "hold", reason: "chunk gradual kosong" }, cycle, advisories };
    }
    return { decision: { type: "flip", plan }, cycle, advisories };
  }

  const toSide = direction === "to_ask" ? "ask" : "bid";
  const width = reopenWidth(snap.lowerBinId, snap.upperBinId, settings);
  const range = computeFlipRange({
    activeBinId: snap.activeBinId,
    toSide,
    widthBins: width,
    gap: settings.binGap,
  });
  const deposit = oneSidedDeposit(snap, toSide);
  if ((toSide === "ask" && deposit.x === 0n) || (toSide === "bid" && deposit.y === 0n)) {
    return { decision: { type: "blocked", reason: "token yang mau dideposit kosong" }, cycle, advisories };
  }
  const plan: FlipPlan = {
    fromSide: cycle.side,
    toSide,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    widthBins: width,
    gap: Math.max(1, settings.binGap),
    depositX: deposit.x,
    depositY: deposit.y,
    partial: false,
    closeAfter: true,
    reason:
      toSide === "ask"
        ? `bid ke-fill (${positionWidth(snap.lowerBinId, snap.upperBinId)} bin). Claim fee, tutup, buka ask BidAsk selebar itu di atas harga.`
        : `ask ke-fill (${positionWidth(snap.lowerBinId, snap.upperBinId)} bin). Claim fee, tutup, buka bid BidAsk selebar itu di bawah harga.`,
  };
  return { decision: { type: "flip", plan }, cycle, advisories };
}

function chunkPlan(
  snap: PositionSnapshot,
  side: Side,
  chunk: { removeFromBin: number; removeToBin: number; nextAnchor: number; width: number },
): FlipPlan | null {
  const toSide = side === "bid" ? "ask" : "bid";
  const inBins = amountInBins(snap.binBalances, chunk.removeFromBin, chunk.removeToBin);
  const depositX = toSide === "ask" ? inBins.x + snap.feeX : 0n;
  const depositY = toSide === "bid" ? inBins.y + snap.feeY : 0n;
  if ((toSide === "ask" && depositX === 0n) || (toSide === "bid" && depositY === 0n)) return null;
  const range = computeFlipRange({
    activeBinId: snap.activeBinId,
    toSide,
    widthBins: chunk.width,
    gap: 1,
  });
  return {
    fromSide: side,
    toSide,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    widthBins: chunk.width,
    gap: 1,
    depositX,
    depositY,
    partial: true,
    closeAfter: false,
    removeFromBin: chunk.removeFromBin,
    removeToBin: chunk.removeToBin,
    nextAnchorBin: chunk.nextAnchor,
    reason: `gradual ${chunk.width} bin (${chunk.removeFromBin}–${chunk.removeToBin}), sisa posisi tetap.`,
  };
}

function holdReason(snap: PositionSnapshot, side: Side): string {
  if (snap.activeBinId < snap.lowerBinId) return `${side} istirahat di atas harga`;
  if (snap.activeBinId > snap.upperBinId) return `${side} istirahat di bawah harga`;
  return `${side} masih di dalam range`;
}

export function forceFlipPlan(snap: PositionSnapshot, side: Side, settings: Settings): FlipPlan {
  const toSide = side === "bid" ? "ask" : "bid";
  const width = reopenWidth(snap.lowerBinId, snap.upperBinId, settings);
  const range = computeFlipRange({
    activeBinId: snap.activeBinId,
    toSide,
    widthBins: width,
    gap: settings.binGap,
  });
  const deposit = oneSidedDeposit(snap, toSide);
  return {
    fromSide: side,
    toSide,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    widthBins: width,
    gap: Math.max(1, settings.binGap),
    depositX: deposit.x,
    depositY: deposit.y,
    partial: false,
    closeAfter: true,
    reason: "flip manual (--force)",
  };
}

export function recenterAskPlan(snap: PositionSnapshot, settings: Settings): FlipPlan {
  const width = reopenWidth(snap.lowerBinId, snap.upperBinId, settings);
  const range = computeFlipRange({
    activeBinId: snap.activeBinId,
    toSide: "ask",
    widthBins: width,
    gap: settings.binGap,
  });
  const deposit = oneSidedDeposit(snap, "ask");
  return {
    fromSide: "ask",
    toSide: "ask",
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    widthBins: width,
    gap: Math.max(1, settings.binGap),
    depositX: deposit.x,
    depositY: deposit.y,
    partial: false,
    closeAfter: true,
    reason: `re-center ask, lebar tetap ${width} bin`,
  };
}
