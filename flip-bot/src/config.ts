import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  POSITION_MAX_BINS,
  type Mode,
  type Settings,
  type Side,
} from "./domain";
import { defaultSettings } from "./decision/defaults";

export interface PoolRef {
  address: string;
  settings: Partial<Settings>;
}

export interface PositionRef {
  position: string;
  pool?: string;
  settings: Partial<Settings>;
}

export interface AppConfig {
  walletPubkey?: string;
  mode: Mode;
  pollIntervalMs: number;
  stateFile: string;
  commitment: "processed" | "confirmed" | "finalized";
  watch: "all" | "selected";
  pools: PoolRef[];
  positions: PositionRef[];
  excludePositions: string[];
  probePools: string[];
  defaults: Settings;
}

const MODES = new Set<Mode>(["dry-run", "alert", "auto"]);

export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) {
    throw new Error(
      `config nggak ketemu: ${path}\nCopy config/sample.config.yaml jadi config.yaml terus isi wallet lo.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const doc = path.endsWith(".json")
    ? (JSON.parse(raw) as unknown)
    : (parseYaml(raw) as unknown);
  if (!doc || typeof doc !== "object") throw new Error("config kosong");
  return normalize(doc as Record<string, unknown>);
}

function normalize(doc: Record<string, unknown>): AppConfig {
  const defaults = applySettings(defaultSettings(), asRecord(doc.defaults), "defaults");
  const mode = asMode(doc.mode ?? "dry-run");
  const pools = asList(doc.pools).map((item, i) => parsePool(item, i));
  const positions = asList(doc.positions).map((item, i) => parsePosition(item, i));
  const watch = doc.watch === "selected" ? "selected" : "all";
  if (watch === "selected" && pools.length === 0 && positions.length === 0) {
    throw new Error("watch: selected tapi pools dan positions kosong");
  }
  return {
    walletPubkey: optionalString(doc.walletPubkey),
    mode,
    pollIntervalMs: asInt(doc.pollIntervalMs, 20_000, "pollIntervalMs"),
    stateFile: optionalString(doc.stateFile) ?? ".state/bot-state.json",
    commitment:
      doc.commitment === "processed" || doc.commitment === "finalized"
        ? doc.commitment
        : "confirmed",
    watch,
    pools,
    positions,
    excludePositions: asList(doc.excludePositions).map((v, i) => asString(v, `excludePositions[${i}]`)),
    probePools: asList(doc.probePools).map((v, i) => asString(v, `probePools[${i}]`)),
    defaults,
  };
}

export function settingsFor(config: AppConfig, pool: string, position: string): Settings {
  const poolHit = config.pools.find((p) => p.address === pool)?.settings ?? {};
  const posHit = config.positions.find((p) => p.position === position)?.settings ?? {};
  return { ...config.defaults, ...poolHit, ...posHit };
}

function parsePool(item: unknown, index: number): PoolRef {
  if (typeof item === "string") return { address: item, settings: {} };
  const rec = asRecord(item, `pools[${index}]`);
  if (!rec) throw new Error(`pools[${index}] kosong`);
  const address = asString(rec.address ?? rec.pool, `pools[${index}].address`);
  return { address, settings: pickSettings(rec, `pools[${index}]`) };
}

function parsePosition(item: unknown, index: number): PositionRef {
  const rec = asRecord(item, `positions[${index}]`);
  if (!rec) throw new Error(`positions[${index}] kosong`);
  return {
    position: asString(rec.position, `positions[${index}].position`),
    pool: optionalString(rec.pool),
    settings: pickSettings(rec, `positions[${index}]`),
  };
}

function applySettings(base: Settings, patch: Record<string, unknown> | null, where: string): Settings {
  if (!patch) return base;
  return { ...base, ...pickSettings(patch, where) };
}

function pickSettings(rec: Record<string, unknown>, where: string): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (rec.rangeWidthBins === null) out.rangeWidthBins = null;
  else if (rec.rangeWidthBins !== undefined) {
    out.rangeWidthBins = asInt(rec.rangeWidthBins, 0, `${where}.rangeWidthBins`);
  }
  if (rec.maxBinsPerPosition !== undefined) {
    out.maxBinsPerPosition = Math.min(
      POSITION_MAX_BINS,
      asInt(rec.maxBinsPerPosition, 1, `${where}.maxBinsPerPosition`),
    );
  }
  if (rec.binGap !== undefined) out.binGap = Math.max(1, asInt(rec.binGap, 1, `${where}.binGap`));
  if (rec.confirmMinutes !== undefined) out.confirmMinutes = asInt(rec.confirmMinutes, 0, `${where}.confirmMinutes`);
  if (rec.confirmChecks !== undefined) out.confirmChecks = Math.max(1, asInt(rec.confirmChecks, 1, `${where}.confirmChecks`));
  if (rec.slippageBps !== undefined) out.slippageBps = asInt(rec.slippageBps, 0, `${where}.slippageBps`);
  if (rec.priorityFeeMicroLamports !== undefined) {
    out.priorityFeeMicroLamports = asInt(rec.priorityFeeMicroLamports, 0, `${where}.priorityFeeMicroLamports`);
  }
  if (rec.computeUnitLimit !== undefined) out.computeUnitLimit = asInt(rec.computeUnitLimit, 200_000, `${where}.computeUnitLimit`);
  if (rec.maxFlipsPer24h !== undefined) out.maxFlipsPer24h = asInt(rec.maxFlipsPer24h, 0, `${where}.maxFlipsPer24h`);
  if (rec.minSolReserveLamports !== undefined) out.minSolReserveLamports = asBigint(rec.minSolReserveLamports, `${where}.minSolReserveLamports`);
  if (rec.fullBaseBps !== undefined) out.fullBaseBps = asInt(rec.fullBaseBps, 0, `${where}.fullBaseBps`);
  if (rec.fullQuoteBps !== undefined) out.fullQuoteBps = asInt(rec.fullQuoteBps, 0, `${where}.fullQuoteBps`);
  if (rec.tpMode !== undefined) {
    if (rec.tpMode !== "close" && rec.tpMode !== "keep_cycling") {
      throw new Error(`${where}.tpMode harus close atau keep_cycling`);
    }
    out.tpMode = rec.tpMode;
  }
  if (rec.tpBufferLamports !== undefined) out.tpBufferLamports = asBigint(rec.tpBufferLamports, `${where}.tpBufferLamports`);
  if (rec.tpBufferBps !== undefined) out.tpBufferBps = asInt(rec.tpBufferBps, 0, `${where}.tpBufferBps`);
  if (rec.tpDrawdownArmBps !== undefined) out.tpDrawdownArmBps = asInt(rec.tpDrawdownArmBps, 0, `${where}.tpDrawdownArmBps`);
  if (rec.tpConfirmChecks !== undefined) out.tpConfirmChecks = Math.max(1, asInt(rec.tpConfirmChecks, 1, `${where}.tpConfirmChecks`));
  if (rec.adoptOutOfRange !== undefined) {
    if (rec.adoptOutOfRange !== "resting" && rec.adoptOutOfRange !== "filled") {
      throw new Error(`${where}.adoptOutOfRange harus resting atau filled`);
    }
    out.adoptOutOfRange = rec.adoptOutOfRange;
  }
  if (rec.initialSide !== undefined) {
    if (rec.initialSide !== "auto" && rec.initialSide !== "bid" && rec.initialSide !== "ask") {
      throw new Error(`${where}.initialSide harus auto, bid, atau ask`);
    }
    out.initialSide = rec.initialSide as Side | "auto";
  }
  if (rec.maxDropBelowAskBottomPct !== undefined) {
    out.maxDropBelowAskBottomPct = asNumber(rec.maxDropBelowAskBottomPct, `${where}.maxDropBelowAskBottomPct`);
  }
  if (rec.minPoolTvlUsd !== undefined) out.minPoolTvlUsd = asNumber(rec.minPoolTvlUsd, `${where}.minPoolTvlUsd`);
  if (rec.minVolume24hUsd !== undefined) out.minVolume24hUsd = asNumber(rec.minVolume24hUsd, `${where}.minVolume24hUsd`);
  if (rec.metricsFailClosed !== undefined) out.metricsFailClosed = Boolean(rec.metricsFailClosed);
  if (rec.quoteMint !== undefined) out.quoteMint = rec.quoteMint === null ? null : asString(rec.quoteMint, `${where}.quoteMint`);
  if (rec.allowInvertedQuote !== undefined) out.allowInvertedQuote = Boolean(rec.allowInvertedQuote);
  if (rec.sendMaxAttempts !== undefined) out.sendMaxAttempts = Math.max(1, asInt(rec.sendMaxAttempts, 1, `${where}.sendMaxAttempts`));
  if (rec.freshRangeBins !== undefined) out.freshRangeBins = Math.max(1, asInt(rec.freshRangeBins, 70, `${where}.freshRangeBins`));
  if (rec.gradualFlip !== undefined) out.gradualFlip = Boolean(rec.gradualFlip);
  if (rec.gradualFlipBins !== undefined) out.gradualFlipBins = Math.max(1, asInt(rec.gradualFlipBins, 20, `${where}.gradualFlipBins`));
  if (rec.minFeeTvl !== undefined) out.minFeeTvl = asNumber(rec.minFeeTvl, `${where}.minFeeTvl`);
  if (rec.feeTvlAction !== undefined) {
    if (rec.feeTvlAction !== "alert" && rec.feeTvlAction !== "pause") {
      throw new Error(`${where}.feeTvlAction harus alert atau pause`);
    }
    out.feeTvlAction = rec.feeTvlAction;
  }
  if (rec.highTvlWarnUsd !== undefined) out.highTvlWarnUsd = asNumber(rec.highTvlWarnUsd, `${where}.highTvlWarnUsd`);
  if (rec.staleAskHours !== undefined) out.staleAskHours = asNumber(rec.staleAskHours, `${where}.staleAskHours`);
  if (rec.skipTransferFee !== undefined) out.skipTransferFee = Boolean(rec.skipTransferFee);
  if (rec.minMarketCapUsd !== undefined) out.minMarketCapUsd = asNumber(rec.minMarketCapUsd, `${where}.minMarketCapUsd`);
  if (rec.minPairAgeDays !== undefined) out.minPairAgeDays = asNumber(rec.minPairAgeDays, `${where}.minPairAgeDays`);
  if (rec.nearAthDrawdownPct !== undefined) out.nearAthDrawdownPct = asNumber(rec.nearAthDrawdownPct, `${where}.nearAthDrawdownPct`);
  return out;
}

function asMode(value: unknown): Mode {
  if (typeof value !== "string" || !MODES.has(value as Mode)) {
    throw new Error("mode harus dry-run, alert, atau auto");
  }
  return value as Mode;
}

function asRecord(value: unknown, where = "config"): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} harus object`);
  return value as Record<string, unknown>;
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("harus list");
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} harus string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("harus string");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asInt(value: unknown, fallback: number, where: string): number {
  const n = asNumber(value ?? fallback, where);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${where} harus angka >= 0`);
  return Math.floor(n);
}

function asNumber(value: unknown, where: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  throw new Error(`${where} harus angka`);
}

function asBigint(value: unknown, where: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${where} kepanjangan, tulis sebagai string`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${where} harus integer`);
}
