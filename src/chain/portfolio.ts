import { emptyStats, parseMeteoraPool } from "./market";

export interface DiscoveredPosition {
  pool: string;
  position: string;
  label?: string;
  tvlUsd?: number;
  volume24hUsd?: number;
}

interface PortfolioPage {
  hasNext?: boolean;
  pools?: unknown[];
}

export function parsePortfolio(body: unknown): { rows: DiscoveredPosition[]; hasNext: boolean } {
  const page = (body ?? {}) as PortfolioPage;
  const rows: DiscoveredPosition[] = [];
  for (const item of page.pools ?? []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const pool = stringField(rec, ["poolAddress", "pool", "address", "lbPair"]);
    if (!pool) continue;
    const symbolX = symbolField(rec.tokenX ?? rec.token_x);
    const symbolY = symbolField(rec.tokenY ?? rec.token_y);
    const label = symbolX && symbolY ? `${symbolX}/${symbolY}` : undefined;
    const positions = positionList(rec);
    const tvl = numberField(rec.tvl ?? rec.poolTvl ?? rec.pool_tvl);
    const volume = volumeField(rec);
    for (const position of positions) {
      rows.push({ pool, position, label, tvlUsd: tvl ?? undefined, volume24hUsd: volume });
    }
  }
  return { rows, hasNext: Boolean(page.hasNext) };
}

export async function fetchOpenPositions(user: string): Promise<DiscoveredPosition[]> {
  const rows: DiscoveredPosition[] = [];
  for (let page = 1; page <= 20; page++) {
    const url = new URL("https://dlmm.datapi.meteora.ag/portfolio/open");
    url.searchParams.set("user", user);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "50");
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "meteora-bidask-flip" },
    });
    if (!res.ok) {
      throw new Error(`Data API portfolio ${res.status}`);
    }
    const parsed = parsePortfolio(await res.json());
    rows.push(...parsed.rows);
    if (!parsed.hasNext) break;
  }
  return rows;
}

export async function fetchPoolMetrics(pool: string) {
  const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${pool}`, {
    headers: { accept: "application/json", "user-agent": "meteora-bidask-flip" },
  });
  if (!res.ok) return emptyStats();
  return parseMeteoraPool(await res.json());
}

function positionList(rec: Record<string, unknown>): string[] {
  const raw = rec.listPositions ?? rec.positions ?? rec.positionAddresses ?? [];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item) out.push(item);
    else if (item && typeof item === "object") {
      const address = stringField(item as Record<string, unknown>, [
        "address",
        "position",
        "publicKey",
        "positionAddress",
      ]);
      if (address) out.push(address);
    }
  }
  return out;
}

function stringField(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function symbolField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "symbol" in value) {
    const symbol = (value as { symbol?: unknown }).symbol;
    if (typeof symbol === "string" && symbol.trim()) return symbol.trim();
  }
  return undefined;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function volumeField(rec: Record<string, unknown>): number | undefined {
  const direct = numberField(rec.volume24h ?? rec.pool_volume_24h ?? rec.volume24hUsd);
  if (direct != null) return direct;
  const volume = rec.volume;
  if (volume && typeof volume === "object") {
    const hit = numberField((volume as Record<string, unknown>)["24h"]);
    if (hit != null) return hit;
  }
  return undefined;
}
