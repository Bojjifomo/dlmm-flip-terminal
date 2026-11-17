import type { Cycle, Decision, PendingAction, PositionSnapshot } from "./domain";
import { compositionOf, feesQuote } from "./decision/math";
import { formatUnits, shortPk, solscanAccount, solscanTx } from "./format";

export function renderSnapshot(
  snap: PositionSnapshot,
  cycle: Cycle | null,
  decision?: Decision,
  advisories: string[] = [],
): string {
  const comp = compositionOf(snap);
  const unclaimed = feesQuote(snap);
  const claimed = cycle?.claimedFeesQuote ?? 0n;
  const baseline = cycle?.feeBaselineQuote ?? unclaimed;
  const fees = unclaimed + claimed - baseline;
  const equity = comp.principalQuote + unclaimed + claimed;
  const cost = cycle?.costBasisQuote ?? comp.principalQuote;
  const pnl = equity - cost;
  const where =
    snap.activeBinId < snap.lowerBinId
      ? "di atas range"
      : snap.activeBinId > snap.upperBinId
        ? "di bawah range"
        : "di dalam range";
  const lines = [
    `${snap.label}  ${shortPk(snap.position)}`,
    `  pool     ${shortPk(snap.pool, 6)}  ${solscanAccount(snap.pool)}`,
    `  sisi     ${cycle?.side ?? "belum diadopsi"} (${snap.quoteSymbol} = quote)`,
    `  bin      aktif ${snap.activeBinId}   range ${snap.lowerBinId}–${snap.upperBinId}  ${where}`,
    `  isi      base ${comp.baseBps / 100}%   quote ${comp.quoteBps / 100}%`,
    `  nilai    ${formatUnits(comp.principalQuote, snap.quoteDecimals)} ${snap.quoteSymbol}`,
    `  modal    ${formatUnits(cost, snap.quoteDecimals)} ${snap.quoteSymbol}`,
    `  fee      ${formatUnits(fees, snap.quoteDecimals)} ${snap.quoteSymbol}`,
    `  uPnL     ${signed(pnl, snap.quoteDecimals)} ${snap.quoteSymbol}`,
  ];
  if (snap.fees24hUsd != null && snap.poolTvlUsd) {
    lines.push(`  fee/TVL  ${((snap.fees24hUsd / snap.poolTvlUsd) * 100).toFixed(1)}% (24h)`);
  }
  if (decision) lines.push(`  rencana  ${decisionText(decision)}`);
  if (!snap.manageable && snap.blockReason) lines.push(`  skip     ${snap.blockReason}`);
  for (const note of advisories) lines.push(`  saran    ${note}`);
  return lines.join("\n");
}

export function decisionText(decision: Decision): string {
  switch (decision.type) {
    case "hold":
      return decision.reason;
    case "confirming":
      return `konfirmasi ${decision.direction} ${decision.checks}/${decision.needChecks}, ${Math.floor(decision.elapsedMs / 1000)}s/${Math.floor(decision.needMs / 1000)}s`;
    case "flip":
      return `${decision.plan.reason} range ${decision.plan.minBinId}–${decision.plan.maxBinId} (${decision.plan.widthBins} bin)`;
    case "take_profit":
      return `TP close, pnl ${decision.plan.pnlQuote} fee ${decision.plan.feesQuote}`;
    case "take_profit_notice":
      return "TP kena, tetap muter (keep_cycling)";
    case "pause":
      return `pause: ${decision.reason}`;
    case "blocked":
      return `blokir: ${decision.reason}`;
    case "stopped":
      return decision.reason;
    case "skip":
      return decision.reason;
    case "stale_ask":
      return `ask nyangkut ${decision.hours.toFixed(1)} jam di luar range. Pilihan: hold / recenter / cut`;
  }
}

export function renderPlan(snap: PositionSnapshot, decision: Decision): string {
  if (decision.type === "flip") {
    const plan = decision.plan;
    return [
      `FLIP ${snap.label} ${shortPk(snap.position)}`,
      `${plan.fromSide} -> ${plan.toSide}`,
      `range baru ${plan.minBinId}–${plan.maxBinId} (${plan.widthBins} bin, gap ${plan.gap})`,
      `deposit X ${plan.depositX}  Y ${plan.depositY}`,
      plan.reason,
    ].join("\n");
  }
  if (decision.type === "take_profit") {
    return `TP ${snap.label} ${shortPk(snap.position)}\n${decisionText(decision)}`;
  }
  return decisionText(decision);
}

export function renderPending(pending: PendingAction): string {
  const sig = pending.signatures.at(-1);
  return [
    `pending ${pending.kind} ${pending.phase} ${shortPk(pending.fromPosition)}`,
    pending.toPosition ? `posisi baru ${pending.toPosition}` : "",
    sig ? solscanTx(sig) : "",
    pending.lastError ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function signed(amount: bigint, decimals: number): string {
  const text = formatUnits(amount, decimals);
  return amount > 0n ? `+${text}` : text;
}
