import { describe, expect, it } from "vitest";
import { evaluate } from "../src/decision/engine";
import { binStepAdvisory, feeTvlRatio, gradualSlice, isMidRange, poolAdvisories, reopenWidth } from "../src/decision/guards";
import {
  advanceConfirm,
  binPriceYPerX,
  classifySide,
  compositionOf,
  computeFlipRange,
  confirmReady,
  dropBelowLowerBps,
  isAskFilled,
  isBidFilled,
  oneSidedDeposit,
  takeProfitMath,
} from "../src/decision/math";
import { capBins } from "../src/decision/defaults";
import { cycle, settings, snap } from "./helpers";

describe("harga bin", () => {
  it("bin 0 harganya 1, bin step 1% naik 1.01", () => {
    expect(binPriceYPerX(0, 100).toString()).toBe("1");
    expect(binPriceYPerX(1, 100).toFixed(2)).toBe("1.01");
    expect(binPriceYPerX(-1, 100).toFixed(4)).toBe("0.9901");
  });
});

describe("trigger", () => {
  it("bid ke-fill kalau harga di bawah range dan isinya base", () => {
    const position = snap({
      activeBinId: 970,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 1_000_000n,
      amountY: 0n,
    });
    expect(isBidFilled(position, 9800)).toBe(true);
    expect(isAskFilled(position, 9800)).toBe(false);
  });

  it("ask yang baru dibuka (base di atas harga) bukan trigger bid", () => {
    const position = snap({
      activeBinId: 970,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 1_000_000n,
      amountY: 0n,
    });
    expect(classifySide(position, "auto", "resting", 9800, 9800)).toEqual({
      side: "ask",
      filled: false,
    });
    expect(isAskFilled(position, 9800)).toBe(false);
  });

  it("ask ke-fill kalau harga di atas range dan isinya quote", () => {
    const position = snap({
      activeBinId: 1100,
      lowerBinId: 1001,
      upperBinId: 1020,
      amountX: 0n,
      amountY: 2_000_000_000n,
    });
    expect(isAskFilled(position, 9800)).toBe(true);
    expect(classifySide(position, "auto", "resting", 9800, 9800).side).toBe("bid");
  });

  it("bid yang masih di bawah harga nggak ke-fill", () => {
    const position = snap({
      activeBinId: 1100,
      lowerBinId: 1001,
      upperBinId: 1020,
      amountX: 0n,
      amountY: 2_000_000_000n,
    });
    expect(isBidFilled(position, 9800)).toBe(false);
    expect(classifySide(position, "bid", "resting", 9800, 9800)).toEqual({
      side: "bid",
      filled: false,
    });
  });

  it("initialSide bid yang udah tembus langsung dianggap filled", () => {
    const position = snap({
      activeBinId: 970,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 5_000_000n,
      amountY: 0n,
    });
    expect(classifySide(position, "bid", "resting", 9800, 9800).filled).toBe(true);
  });

  it("di dalam range dan masih quote, nggak flip", () => {
    const position = snap({
      activeBinId: 990,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 0n,
      amountY: 1_000_000n,
    });
    expect(isBidFilled(position, 9900)).toBe(false);
  });

  it("99% token di dalam range tetap trigger, tanpa nunggu OOR", () => {
    const position = snap({
      activeBinId: 981,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 1_000_000n,
      amountY: 0n,
    });
    expect(isBidFilled(position, 9900)).toBe(true);
  });

  it("OOR penuh tetap trigger walau sisa quote di atas 1%", () => {
    const position = snap({
      activeBinId: 970,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 100n,
      amountY: 1_000_000_000n,
    });
    expect(compositionOf(position).baseBps).toBeLessThan(9900);
    expect(isBidFilled(position, 9900)).toBe(true);
  });
});

describe("konfirmasi", () => {
  it("butuh N cek dan N menit, reset kalau trigger hilang", () => {
    const first = advanceConfirm(null, "to_ask", 0);
    expect(confirmReady(first, 0, 3, 2)).toBe(false);
    const second = advanceConfirm({ ...first, direction: "to_ask" }, "to_ask", 60_000);
    const third = advanceConfirm({ ...second, direction: "to_ask" }, "to_ask", 120_000);
    expect(third.checks).toBe(3);
    expect(confirmReady(third, 120_000, 3, 2)).toBe(true);
    expect(confirmReady(third, 119_000, 3, 2)).toBe(false);
    const reset = advanceConfirm({ ...third, direction: "to_ask" }, "to_bid", 130_000);
    expect(reset.checks).toBe(1);
  });
});

