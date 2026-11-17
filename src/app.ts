import { config as loadDotenv } from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig, settingsFor, type AppConfig } from "./config";
import { progressPending } from "./chain/executor";
import { readPositions, type ReadResult } from "./chain/reader";
import { evaluate, forceFlipPlan, recenterAskPlan } from "./decision/engine";
import { feesQuote } from "./decision/math";
import {
  type BotState,
  type Cycle,
  type Decision,
  type FlipPlan,
  type ManualAction,
  type Mode,
  type PendingAction,
  type PendingKind,
  type PositionSnapshot,
  type TakeProfitPlan,
} from "./domain";
import { formatUnits, jakartaDate, solscanTx } from "./format";
import { log } from "./logger";
import { notify, notifyError, notifyFlipAsk, notifyStaleAsk, pollTelegram } from "./notify/telegram";
import { decisionText, renderPending, renderPlan, renderSnapshot } from "./render";
import {
  acquireLock,
  cycleFromPersisted,
  findCycle,
  flipsSince,
  indexCycle,
  loadState,
  pruneFlips,
  saveState,
} from "./state/store";
import { loadWallet, requireSigner, type WalletRef } from "./wallet";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const BUSY = new Set(["claim", "remove", "close", "open", "swap"]);

export function bootEnv(): void {
  loadDotenv();
}

export function resolveRpc(mode: Mode): string {
  const configured = process.env.RPC_URL?.trim();
  if (configured) return configured;
  if (mode === "auto" || mode === "alert") {
    throw new Error("Mode alert/auto butuh RPC_URL. Pakai Helius atau RPC lain, jangan public mainnet.");
  }
  log.warn(`RPC_URL kosong, dry-run pakai ${PUBLIC_RPC}`);
  return PUBLIC_RPC;
}

export async function showStatus(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const wallet = loadWallet(config.walletPubkey);
  const connection = new Connection(resolveRpc("dry-run"), config.commitment);
  const slot = await connection.getSlot(config.commitment);
  const state = loadState(config.stateFile);
  const read = await readPositions(connection, wallet.pubkey, config);
  console.log(`RPC slot ${slot}`);
  console.log(`wallet ${wallet.pubkey.toBase58()} (${wallet.source})`);
  for (const warning of read.warnings) console.log(`warning  ${warning}`);
  for (const probe of read.probes) {
    console.log(`probe    ${probe.label} bin aktif ${probe.activeBinId} (step ${probe.binStep})`);
  }
  if (read.snapshots.length === 0) {
    console.log("nggak ada posisi DLMM yang diurus.");
    return;
  }
  const now = Date.now();
  for (const snap of read.snapshots) {
    const cycle = findCycle(state, snap.position);
    const settings = settingsFor(config, snap.pool, snap.position);
    const result = evaluate({
      nowMs: now,
      snapshot: snap,
      cycle,
      settings,
      flipsLast24h: flipsSince(state, snap.pool, now),
      pausedReason: state.paused[snap.pool]?.reason ?? null,
      openedHint: Boolean(state.botOpened[snap.position]),
    });
    console.log(renderSnapshot(snap, result.cycle, result.decision, result.advisories));
    console.log("");
  }
}

