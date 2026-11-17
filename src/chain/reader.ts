import DLMM, { type LbPosition } from "@meteora-ag/dlmm";
import { getTransferFeeConfig, type Mint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config";
import { settingsFor } from "../config";
import { WSOL_MINT, type BinBalance, type PositionSnapshot } from "../domain";
import { log } from "../logger";
import { fetchDexScreener, mergeStats, type PoolStats } from "./market";
import { fetchOpenPositions, fetchPoolMetrics } from "./portfolio";
import { loadPool } from "./pools";

export interface Probe {
  pool: string;
  label: string;
  activeBinId: number;
  binStep: number;
}

export interface ReadResult {
  snapshots: PositionSnapshot[];
  probes: Probe[];
  warnings: string[];
}

interface Target {
  pool: string;
  position?: string;
  label?: string;
  tvlUsd?: number;
  volume24hUsd?: number;
}

export async function readPositions(
  connection: Connection,
  owner: PublicKey,
  config: AppConfig,
): Promise<ReadResult> {
  const warnings: string[] = [];
  const targets = await discoverTargets(connection, owner, config, warnings);
  const snapshots: PositionSnapshot[] = [];
  const byPool = new Map<string, Target[]>();
  for (const target of targets) {
    const list = byPool.get(target.pool) ?? [];
    list.push(target);
    byPool.set(target.pool, list);
  }

  for (const [poolAddress, group] of byPool) {
    let dlmm: DLMM;
    try {
      dlmm = await loadPool(connection, poolAddress);
    } catch (error) {
      warnings.push(`pool ${poolAddress} gagal diload: ${errorMessage(error)}`);
      continue;
    }
    let stats = await loadPoolStats(poolAddress, warnings);
    const hintedTvl = group.find((t) => t.tvlUsd != null)?.tvlUsd;
    const hintedVol = group.find((t) => t.volume24hUsd != null)?.volume24hUsd;
    if (hintedTvl != null) stats = { ...stats, tvlUsd: stats.tvlUsd ?? hintedTvl };
    if (hintedVol != null) stats = { ...stats, volume24hUsd: stats.volume24hUsd ?? hintedVol };
    const apiName = group.find((t) => t.label)?.label ?? stats.name;
    const wanted = new Set(group.map((t) => t.position).filter((v): v is string => Boolean(v)));
    const loadAll = group.some((t) => !t.position);
    let positions: LbPosition[] = [];
    if (loadAll || wanted.size === 0) {
      const found = await dlmm.getPositionsByUserAndLbPair(owner);
      positions = found.userPositions;
    }
    for (const position of wanted) {
      if (positions.some((row) => row.publicKey.toBase58() === position)) continue;
      try {
        positions.push(await dlmm.getPosition(new PublicKey(position)));
      } catch (error) {
        warnings.push(`posisi ${position} gagal dibaca: ${errorMessage(error)}`);
      }
    }
    for (const row of positions) {
      const id = row.publicKey.toBase58();
      if (config.excludePositions.includes(id)) continue;
      if (!loadAll && wanted.size > 0 && !wanted.has(id)) continue;
      snapshots.push(toSnapshot(dlmm, row, apiName, stats, config));
    }
  }

  const probes: Probe[] = [];
  for (const pool of config.probePools) {
    try {
      const dlmm = await loadPool(connection, pool);
      let label = `${symbolOrMint(dlmm, "x")}/${symbolOrMint(dlmm, "y")}`;
      try {
        const metrics = await fetchPoolMetrics(pool);
        if (metrics.name) label = metrics.name;
      } catch {
        // nama pool opsional
      }
      probes.push({
        pool,
        label,
        activeBinId: toNum(dlmm.lbPair.activeId),
        binStep: toNum(dlmm.lbPair.binStep),
      });
    } catch (error) {
      warnings.push(`probe ${pool} gagal: ${errorMessage(error)}`);
    }
  }
  return { snapshots, probes, warnings };
}

async function discoverTargets(
  connection: Connection,
  owner: PublicKey,
  config: AppConfig,
  warnings: string[],
): Promise<Target[]> {
  const targets: Target[] = [];
  for (const position of config.positions) {
    if (!position.pool) {
      warnings.push(`posisi ${position.position} nggak punya pool, dilewati`);
      continue;
    }
    targets.push({ pool: position.pool, position: position.position });
  }
  const poolAllow = new Set(config.pools.map((p) => p.address));
  const selected = config.watch === "selected";
  if (selected && poolAllow.size === 0) return dedupe(targets);

  let discovered = false;
  try {
    const rows = await fetchOpenPositions(owner.toBase58());
    for (const row of rows) {
      if (poolAllow.size > 0 && !poolAllow.has(row.pool)) continue;
      targets.push(row);
    }
    discovered = true;
  } catch (error) {
    warnings.push(`Data API gagal (${errorMessage(error)}), coba getAllLbPairPositionsByUser`);
  }
  if (!discovered) {
    try {
      const map = await DLMM.getAllLbPairPositionsByUser(connection, owner, { cluster: "mainnet-beta" });
      for (const [pool, info] of map) {
        if (poolAllow.size > 0 && !poolAllow.has(pool)) continue;
        for (const row of info.lbPairPositionsData) {
          targets.push({ pool, position: row.publicKey.toBase58() });
        }
      }
    } catch (error) {
      warnings.push(
        `getAllLbPairPositionsByUser gagal (${errorMessage(error)}). RPC lo perlu support getProgramAccounts, atau isi positions manual.`,
      );
    }
  }
  if (!selected && poolAllow.size === 0 && targets.length === 0 && config.positions.length === 0) {
    log.info("wallet ini nggak punya posisi DLMM terbuka");
  }
  return dedupe(targets);
}

async function loadPoolStats(pool: string, warnings: string[]): Promise<PoolStats> {
  let stats = mergeStats(
    { tvlUsd: null, volume24hUsd: null, fees24hUsd: null, createdAtMs: null, baseMarketCapUsd: null, priceUsd: null, athUsd: null },
    {},
  );
  try {
    stats = await fetchPoolMetrics(pool);
  } catch (error) {
    warnings.push(`metrik ${pool} gagal: ${errorMessage(error)}`);
  }
  const dex = await fetchDexScreener(pool);
  return mergeStats(stats, dex);
}

function toSnapshot(
  dlmm: DLMM,
  row: LbPosition,
  apiName: string | undefined,
  stats: PoolStats,
  config: AppConfig,
): PositionSnapshot {
  const data = row.positionData;
  const mintX = dlmm.tokenX.publicKey.toBase58();
  const mintY = dlmm.tokenY.publicKey.toBase58();
  const settings = settingsFor(config, dlmm.pubkey.toBase58(), row.publicKey.toBase58());
  const quote = resolveQuote(mintX, mintY, settings.quoteMint);
  const transferFee = mintHasTransferFee(dlmm.tokenX.mint) || mintHasTransferFee(dlmm.tokenY.mint);
  const baseMint = quote.quoteIsY ? mintX : mintY;
  const baseSymbol = quote.quoteIsY ? symbolOrMint(dlmm, "x") : symbolOrMint(dlmm, "y");
  const quoteSymbol = quote.quoteIsY ? symbolOrMint(dlmm, "y") : symbolOrMint(dlmm, "x");
  const label = apiName && apiName.includes("/") ? apiName : `${symbolOrMint(dlmm, "x")}/${symbolOrMint(dlmm, "y")}`;
  let manageable = !quote.inverted || settings.allowInvertedQuote;
  let blockReason: string | undefined = manageable
    ? undefined
    : "quote ada di mint X. Bid DLMM cuma bisa token Y di bawah harga. Set allowInvertedQuote kalau lo ngerti risikonya.";
  if (transferFee && settings.skipTransferFee) {
    manageable = false;
    blockReason = "token punya transfer tax (Token-2022 transfer fee). Posisi ini di-skip.";
  }
  return {
    position: row.publicKey.toBase58(),
    pool: dlmm.pubkey.toBase58(),
    label,
    activeBinId: toNum(dlmm.lbPair.activeId),
    lowerBinId: toNum(data.lowerBinId),
    upperBinId: toNum(data.upperBinId),
    binStep: toNum(dlmm.lbPair.binStep),
    amountX: asBigint(data.totalXAmountExcludeTransferFee ?? data.totalXAmount),
    amountY: asBigint(data.totalYAmountExcludeTransferFee ?? data.totalYAmount),
    feeX: asBigint(data.feeXExcludeTransferFee ?? data.feeX),
    feeY: asBigint(data.feeYExcludeTransferFee ?? data.feeY),
    quoteIsY: quote.quoteIsY,
    inverted: quote.inverted,
    manageable,
    blockReason,
    quoteDecimals: quote.quoteIsY ? dlmm.tokenY.mint.decimals : dlmm.tokenX.mint.decimals,
    baseDecimals: quote.quoteIsY ? dlmm.tokenX.mint.decimals : dlmm.tokenY.mint.decimals,
    quoteSymbol,
    baseSymbol,
    mintX,
    mintY,
    poolTvlUsd: stats.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    fees24hUsd: stats.fees24hUsd,
    transferFee,
    pairCreatedAtMs: stats.createdAtMs,
    baseMarketCapUsd: baseMint ? stats.baseMarketCapUsd : null,
    priceUsd: stats.priceUsd,
    athUsd: stats.athUsd,
    binBalances: binBalancesOf(data.positionBinData),
  };
}

function binBalancesOf(rows: LbPosition["positionData"]["positionBinData"] | undefined): BinBalance[] {
  if (!rows) return [];
  return rows.map((bin) => ({
    binId: toNum(bin.binId),
    amountX: asBigint(bin.positionXAmount),
    amountY: asBigint(bin.positionYAmount),
  }));
}

function mintHasTransferFee(mint: Mint): boolean {
  try {
    const config = getTransferFeeConfig(mint);
    if (!config) return false;
    return config.newerTransferFee.transferFeeBasisPoints > 0 || config.olderTransferFee.transferFeeBasisPoints > 0;
  } catch {
    return false;
  }
}

export function resolveQuote(
  mintX: string,
  mintY: string,
  quoteMint: string | null,
): { quoteIsY: boolean; inverted: boolean } {
  if (quoteMint) {
    if (quoteMint === mintY) return { quoteIsY: true, inverted: false };
    if (quoteMint === mintX) return { quoteIsY: false, inverted: true };
    throw new Error(`quoteMint ${quoteMint} bukan token pool ini`);
  }
  if (mintY === WSOL_MINT) return { quoteIsY: true, inverted: false };
  if (mintX === WSOL_MINT) return { quoteIsY: false, inverted: true };
  return { quoteIsY: true, inverted: false };
}

function symbolOrMint(dlmm: DLMM, side: "x" | "y"): string {
  const mint = side === "x" ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;
  if (mint.toBase58() === WSOL_MINT) return "SOL";
  return mintSymbol(dlmm, side);
}

function mintSymbol(dlmm: DLMM, side: "x" | "y"): string {
  const mint = side === "x" ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;
  return mint.toBase58() === WSOL_MINT ? "SOL" : mint.toBase58().slice(0, 4);
}

function dedupe(targets: Target[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const target of targets) {
    const key = target.position ? `${target.pool}:${target.position}` : `${target.pool}:*`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

function toNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

function asBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value.split(".")[0] || "0");
  if (value && typeof (value as { toString: () => string }).toString === "function") {
    const text = (value as { toString: () => string }).toString();
    if (text && text !== "[object Object]") return BigInt(text.split(".")[0]);
  }
  return 0n;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