describe("range", () => {
  it("flip ke ask naruh range di atas bin aktif, beratannya urusan SDK", () => {
    const range = computeFlipRange({ activeBinId: 1000, toSide: "ask", widthBins: 20, gap: 1 });
    expect(range).toEqual({ minBinId: 1001, maxBinId: 1020 });
    expect(range.maxBinId < 1000).toBe(false);
    expect(range.minBinId > 1000).toBe(true);
  });

  it("flip ke bid naruh range di bawah, gap minimal 1", () => {
    const range = computeFlipRange({ activeBinId: -5, toSide: "bid", widthBins: 10, gap: 0 });
    expect(range).toEqual({ minBinId: -15, maxBinId: -6 });
  });

  it("lebar di-cap ke max bin posisi", () => {
    expect(capBins(5000, 1400)).toBe(1400);
    expect(capBins(69, 1400)).toBe(69);
  });
});

describe("take profit", () => {
  it("belum armed kalau principal masih sama modal", () => {
    const result = takeProfitMath({
      principalQuote: 1_000n,
      unclaimedFeesQuote: 10n,
      claimedFeesQuote: 0n,
      feeBaselineQuote: 0n,
      costBasisQuote: 1_000n,
      bufferLamports: 0n,
      bufferBps: 0,
      drawdownArmBps: 50,
      alreadyArmed: false,
    });
    expect(result.armed).toBe(false);
    expect(result.hit).toBe(false);
    expect(result.pnlQuote).toBe(10n);
  });

  it("IL balik, PnL kira-kira sama fee", () => {
    const armed = takeProfitMath({
      principalQuote: 900n,
      unclaimedFeesQuote: 5n,
      claimedFeesQuote: 0n,
      feeBaselineQuote: 0n,
      costBasisQuote: 1_000n,
      bufferLamports: 0n,
      bufferBps: 0,
      drawdownArmBps: 50,
      alreadyArmed: false,
    });
    expect(armed.armed).toBe(true);
    expect(armed.hit).toBe(false);
    const recovered = takeProfitMath({
      principalQuote: 1_000n,
      unclaimedFeesQuote: 0n,
      claimedFeesQuote: 40n,
      feeBaselineQuote: 0n,
      costBasisQuote: 1_000n,
      bufferLamports: 0n,
      bufferBps: 0,
      drawdownArmBps: 50,
      alreadyArmed: true,
    });
    expect(recovered.hit).toBe(true);
    expect(recovered.pnlQuote).toBe(recovered.feesEarnedQuote);
  });

  it("buffer bikin TP nunggu principal di atas modal", () => {
    const result = takeProfitMath({
      principalQuote: 1_000n,
      unclaimedFeesQuote: 0n,
      claimedFeesQuote: 50n,
      feeBaselineQuote: 0n,
      costBasisQuote: 1_000n,
      bufferLamports: 10n,
      bufferBps: 0,
      drawdownArmBps: 0,
      alreadyArmed: true,
    });
    expect(result.hit).toBe(false);
    const later = takeProfitMath({ ...{
      principalQuote: 1_010n,
      unclaimedFeesQuote: 0n,
      claimedFeesQuote: 50n,
      feeBaselineQuote: 0n,
      costBasisQuote: 1_000n,
      bufferLamports: 10n,
      bufferBps: 0,
      drawdownArmBps: 0,
      alreadyArmed: true,
    } });
    expect(later.hit).toBe(true);
  });
});

