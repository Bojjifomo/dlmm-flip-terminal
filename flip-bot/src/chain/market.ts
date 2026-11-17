import { WSOL_MINT } from "../domain";

export interface PoolStats {
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  name?: string;
  createdAtMs: number | null;
  baseMarketCapUsd: number | null;
  priceUsd: number | null;
  athUsd: number | null;
}

export function emptyStats(): PoolStats {
  return {
    tvlUsd: null,
    volume24hUsd: null,
    fees24hUsd: null,
    createdAtMs: null,
    baseMarketCapUsd: null,
    priceUsd: null,
    athUsd: null,
  };
}

export function parseMeteoraPool(body: unknown, baseMint?: string): PoolStats {
  const stats = emptyStats();
  if (!body || typeof body !== "object") return stats;
  const rec = body as Record<string, unknown>;
  stats.tvlUsd = numberField(rec.tvl);
  stats.volume24hUsd = volumeField(rec);
  stats.fees24hUsd = feeField(rec);
  stats.name = typeof rec.name === "string" ? rec.name : undefined;
  stats.createdAtMs = timeField(rec.created_at ?? rec.createdAt);
  const tokenX = tokenStats(rec.token_x ?? rec.tokenX);
  const tokenY = tokenStats(rec.token_y ?? rec.tokenY);
  const base =
    baseMint && tokenX.mint === baseMint ? tokenX : baseMint && tokenY.mint === baseMint ? tokenY : pickBase(tokenX, tokenY);
  stats.baseMarketCapUsd = base.marketCapUsd;
  stats.priceUsd = base.priceUsd;
  stats.athUsd = base.athUsd ?? findAth(rec);
  return stats;
}

export function parseDexScreener(body: unknown): Partial<PoolStats> {
  if (!body || typeof body !== "object") return {};
  const pairs = (body as { pairs?: unknown; pair?: unknown }).pairs;
  const list = Array.isArray(pairs) ? pairs : (body as { pair?: unknown }).pair ? [(body as { pair: unknown }).pair] : [];
  const pair = list.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  if (!pair) return {};
  return {
    baseMarketCapUsd: numberField(pair.marketCap) ?? numberField(pair.fdv),
    priceUsd: numberField(pair.priceUsd),
    createdAtMs: timeField(pair.pairCreatedAt),
    athUsd: findAth(pair),
    volume24hUsd: volumeField(pair),
  };
}

export async function fetchDexScreener(pool: string): Promise<Partial<PoolStats>> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, {
      headers: { accept: "application/json", "user-agent": "meteora-bidask-flip" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return {};
    return parseDexScreener(await res.json());
  } catch {
    return {};
  }
}

export function mergeStats(primary: PoolStats, extra: Partial<PoolStats>): PoolStats {
  return {
    tvlUsd: primary.tvlUsd ?? extra.tvlUsd ?? null,
    volume24hUsd: primary.volume24hUsd ?? extra.volume24hUsd ?? null,
    fees24hUsd: primary.fees24hUsd ?? extra.fees24hUsd ?? null,
    name: primary.name ?? extra.name,
    createdAtMs: primary.createdAtMs ?? extra.createdAtMs ?? null,
    baseMarketCapUsd: primary.baseMarketCapUsd ?? extra.baseMarketCapUsd ?? null,
    priceUsd: primary.priceUsd ?? extra.priceUsd ?? null,
    athUsd: primary.athUsd ?? extra.athUsd ?? null,
  };
}

function pickBase(tokenX: TokenStats, tokenY: TokenStats): TokenStats {
  if (tokenY.mint === WSOL_MINT) return tokenX;
  if (tokenX.mint === WSOL_MINT) return tokenY;
  return tokenX.marketCapUsd != null ? tokenX : tokenY;
}

interface TokenStats {
  mint?: string;
  marketCapUsd: number | null;
  priceUsd: number | null;
  athUsd: number | null;
}

function tokenStats(value: unknown): TokenStats {
  if (!value || typeof value !== "object") return { marketCapUsd: null, priceUsd: null, athUsd: null };
  const rec = value as Record<string, unknown>;
  return {
    mint: typeof rec.address === "string" ? rec.address : typeof rec.mint === "string" ? rec.mint : undefined,
    marketCapUsd: numberField(rec.market_cap ?? rec.marketCap),
    priceUsd: numberField(rec.price ?? rec.price_usd ?? rec.priceUsd),
    athUsd: findAth(rec),
  };
}

function feeField(rec: Record<string, unknown>): number | null {
  const fees = rec.fees;
  if (fees && typeof fees === "object") {
    const day = numberField((fees as Record<string, unknown>)["24h"]);
    if (day != null) return day;
  }
  return numberField(rec.fees_24h ?? rec.fee24h);
}

function volumeField(rec: Record<string, unknown>): number | null {
  const direct = numberField(rec.volume24h ?? rec.volume_24h);
  if (direct != null) return direct;
  const volume = rec.volume;
  if (volume && typeof volume === "object") {
    const day = (volume as Record<string, unknown>)["h24"] ?? (volume as Record<string, unknown>)["24h"];
    return numberField(day);
  }
  return null;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function timeField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && value.trim().match(/^\d+$/)) return timeField(asNum);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function findAth(rec: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(rec)) {
    if (!/ath/i.test(key)) continue;
    const hit = numberField(value);
    if (hit != null && hit > 0) return hit;
    if (value && typeof value === "object") {
      const nested = numberField((value as Record<string, unknown>).usd ?? (value as Record<string, unknown>).price);
      if (nested != null && nested > 0) return nested;
    }
  }
  return null;
}
