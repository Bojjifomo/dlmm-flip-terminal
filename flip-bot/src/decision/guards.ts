import {
  PREFERRED_BIN_STEPS,
  type BinBalance,
  type PositionSnapshot,
  type Settings,
  type Side,
} from "../domain";
import { capBins, positionWidth } from "./defaults";

export function feeTvlRatio(fees24hUsd: number | null, tvlUsd: number | null): number | null {
  if (fees24hUsd == null || tvlUsd == null || tvlUsd <= 0) return null;
  return fees24hUsd / tvlUsd;
}

export function isMidRange(activeBinId: number, lowerBinId: number, upperBinId: number): boolean {
  if (activeBinId <= lowerBinId || activeBinId >= upperBinId) return false;
  const width = upperBinId - lowerBinId + 1;
  const margin = Math.max(1, Math.floor(width * 0.25));
  return activeBinId >= lowerBinId + margin && activeBinId <= upperBinId - margin;
}

export function binStepAdvisory(binStep: number): string | null {
  if ((PREFERRED_BIN_STEPS as readonly number[]).includes(binStep)) return null;
  return `bin step ${binStep} bukan 80/100. Bid-ask flip paling enak di step 80 atau 100.`;
}

export function reopenWidth(
  lowerBinId: number,
  upperBinId: number,
  settings: Pick<Settings, "rangeWidthBins" | "freshRangeBins" | "maxBinsPerPosition">,
): number {
  if (settings.rangeWidthBins != null) return capBins(settings.rangeWidthBins, settings.maxBinsPerPosition);
  const current = positionWidth(lowerBinId, upperBinId);
  return capBins(current > 0 ? current : settings.freshRangeBins, settings.maxBinsPerPosition);
}

export interface GradualSlice {
  removeFromBin: number;
  removeToBin: number;
  nextAnchor: number;
  width: number;
}

export function gradualSlice(args: {
  side: Side;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  anchorBin: number | null;
  chunkBins: number;
}): GradualSlice | null {
  const chunk = Math.max(1, Math.floor(args.chunkBins));
  if (args.side === "bid") {
    if (args.activeBinId < args.lowerBinId) return null;
    const anchor = args.anchorBin ?? args.upperBinId;
    if (args.activeBinId > anchor - chunk) return null;
    const removeToBin = anchor;
    const removeFromBin = Math.max(args.lowerBinId, anchor - chunk + 1);
    if (removeFromBin <= args.activeBinId || removeToBin < removeFromBin) return null;
    const width = removeToBin - removeFromBin + 1;
    return { removeFromBin, removeToBin, nextAnchor: removeFromBin - 1, width };
  }
  if (args.activeBinId > args.upperBinId) return null;
  const anchor = args.anchorBin ?? args.lowerBinId;
  if (args.activeBinId < anchor + chunk) return null;
  const removeFromBin = anchor;
  const removeToBin = Math.min(args.upperBinId, anchor + chunk - 1);
  if (removeToBin >= args.activeBinId || removeToBin < removeFromBin) return null;
  const width = removeToBin - removeFromBin + 1;
  return { removeFromBin, removeToBin, nextAnchor: removeToBin + 1, width };
}

export function amountInBins(
  bins: BinBalance[],
  fromBin: number,
  toBin: number,
): { x: bigint; y: bigint } {
  let x = 0n;
  let y = 0n;
  for (const bin of bins) {
    if (bin.binId < fromBin || bin.binId > toBin) continue;
    x += bin.amountX;
    y += bin.amountY;
  }
  return { x, y };
}

export function poolAdvisories(
  snap: Pick<
    PositionSnapshot,
    | "binStep"
    | "poolTvlUsd"
    | "fees24hUsd"
    | "activeBinId"
    | "lowerBinId"
    | "upperBinId"
    | "baseMarketCapUsd"
    | "pairCreatedAtMs"
    | "priceUsd"
    | "athUsd"
    | "label"
  >,
  settings: Pick<
    Settings,
    | "minFeeTvl"
    | "feeTvlAction"
    | "highTvlWarnUsd"
    | "minMarketCapUsd"
    | "minPairAgeDays"
    | "nearAthDrawdownPct"
  >,
  nowMs: number,
): { notes: string[]; pauseFeeTvl: boolean } {
  const notes: string[] = [];
  const step = binStepAdvisory(snap.binStep);
  if (step) notes.push(step);
  if (snap.poolTvlUsd != null && snap.poolTvlUsd > settings.highTvlWarnUsd) {
    notes.push(`TVL $${Math.round(snap.poolTvlUsd).toLocaleString("en-US")} di atas $${Math.round(settings.highTvlWarnUsd).toLocaleString("en-US")}. Fee share lo lebih kecil.`);
  }
  const ratio = feeTvlRatio(snap.fees24hUsd, snap.poolTvlUsd);
  let pauseFeeTvl = false;
  if (
    ratio != null &&
    settings.minFeeTvl > 0 &&
    ratio < settings.minFeeTvl &&
    isMidRange(snap.activeBinId, snap.lowerBinId, snap.upperBinId)
  ) {
    const line = `fee/TVL 24h ${(ratio * 100).toFixed(1)}% di bawah ${(settings.minFeeTvl * 100).toFixed(0)}% pas harga di tengah range.`;
    notes.push(line);
    if (settings.feeTvlAction === "pause") pauseFeeTvl = true;
  }
  if (snap.baseMarketCapUsd != null && snap.baseMarketCapUsd < settings.minMarketCapUsd) {
    notes.push(`mcap $${Math.round(snap.baseMarketCapUsd).toLocaleString("en-US")} di bawah $${Math.round(settings.minMarketCapUsd).toLocaleString("en-US")}.`);
  }
  if (snap.pairCreatedAtMs != null) {
    const days = (nowMs - snap.pairCreatedAtMs) / 86_400_000;
    if (days < settings.minPairAgeDays) {
      notes.push(`umur pool ${days.toFixed(1)} hari, di bawah ${settings.minPairAgeDays} hari.`);
    }
  }
  if (snap.priceUsd != null && snap.athUsd != null && snap.athUsd > 0) {
    const drawdownPct = (1 - snap.priceUsd / snap.athUsd) * 100;
    if (drawdownPct > settings.nearAthDrawdownPct) {
      notes.push(`harga jauh dari ATH (turun ${drawdownPct.toFixed(0)}%, batas ${settings.nearAthDrawdownPct}%).`);
    }
  }
  return { notes, pauseFeeTvl };
}

export function staleAskHours(
  cycle: { openedByBot: boolean; side: Side; askOorSinceMs: number | null; staleAskSnoozeUntilMs: number | null },
  snap: Pick<PositionSnapshot, "activeBinId" | "lowerBinId">,
  nowMs: number,
  staleHours: number,
): { sinceMs: number | null; due: boolean; hours: number } {
  const oor = cycle.openedByBot && cycle.side === "ask" && snap.activeBinId < snap.lowerBinId;
  if (!oor) return { sinceMs: null, due: false, hours: 0 };
  const sinceMs = cycle.askOorSinceMs ?? nowMs;
  const hours = (nowMs - sinceMs) / 3_600_000;
  const snooze = cycle.staleAskSnoozeUntilMs ?? 0;
  const due = hours >= staleHours && nowMs >= snooze;
  return { sinceMs, due, hours };
}
