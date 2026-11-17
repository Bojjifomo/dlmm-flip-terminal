import { describe, expect, it } from "vitest";
import { decodeBase58, encodeBase58 } from "../src/base58";
import { mergeStats, parseDexScreener, parseMeteoraPool } from "../src/chain/market";
import { parsePortfolio } from "../src/chain/portfolio";
import { withPriorityFee } from "../src/chain/tx";
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

describe("portfolio", () => {
  it("baca listPositions dari Data API", () => {
    const parsed = parsePortfolio({
      hasNext: false,
      pools: [
        {
          poolAddress: "POOL",
          tokenX: "BONK",
          tokenY: "SOL",
          listPositions: ["POS1", "POS2"],
          tvl: "10",
        },
      ],
    });
    expect(parsed.hasNext).toBe(false);
    expect(parsed.rows).toEqual([
      { pool: "POOL", position: "POS1", label: "BONK/SOL", tvlUsd: 10, volume24hUsd: undefined },
      { pool: "POOL", position: "POS2", label: "BONK/SOL", tvlUsd: 10, volume24hUsd: undefined },
    ]);
  });
});

describe("market", () => {
  it("fee/TVL dari fees 24h dan TVL, plus DexScreener kalau ada", () => {
    const pool = parseMeteoraPool({
      name: "MEME-SOL",
      tvl: 50_000,
      fees: { "24h": 12_000 },
      created_at: "2026-11-01T00:00:00Z",
      token_x: { address: "MEME", symbol: "MEME", market_cap: 2_500_000, price: 0.4 },
      token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    });
    expect(pool.fees24hUsd).toBe(12_000);
    expect(pool.tvlUsd).toBe(50_000);
    expect(pool.baseMarketCapUsd).toBe(2_500_000);
    expect(pool.createdAtMs).toBe(Date.parse("2026-11-01T00:00:00Z"));
    const dex = parseDexScreener({
      pairs: [{ priceUsd: "0.35", marketCap: 3_000_000, pairCreatedAt: 1_700_000_000_000, ath: { usd: 1.2 } }],
    });
    const merged = mergeStats({ ...pool, athUsd: null, priceUsd: null }, dex);
    expect(merged.athUsd).toBe(1.2);
    expect(merged.priceUsd).toBe(0.35);
    expect(merged.baseMarketCapUsd).toBe(2_500_000);
    expect(parseDexScreener({})).toEqual({});
  });
});

describe("base58", () => {
  it("system program 32 byte nol", () => {
    const decoded = decodeBase58("11111111111111111111111111111111");
    expect(decoded).toEqual(new Uint8Array(32));
    expect(encodeBase58(decoded)).toBe("11111111111111111111111111111111");
    const bytes = Uint8Array.from([0, 1, 255, 8, 9, 0]);
    expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
  });
});

describe("priority fee", () => {
  it("naruh harga compute di depan dan nggak dobel", () => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }));
    const next = withPriorityFee(tx, 50_000, 1_400_000);
    expect(next.instructions[0].data[0]).toBe(3);
    expect(next.instructions.filter((ix) => ix.data[0] === 3)).toHaveLength(1);
    expect(next.instructions.some((ix) => ix.data[0] === 2)).toBe(true);
  });
});
