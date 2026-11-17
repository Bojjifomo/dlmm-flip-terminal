import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  emptyState,
  type BotState,
  type Cycle,
  type PendingAction,
  type PersistedCycle,
} from "../domain";

export function loadState(path: string): BotState {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BotState>;
  const base = emptyState();
  return {
    ...base,
    ...parsed,
    version: 1,
    cycles: parsed.cycles ?? {},
    positionIndex: parsed.positionIndex ?? {},
    pending: parsed.pending ?? {},
    flips: parsed.flips ?? [],
    paused: parsed.paused ?? {},
    manual: parsed.manual ?? {},
    botOpened: parsed.botOpened ?? {},
    notifiedErrors: parsed.notifiedErrors ?? {},
  };
}

export function saveState(path: string, state: BotState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function cycleToPersisted(cycle: Cycle): PersistedCycle {
  return {
    ...cycle,
    costBasisQuote: cycle.costBasisQuote.toString(),
    claimedFeesQuote: cycle.claimedFeesQuote.toString(),
    feeBaselineQuote: cycle.feeBaselineQuote.toString(),
  };
}

export function cycleFromPersisted(raw: PersistedCycle): Cycle {
  return {
    ...raw,
    members: raw.members?.length ? raw.members : [raw.position],
    costBasisQuote: BigInt(raw.costBasisQuote),
    claimedFeesQuote: BigInt(raw.claimedFeesQuote),
    feeBaselineQuote: BigInt(raw.feeBaselineQuote),
    openedByBot: raw.openedByBot ?? false,
    askOorSinceMs: raw.askOorSinceMs ?? null,
    staleAskNotified: raw.staleAskNotified ?? false,
    staleAskSnoozeUntilMs: raw.staleAskSnoozeUntilMs ?? null,
    gradualAnchorBin: raw.gradualAnchorBin ?? null,
  };
}

export function indexCycle(state: BotState, cycle: Cycle): void {
  state.cycles[cycle.cycleId] = cycleToPersisted(cycle);
  for (const member of cycle.members) state.positionIndex[member] = cycle.cycleId;
  state.positionIndex[cycle.position] = cycle.cycleId;
}

export function findCycle(state: BotState, position: string): Cycle | null {
  const id = state.positionIndex[position];
  const raw = id ? state.cycles[id] : undefined;
  return raw ? cycleFromPersisted(raw) : null;
}

export function flipsSince(state: BotState, pool: string, nowMs: number): number {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  return state.flips.filter((f) => f.pool === pool && f.atMs >= cutoff && f.kind === "flip").length;
}

export function pruneFlips(state: BotState, nowMs: number): void {
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  state.flips = state.flips.filter((f) => f.atMs >= cutoff);
}

export function publicPending(pending: PendingAction): Omit<PendingAction, "positionSecret"> {
  const copy = { ...pending };
  delete copy.positionSecret;
  return copy;
}