describe("engine", () => {
  const filledBid = snap({
    activeBinId: 970,
    lowerBinId: 980,
    upperBinId: 999,
    amountX: 2_000_000n,
    amountY: 0n,
    feeX: 10n,
    feeY: 0n,
  });

  it("adopt bid di bawah harga, nggak langsung flip", () => {
    const position = snap();
    const result = evaluate({
      nowMs: 1,
      snapshot: position,
      cycle: null,
      settings: settings(),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.cycle?.side).toBe("bid");
    expect(result.cycle?.costBasisQuote).toBe(compositionOf(position).principalQuote);
    expect(result.decision.type).toBe("hold");
  });

  it("bid ke-fill nunggu konfirmasi, lalu susun ask di atas", () => {
    const first = evaluate({
      nowMs: 0,
      snapshot: filledBid,
      cycle: cycle({ side: "bid", widthBins: 20 }),
      settings: settings({ confirmChecks: 3, confirmMinutes: 2 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(first.decision.type).toBe("confirming");
    const second = evaluate({
      nowMs: 60_000,
      snapshot: filledBid,
      cycle: first.cycle,
      settings: settings({ confirmChecks: 3, confirmMinutes: 2 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    const third = evaluate({
      nowMs: 120_000,
      snapshot: filledBid,
      cycle: second.cycle,
      settings: settings({ confirmChecks: 3, confirmMinutes: 2 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(third.decision.type).toBe("flip");
    if (third.decision.type !== "flip") return;
    expect(third.decision.plan.toSide).toBe("ask");
    expect(third.decision.plan.minBinId).toBe(971);
    expect(third.decision.plan.maxBinId).toBe(990);
    expect(third.decision.plan.depositX).toBe(2_000_010n);
    expect(third.decision.plan.depositY).toBe(0n);
  });

  it("harga balik ke range, konfirmasi di-reset", () => {
    const started = evaluate({
      nowMs: 0,
      snapshot: filledBid,
      cycle: cycle(),
      settings: settings({ confirmChecks: 3, confirmMinutes: 0 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(started.cycle?.confirm?.checks).toBe(1);
    const back = snap({ activeBinId: 990, lowerBinId: 980, upperBinId: 999, amountX: 0n, amountY: 1_000n });
    const reset = evaluate({
      nowMs: 10,
      snapshot: back,
      cycle: started.cycle,
      settings: settings(),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(reset.cycle?.confirm).toBeNull();
    expect(reset.decision.type).toBe("hold");
  });

  it("ask ke-fill buka bid di bawah", () => {
    const position = snap({
      activeBinId: 1100,
      lowerBinId: 1001,
      upperBinId: 1020,
      amountX: 0n,
      amountY: 5_000_000_000n,
    });
    const result = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle({ side: "ask", widthBins: 15 }),
      settings: settings(),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("flip");
    if (result.decision.type !== "flip") return;
    expect(result.decision.plan.toSide).toBe("bid");
    expect(result.decision.plan.maxBinId).toBe(1099);
    expect(result.decision.plan.widthBins).toBe(20);
    expect(result.decision.plan.minBinId).toBe(1080);
    expect(oneSidedDeposit(position, "bid")).toEqual({ x: 0n, y: 5_000_000_000n });
  });

  it("batas flip 24 jam ngeblok", () => {
    const result = evaluate({
      nowMs: 0,
      snapshot: filledBid,
      cycle: cycle(),
      settings: settings({ maxFlipsPer24h: 2 }),
      flipsLast24h: 2,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("blocked");
  });

  it("harga ambles di bawah ask bikin pause", () => {
    const position = snap({
      activeBinId: 900,
      lowerBinId: 1000,
      upperBinId: 1020,
      amountX: 1_000_000n,
      amountY: 0n,
      binStep: 100,
    });
    const drop = dropBelowLowerBps(900, 1000, 100);
    expect(drop).toBeGreaterThan(2500);
    const result = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle({ side: "ask" }),
      settings: settings({ maxDropBelowAskBottomPct: 25 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("pause");
  });

  it("TP close menang atas flip kalau IL udah balik", () => {
    const position = snap({
      activeBinId: 1100,
      lowerBinId: 1001,
      upperBinId: 1020,
      amountX: 0n,
      amountY: 1_000_000_000n,
    });
    const result = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle({
        side: "ask",
        costBasisQuote: 900_000_000n,
        tpArmed: true,
        feeBaselineQuote: 0n,
      }),
      settings: settings({ tpMode: "close" }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("take_profit");
  });

  it("konfirmasi pakai menit, bukan cuma jumlah cek", () => {
    const first = evaluate({
      nowMs: 0,
      snapshot: filledBid,
      cycle: cycle({ side: "bid" }),
      settings: settings({ confirmChecks: 1, confirmMinutes: 4 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(first.decision.type).toBe("confirming");
    if (first.decision.type === "confirming") {
      expect(first.decision.needMs).toBe(4 * 60_000);
    }
    const early = evaluate({
      nowMs: 3 * 60_000,
      snapshot: filledBid,
      cycle: first.cycle,
      settings: settings({ confirmChecks: 1, confirmMinutes: 4 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(early.decision.type).toBe("confirming");
    const ready = evaluate({
      nowMs: 4 * 60_000,
      snapshot: filledBid,
      cycle: early.cycle,
      settings: settings({ confirmChecks: 1, confirmMinutes: 4 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(ready.decision.type).toBe("flip");
    if (ready.decision.type === "flip") {
      expect(ready.decision.plan.widthBins).toBe(999 - 980 + 1);
    }
  });

  it("buka ulang pakai jumlah bin yang sama, bukan lebar default", () => {
    const result = evaluate({
      nowMs: 0,
      snapshot: filledBid,
      cycle: cycle({ side: "bid", widthBins: 7 }),
      settings: settings({ freshRangeBins: 70, rangeWidthBins: null }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("flip");
    if (result.decision.type !== "flip") return;
    expect(result.decision.plan.widthBins).toBe(20);
    expect(reopenWidth(980, 999, settings())).toBe(20);
  });

  it("gradual ngupas N bin, bukan seluruh posisi", () => {
    const slice = gradualSlice({
      side: "bid",
      activeBinId: 1040,
      lowerBinId: 1000,
      upperBinId: 1069,
      anchorBin: 1069,
      chunkBins: 20,
    });
    expect(slice).toEqual({ removeFromBin: 1050, removeToBin: 1069, nextAnchor: 1049, width: 20 });
    const position = snap({
      activeBinId: 1040,
      lowerBinId: 1000,
      upperBinId: 1069,
      amountX: 0n,
      amountY: 5_000_000_000n,
      binBalances: [
        { binId: 1055, amountX: 400n, amountY: 0n },
        { binId: 1060, amountX: 600n, amountY: 0n },
        { binId: 1020, amountX: 0n, amountY: 9_000n },
      ],
    });
    const result = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle({ side: "bid", gradualAnchorBin: 1069, widthBins: 70 }),
      settings: settings({ gradualFlip: true, gradualFlipBins: 20 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("flip");
    if (result.decision.type !== "flip") return;
    expect(result.decision.plan.partial).toBe(true);
    expect(result.decision.plan.closeAfter).toBe(false);
    expect(result.decision.plan.widthBins).toBe(20);
    expect(result.decision.plan.depositX).toBe(1000n);
    expect(result.decision.plan.depositY).toBe(0n);
  });

  it("fee/TVL di tengah range bisa pause, TVL gede cuma saran", () => {
    expect(feeTvlRatio(1_000, 10_000)).toBe(0.1);
    expect(isMidRange(990, 980, 999)).toBe(true);
    const position = snap({
      activeBinId: 990,
      lowerBinId: 980,
      upperBinId: 999,
      amountX: 0n,
      amountY: 1_000_000n,
      fees24hUsd: 1_000,
      poolTvlUsd: 10_000,
      binStep: 80,
    });
    const paused = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle(),
      settings: settings({ minFeeTvl: 0.2, feeTvlAction: "pause" }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(paused.decision.type).toBe("pause");
    const alerted = evaluate({
      nowMs: 0,
      snapshot: { ...position, poolTvlUsd: 250_000 },
      cycle: cycle(),
      settings: settings({ minFeeTvl: 0.2, feeTvlAction: "alert", highTvlWarnUsd: 100_000 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(alerted.decision.type).toBe("hold");
    expect(alerted.advisories.some((note) => note.includes("fee/TVL"))).toBe(true);
    expect(alerted.advisories.some((note) => note.includes("TVL"))).toBe(true);
    expect(binStepAdvisory(25)).toMatch(/80\/100/);
    expect(binStepAdvisory(100)).toBeNull();
  });

  it("ask bot yang kelamaan di bawah harga ngasih pilihan, bukan langsung cut", () => {
    const position = snap({
      activeBinId: 900,
      lowerBinId: 1000,
      upperBinId: 1069,
      amountX: 1_000_000n,
      amountY: 0n,
      binStep: 80,
    });
    const fresh = evaluate({
      nowMs: 0,
      snapshot: position,
      cycle: cycle({ side: "ask", openedByBot: true, widthBins: 70 }),
      settings: settings({ maxDropBelowAskBottomPct: 0, staleAskHours: 12 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(fresh.decision.type).toBe("hold");
    const stuck = evaluate({
      nowMs: 12 * 3_600_000,
      snapshot: position,
      cycle: fresh.cycle,
      settings: settings({ maxDropBelowAskBottomPct: 0, staleAskHours: 12 }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(stuck.decision.type).toBe("stale_ask");
  });

  it("saran token nggak ngeblok, dan data kosong di-skip", () => {
    const notes = poolAdvisories(
      snap({
        baseMarketCapUsd: 200_000,
        pairCreatedAtMs: Date.now() - 86_400_000,
        priceUsd: 0.2,
        athUsd: 1,
        binStep: 100,
        poolTvlUsd: 10_000,
        activeBinId: 1000,
        lowerBinId: 980,
        upperBinId: 999,
      }),
      settings(),
      Date.now(),
    );
    expect(notes.pauseFeeTvl).toBe(false);
    expect(notes.notes.some((note) => note.includes("mcap"))).toBe(true);
    expect(notes.notes.some((note) => note.includes("umur"))).toBe(true);
    expect(notes.notes.some((note) => note.includes("ATH"))).toBe(true);
    const quiet = poolAdvisories(snap({ binStep: 100, poolTvlUsd: 10_000 }), settings(), Date.now());
    expect(quiet.notes).toEqual([]);
  });

  it("transfer tax di-skip", () => {
    const result = evaluate({
      nowMs: 0,
      snapshot: snap({ transferFee: true, manageable: true }),
      cycle: null,
      settings: settings({ skipTransferFee: true }),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("skip");
  });

  it("pool terbalik di-skip", () => {
    const result = evaluate({
      nowMs: 0,
      snapshot: snap({ manageable: false, blockReason: "inverted" }),
      cycle: null,
      settings: settings(),
      flipsLast24h: 0,
      pausedReason: null,
    });
    expect(result.decision.type).toBe("skip");
  });
});