export async function runBot(configPath: string, modeOverride?: Mode, once = false): Promise<void> {
  const config = loadConfig(configPath);
  const mode = modeOverride ?? config.mode;
  const wallet = loadWallet(config.walletPubkey);
  if (mode !== "dry-run") requireSigner(wallet);
  const release = mode === "dry-run" ? () => undefined : acquireLock(config.stateFile);
  const connection = new Connection(resolveRpc(mode), config.commitment);
  log.info(`run mode=${mode} poll=${config.pollIntervalMs}ms sekali=${once}`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    try {
      await runOnce(config, connection, wallet, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      const state = loadState(config.stateFile);
      await notifyError(state, "loop", `error loop: ${message}`, Date.now()).catch(() => undefined);
      saveState(config.stateFile, state);
    }
    if (once || stopping) break;
    await sleep(config.pollIntervalMs);
  } while (!stopping);
  release();
}

export async function flipPosition(
  configPath: string,
  position: string,
  opts: { dryRun: boolean; force: boolean; now: boolean },
): Promise<void> {
  const config = loadConfig(configPath);
  const mode: Mode = opts.dryRun ? "dry-run" : config.mode;
  const wallet = loadWallet(config.walletPubkey);
  const connection = new Connection(resolveRpc(mode), config.commitment);
  const state = loadState(config.stateFile);
  const read = await readOne(connection, wallet.pubkey, config, position);
  const snap = read.snapshots.find((row) => row.position === position);
  if (!snap) throw new Error(`posisi ${position} nggak ketemu di wallet ini`);
  const settings = settingsFor(config, snap.pool, snap.position);
  const now = Date.now();
  const cycle = findCycle(state, snap.position);
  const tuned = opts.now ? { ...settings, confirmChecks: 1, confirmMinutes: 0 } : settings;
  const result = evaluate({
    nowMs: now,
    snapshot: snap,
    cycle,
    settings: tuned,
    flipsLast24h: flipsSince(state, snap.pool, now),
    pausedReason: state.paused[snap.pool]?.reason ?? null,
  });
  const plan =
    result.decision.type === "flip"
      ? result.decision.plan
      : opts.force && result.cycle
        ? forceFlipPlan(snap, result.cycle.side, settings)
        : null;
  if (!plan) {
    console.log(renderSnapshot(snap, result.cycle, result.decision));
    console.log("belum waktunya flip. Tambah --force kalau lo memang mau paksa.");
    process.exitCode = 2;
    return;
  }
  console.log(renderPlan(snap, { type: "flip", plan }));
  if (mode === "dry-run") {
    console.log("dry-run, nggak ada tx.");
    return;
  }
  if (!result.cycle) return;
  acquireLock(config.stateFile);
  indexCycle(state, result.cycle);
  const pending = makePending("flip", snap, result.cycle, plan, mode === "alert" ? "awaiting_confirm" : "claim", now);
  state.pending[pending.id] = pending;
  saveState(config.stateFile, state);
  if (mode === "alert") {
    await notifyFlipAsk(snap.position, renderPlan(snap, { type: "flip", plan }));
    console.log(`nunggu konfirmasi. Telegram, atau: meteora-flip confirm ${snap.position}`);
    return;
  }
  await drivePending(config, connection, wallet, state, pending);
}

export function setManual(configPath: string, position: string, action: ManualAction): void {
  const config = loadConfig(configPath);
  const state = loadState(config.stateFile);
  state.manual[position] = action;
  saveState(config.stateFile, state);
  console.log(`${action} dicatat untuk ${position}. Loop yang lagi jalan bakal ambil ini.`);
}

export function ackPending(configPath: string, position: string): void {
  const config = loadConfig(configPath);
  const state = loadState(config.stateFile);
  const pending = findPending(state, position);
  if (!pending) throw new Error("nggak ada pending untuk posisi itu");
  if (pending.toPosition) {
    const raw = state.cycles[pending.cycleId];
    if (raw) {
      const cycle = cycleFromPersisted(raw);
      cycle.position = pending.toPosition;
      cycle.members = [pending.toPosition];
      cycle.side = pending.toSide;
      indexCycle(state, cycle);
    }
  }
  delete state.pending[pending.id];
  saveState(config.stateFile, state);
  console.log("pending dihapus. Cek status buat mastiin posisi barunya ke-track.");
}

async function runOnce(
  config: AppConfig,
  connection: Connection,
  wallet: WalletRef,
  mode: Mode,
): Promise<void> {
  const state = loadState(config.stateFile);
  const now = Date.now();
  try {
    await pollTelegram(state);
  } catch (error) {
    log.warn(`telegram poll gagal: ${error instanceof Error ? error.message : error}`);
  }
  await resumePending(config, connection, wallet, state, mode);
  const read = await readPositions(connection, wallet.pubkey, config);
  for (const warning of read.warnings) log.warn(warning);
  for (const probe of read.probes) {
    log.info(`probe ${probe.label} aktif ${probe.activeBinId} step ${probe.binStep}`);
  }
  let busy = Object.values(state.pending).some((pending) => BUSY.has(pending.phase));
  for (const snap of read.snapshots) {
    if (findPending(state, snap.position)) continue;
    const settings = settingsFor(config, snap.pool, snap.position);
    const existing = findCycle(state, snap.position);
    const result = evaluate({
      nowMs: now,
      snapshot: snap,
      cycle: existing,
      settings,
      flipsLast24h: flipsSince(state, snap.pool, now),
      pausedReason: state.paused[snap.pool]?.reason ?? null,
      openedHint: Boolean(state.botOpened[snap.position]),
    });
    if (state.botOpened[snap.position] && result.cycle?.openedByBot) delete state.botOpened[snap.position];
    if (result.cycle) indexCycle(state, result.cycle);
    log.info(`${snap.label} ${snap.position.slice(0, 4)} ${decisionText(result.decision)}`);
    for (const note of result.advisories) {
      log.info(`saran ${snap.label}: ${note}`);
      await notifyError(state, `advice ${snap.pool} ${note}`, `${snap.label}: ${note}`, now);
    }
    const started = await act(config, connection, wallet, state, mode, snap, result.decision, result.cycle, busy, now);
    if (started) busy = true;
  }
  await maybeDaily(state, now);
  pruneFlips(state, now);
  saveState(config.stateFile, state);
}

async function act(
  config: AppConfig,
  connection: Connection,
  wallet: WalletRef,
  state: BotState,
  mode: Mode,
  snap: PositionSnapshot,
  decision: Decision,
  cycle: Cycle | null,
  busy: boolean,
  now: number,
): Promise<boolean> {
  if (decision.type === "pause") {
    if (!state.paused[snap.pool]) {
      state.paused[snap.pool] = { reason: decision.reason, atMs: now };
      await safeNotify(state, `pause ${snap.label}`, `PAUSE ${snap.label}\n${decision.reason}`);
    }
    return false;
  }
  if (decision.type === "take_profit_notice") {
    await safeNotify(
      state,
      `tp ${snap.position}`,
      `TP ${snap.label}\nPnL ${formatUnits(decision.pnlQuote, snap.quoteDecimals)} ${snap.quoteSymbol}, fee ${formatUnits(decision.feesQuote, snap.quoteDecimals)}. Tetap muter.`,
    );
    return false;
  }
  if (decision.type === "blocked") {
    await notifyError(state, `block ${snap.pool}`, `${snap.label}: ${decision.reason}`, now);
    return false;
  }
  if (decision.type === "stale_ask") {
    if (cycle && !cycle.staleAskNotified) {
      cycle.staleAskNotified = true;
      indexCycle(state, cycle);
      const hours = decision.hours.toFixed(1);
      await notifyStaleAsk(
        snap.position,
        `Ask ${snap.label} udah di luar range ${hours} jam, fee nol.\nPilihan: hold / re-center (lebar sama) / cut ke SOL.\nCLI: meteora-flip stale ${snap.position} hold|recenter|cut`,
      );
    }
    return false;
  }
  if ((decision.type === "flip" || decision.type === "take_profit") && mode === "dry-run") {
    if (cycle && !cycle.dryRunAnnounced) {
      cycle.dryRunAnnounced = true;
      indexCycle(state, cycle);
      const text = renderPlan(snap, decision);
      log.info(text);
      await safeNotify(state, `dry ${snap.position}`, `DRY-RUN\n${text}`);
    }
    return false;
  }
  if (!cycle) return false;
  if (decision.type === "flip") {
    if (busy || mode === "dry-run") return false;
    const phase = mode === "alert" ? "awaiting_confirm" : "claim";
    const pending = makePending("flip", snap, cycle, decision.plan, phase, now);
    state.pending[pending.id] = pending;
    saveState(config.stateFile, state);
    if (mode === "alert") {
      await notifyFlipAsk(snap.position, renderPlan(snap, decision));
      pending.notified = true;
      return true;
    }
    await drivePending(config, connection, wallet, state, pending);
    return true;
  }
  if (decision.type === "take_profit") {
    if (busy || mode === "dry-run") return false;
    const phase = mode === "alert" ? "awaiting_confirm" : "claim";
    const pending = makePending("take_profit", snap, cycle, decision.plan, phase, now);
    state.pending[pending.id] = pending;
    saveState(config.stateFile, state);
    if (mode === "alert") {
      await notifyFlipAsk(snap.position, renderPlan(snap, decision));
      return true;
    }
    await drivePending(config, connection, wallet, state, pending);
    return true;
  }
  return false;
}

async function resumePending(
  config: AppConfig,
  connection: Connection,
  wallet: WalletRef,
  state: BotState,
  mode: Mode,
): Promise<void> {
  for (const position of Object.keys(state.manual)) {
    const action = state.manual[position];
    if (action === "hold" || action === "recenter" || action === "cut") {
      delete state.manual[position];
      await applyStaleChoice(config, connection, wallet, state, position, action, mode);
      continue;
    }
    const pending = findPending(state, position);
    delete state.manual[position];
    if (!pending || pending.phase !== "awaiting_confirm") continue;
    if (action === "skip") {
      const cycle = cycleFromPersisted(state.cycles[pending.cycleId]);
      cycle.skipUntilReset = true;
      cycle.confirm = null;
      indexCycle(state, cycle);
      delete state.pending[pending.id];
      await safeNotify(state, `skip ${position}`, `Flip ${position} di-skip. Nunggu harga balik ke range.`);
      continue;
    }
    pending.phase = "claim";
    state.pending[pending.id] = pending;
    saveState(config.stateFile, state);
    if (mode !== "dry-run") await drivePending(config, connection, wallet, state, pending);
  }
  if (mode === "dry-run") return;
  for (const pending of Object.values(state.pending)) {
    if (!BUSY.has(pending.phase)) continue;
    await drivePending(config, connection, wallet, state, pending);
  }
}

async function drivePending(
  config: AppConfig,
  connection: Connection,
  wallet: WalletRef,
  state: BotState,
  pending: PendingAction,
): Promise<void> {
  const owner = requireSigner(wallet);
  const settings = settingsFor(config, pending.pool, pending.fromPosition);
  let current = pending;
  try {
    for (let step = 0; step < 16; step++) {
      if (!BUSY.has(current.phase)) break;
      const signatureBefore = current.signature;
      const phaseBefore = current.phase;
      current = await progressPending({
        connection,
        owner,
        pending: current,
        settings,
        commitment: config.commitment,
        onCheckpoint: (checkpoint) => {
          state.pending[checkpoint.id] = checkpoint;
          saveState(config.stateFile, state);
        },
      });
      applyFees(state, current);
      state.pending[current.id] = current;
      saveState(config.stateFile, state);
      if (current.signature && current.signature === signatureBefore && current.phase === phaseBefore) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    current.lastError = message;
    current.attempts += 1;
    state.pending[current.id] = current;
    saveState(config.stateFile, state);
    log.error(message);
    await notifyError(state, `tx ${current.id}`, `Gagal ${current.kind} ${current.phase}: ${message}`, Date.now());
    saveState(config.stateFile, state);
    return;
  }
  if (current.phase === "needs_human") {
    await safeNotify(state, `human ${current.id}`, `Butuh lo\n${renderPending(current)}`);
    return;
  }
  if (current.phase === "done") {
    finishPending(state, current, Date.now());
    const sig = current.signatures.at(-1);
    const link = sig ? solscanTx(sig) : "";
    await safeNotify(
      state,
      `done ${current.id}`,
      current.kind === "flip"
        ? `Flip kelar ${current.fromSide} -> ${current.toSide}\n${current.toPosition ?? ""}\n${link}`
        : `TP kelar, posisi ditutup ke quote\n${link}`,
    );
  }
}

function finishPending(state: BotState, pending: PendingAction, now: number): void {
  const raw = state.cycles[pending.cycleId];
  if (raw) {
    const cycle = cycleFromPersisted(raw);
    applyFees(state, pending);
    if (pending.partial) {
      cycle.gradualAnchorBin = pending.nextAnchorBin ?? cycle.gradualAnchorBin;
      cycle.confirm = null;
      cycle.dryRunAnnounced = false;
      cycle.skipUntilReset = false;
      if (pending.toPosition) state.botOpened[pending.toPosition] = pending.toSide;
    } else if ((pending.kind === "flip" || pending.kind === "recenter") && pending.toPosition) {
      delete state.positionIndex[pending.fromPosition];
      for (const member of pending.memberPositions) delete state.positionIndex[member];
      cycle.position = pending.toPosition;
      cycle.members = [pending.toPosition];
      cycle.side = pending.toSide;
      cycle.widthBins = pending.widthBins;
      cycle.confirm = null;
      cycle.tpConfirm = null;
      cycle.skipUntilReset = false;
      cycle.dryRunAnnounced = false;
      cycle.openedByBot = true;
      cycle.askOorSinceMs = null;
      cycle.staleAskNotified = false;
      cycle.staleAskSnoozeUntilMs = null;
      cycle.gradualAnchorBin = null;
    }
    if (pending.kind === "take_profit" || pending.kind === "cut") {
      cycle.stopped = true;
      cycle.stopReason = pending.kind === "cut" ? "cut ke SOL" : "take profit, ditutup ke quote";
      cycle.confirm = null;
    }
    indexCycle(state, cycle);
  }
  state.flips.push({
    atMs: now,
    pool: pending.pool,
    fromPosition: pending.fromPosition,
    toPosition: pending.toPosition,
    signature: pending.signatures.at(-1),
    kind: pending.kind,
  });
  delete state.pending[pending.id];
}

function applyFees(state: BotState, pending: PendingAction): void {
  if (!pending.feesAccounted || pending.feeApplied) return;
  const raw = state.cycles[pending.cycleId];
  if (!raw) return;
  const cycle = cycleFromPersisted(raw);
  cycle.claimedFeesQuote += BigInt(pending.claimedFeesQuoteAdded || "0");
  pending.feeApplied = true;
  indexCycle(state, cycle);
}

function makePending(
  kind: PendingKind,
  snap: PositionSnapshot,
  cycle: Cycle,
  plan: FlipPlan | TakeProfitPlan,
  phase: PendingAction["phase"],
  now: number,
): PendingAction {
  const flip = "toSide" in plan ? plan : null;
  const settingsGap = flip?.gap ?? 1;
  return {
    id: `${snap.position}:${now}`,
    kind,
    partial: flip?.partial ?? false,
    closeAfter: flip?.closeAfter !== false,
    removeFromBin: flip?.removeFromBin,
    removeToBin: flip?.removeToBin,
    nextAnchorBin: flip?.nextAnchorBin,
    phase,
    pool: snap.pool,
    fromPosition: snap.position,
    cycleId: cycle.cycleId,
    toSide: flip?.toSide ?? cycle.side,
    fromSide: cycle.side,
    widthBins: flip?.widthBins ?? cycle.widthBins,
    binGap: settingsGap,
    depositX: plan.depositX.toString(),
    depositY: plan.depositY.toString(),
    feeX: snap.feeX.toString(),
    feeY: snap.feeY.toString(),
    claimedFeesQuoteAdded: "0",
    feesAccounted: false,
    quoteIsY: snap.quoteIsY,
    costBasisQuote: cycle.costBasisQuote.toString(),
    signatures: [],
    attempts: 0,
    createdAtMs: now,
    updatedAtMs: now,
    notified: false,
    memberPositions: [...cycle.members],
  };
}

async function maybeDaily(state: BotState, now: number): Promise<void> {
  const today = jakartaDate(now);
  if (!state.lastDailySummaryDate) {
    state.lastDailySummaryDate = today;
    return;
  }
  if (state.lastDailySummaryDate === today) return;
  const lines = [`Ringkasan ${state.lastDailySummaryDate}`];
  const since = now - 24 * 60 * 60 * 1000;
  const flips = state.flips.filter((flip) => flip.atMs >= since);
  lines.push(`flip 24 jam: ${flips.length}`);
  for (const cycle of Object.values(state.cycles)) {
    lines.push(
      `${cycle.side} ${cycle.position.slice(0, 4)} modal ${cycle.costBasisQuote} fee ${cycle.claimedFeesQuote}`,
    );
  }
  state.lastDailySummaryDate = today;
  await safeNotify(state, "daily", lines.join("\n"));
}

async function applyStaleChoice(
  config: AppConfig,
  connection: Connection,
  wallet: WalletRef,
  state: BotState,
  position: string,
  action: "hold" | "recenter" | "cut",
  mode: Mode,
): Promise<void> {
  const raw = Object.values(state.cycles).find((cycle) => cycle.position === position || cycle.members?.includes(position));
  if (!raw) {
    log.warn(`stale ${action} untuk ${position}, tapi siklusnya nggak ketemu`);
    return;
  }
  const cycle = cycleFromPersisted(raw);
  const now = Date.now();
  if (action === "hold") {
    const settings = settingsFor(config, cycle.pool, cycle.position);
    cycle.askOorSinceMs = now;
    cycle.staleAskNotified = false;
    cycle.staleAskSnoozeUntilMs = now + settings.staleAskHours * 3_600_000;
    indexCycle(state, cycle);
    await safeNotify(state, `hold ${position}`, `Ask ${position} di-hold. Nanti diingetin lagi.`);
    return;
  }
  const read = await readPositions(connection, wallet.pubkey, config);
  const snap = read.snapshots.find((row) => row.position === position);
  if (!snap) {
    log.warn(`posisi ${position} nggak kebaca, ${action} ditunda`);
    return;
  }
  const settings = settingsFor(config, snap.pool, snap.position);
  if (mode === "dry-run") {
    log.info(`dry-run ${action} ${position}`);
    return;
  }
  if (action === "recenter") {
    const plan = recenterAskPlan(snap, settings);
    const pending = makePending("recenter", snap, cycle, plan, "claim", now);
    state.pending[pending.id] = pending;
    saveState(config.stateFile, state);
    await drivePending(config, connection, wallet, state, pending);
    return;
  }
  const pending = makePending(
    "cut",
    snap,
    cycle,
    {
      pnlQuote: 0n,
      feesQuote: 0n,
      principalQuote: 0n,
      costBasisQuote: cycle.costBasisQuote,
      depositX: snap.amountX + snap.feeX,
      depositY: snap.amountY + snap.feeY,
    },
    "claim",
    now,
  );
  state.pending[pending.id] = pending;
  saveState(config.stateFile, state);
  await drivePending(config, connection, wallet, state, pending);
}

async function safeNotify(state: BotState, key: string, text: string): Promise<void> {
  try {
    await notify(text);
  } catch (error) {
    log.warn(`notify gagal ${key}: ${error instanceof Error ? error.message : error}`);
  }
}

function findPending(state: BotState, position: string): PendingAction | undefined {
  return Object.values(state.pending).find(
    (pending) =>
      pending.fromPosition === position ||
      pending.toPosition === position ||
      pending.memberPositions.includes(position) ||
      pending.id === position,
  );
}

async function readOne(
  connection: Connection,
  owner: PublicKey,
  config: AppConfig,
  position: string,
): Promise<ReadResult> {
  const narrowed: AppConfig = {
    ...config,
    watch: "selected",
    positions: config.positions.some((row) => row.position === position)
      ? config.positions.filter((row) => row.position === position)
      : config.positions,
    pools: config.pools,
  };
  const read = await readPositions(connection, owner, narrowed);
  if (!read.snapshots.some((snap) => snap.position === position)) {
    return readPositions(connection, owner, { ...config, watch: "all", pools: [], positions: [] });
  }
  return read;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function previewFees(snap: PositionSnapshot): bigint {
  return feesQuote(snap);
}
