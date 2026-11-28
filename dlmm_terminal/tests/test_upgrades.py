import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dlmm_terminal import cli, flip, review, safety, settings, tgbot, web


class SafetyAnalyticsTests(unittest.TestCase):
    def test_parse_rugcheck_levels(self):
        ok = safety.parse_rugcheck({"score_normalised": 10, "risks": [], "topHolders": [{"pct": 5}, {"pct": 4}]})
        self.assertEqual((ok["ok"], ok["level"], ok["top10Pct"]), (True, "OK", 9.0))

        warn = safety.parse_rugcheck({"score_normalised": 40, "mintAuthority": "abc", "risks": [{"name": "Mint Authority", "level": "warn"}]})
        self.assertEqual(warn["level"], "WARN")
        self.assertTrue(warn["mintAuth"])

        tax = safety.parse_rugcheck({"score_normalised": 15, "transferFee": {"pct": 2.5}, "risks": []})
        self.assertEqual(tax["level"], "DANGER")
        self.assertTrue(tax["transferTax"])
        self.assertEqual(tax["transferFeePct"], 2.5)

        frz = safety.parse_rugcheck({"freezeAuthority": "xyz", "risks": []})
        self.assertEqual(frz["level"], "DANGER")
        self.assertTrue(frz["freezeAuth"])

    def test_volume_share_momentum_and_regime(self):
        self.assertEqual(safety.dlmm_volume_share(25_000, 100_000), 25.0)
        self.assertIsNone(safety.dlmm_volume_share(0, 100_000))
        self.assertEqual(safety.fee_momentum(200, 2400, 48), 2.0)   # 200 vs 100/h avg
        self.assertEqual(safety.fee_momentum(100, 400, 4), 1.0)     # young 4h pool
        rows = [{"priceChg1h": -8}, {"priceChg1h": -6}, {"priceChg1h": -10}, {"priceChg1h": -4}]
        rg = safety.market_regime(rows, sol_chg_1h=-3.5, sol_chg_24h=-6.0)
        self.assertEqual(rg["regime"], "risk-off")
        self.assertEqual(rg["redPct"], 100.0)
        norm = safety.market_regime([{"priceChg1h": 2}, {"priceChg1h": 1}, {"priceChg1h": -1}], sol_chg_1h=0.5)
        self.assertEqual(norm["regime"], "normal")

    def test_il_breakeven_model(self):
        res = safety.il_breakeven(size_sol=8.0, bottom_pct=70, fee_1h_pct_tvl=1.0, slices=5)
        self.assertEqual(len(res["scenarios"]), 3)
        s30, s50, s70 = res["scenarios"]
        self.assertEqual((s30["dropPct"], s50["dropPct"], s70["dropPct"]), (-30, -50, -70))
        self.assertLess(s70["lossPct"], s50["lossPct"])
        self.assertLess(s50["lossPct"], s30["lossPct"])
        self.assertGreater(s50["recoverHours"], s30["recoverHours"])


class StaleAskTests(unittest.TestCase):
    def test_stale_ask_fires_after_hours_and_resets_on_fee(self):
        st = flip.FlipState(side="ask")
        cfg = {"staleAskHours": 12}
        t0 = 1_800_000_000.0
        self.assertIsNone(flip.check_stale_ask(t0, price=0.5, range_min=0.8, fee_sol=0.01, state=st, cfg=cfg))
        self.assertIsNone(flip.check_stale_ask(t0 + 6 * 3600, price=0.5, range_min=0.8, fee_sol=0.01, state=st, cfg=cfg))
        hit = flip.check_stale_ask(t0 + 13 * 3600, price=0.5, range_min=0.8, fee_sol=0.01, state=st, cfg=cfg)
        self.assertIsNotNone(hit)
        self.assertTrue(hit["notify"])
        self.assertEqual(hit["hours"], 13.0)
        # second check still stale, does not re-notify
        hit2 = flip.check_stale_ask(t0 + 14 * 3600, price=0.5, range_min=0.8, fee_sol=0.01, state=st, cfg=cfg)
        self.assertFalse(hit2["notify"])
        # fee grows -> resets stale timer
        self.assertIsNone(flip.check_stale_ask(t0 + 15 * 3600, price=0.5, range_min=0.8, fee_sol=0.02, state=st, cfg=cfg))
        self.assertIsNone(st.stale_since)


class ReviewUpgradesTests(unittest.TestCase):
    def test_avg_chg1h_ignores_none_and_joins_local_logs(self):
        tmp = Path(tempfile.mkdtemp())
        ts = "2026-11-20T12:00:00+00:00"
        (tmp / "rpc_usage.jsonl").write_text(json.dumps({
            "ts": ts, "tx": [{"feeLamports": 500_000, "tipLamports": 10_000}, {"feeLamports": 500_000, "tipLamports": 10_000}],
        }) + "\n")
        (tmp / "swaps.jsonl").write_text(json.dumps({"ts": ts, "ok": True, "sol": 2.0, "underPct": 2.0}) + "\n")
        (tmp / "flips.jsonl").write_text(json.dumps({"ts": ts, "ok": True, "pool": "P_FLIP", "position": "POS1"}) + "\n")
        (tmp / "followup.jsonl").write_text(
            json.dumps({"decision": "skip", "minVsEntryPct": -55, "chg24hPct": -50}) + "\n"
            + json.dumps({"decision": "skip", "minVsEntryPct": -5, "chg24hPct": 2}) + "\n"
        )
        (tmp / "decisions.jsonl").write_text(
            json.dumps({"ts": ts, "pool": "P_FLIP", "decision": "enter", "override": False}) + "\n"
            + json.dumps({"ts": ts, "pool": "P_STD", "decision": "enter", "override": True}) + "\n"
        )
        (tmp / "narratives.jsonl").write_text(json.dumps({"ts": "2026-11-20T11:30:00+00:00", "pool": "P_FLIP", "mint": "M1", "symbol": "AAA", "tag": "KUAT"}) + "\n")

        es = [
            {"symbol": "AAA", "pool": "P_FLIP", "tokenMint": "M1", "positions": ["POS1"], "entryTs": ts,
             "capitalSol": 5.0, "pnlSol": 0.3, "feesSol": 0.35, "pnlPct": 6.0, "priceChg1h": 10.0,
             "poolAgeHours": 20.0, "volMcap24h": 1.2, "binStep": 100, "holdMin": 180.0, "entryHourLocal": 19},
            {"symbol": "AAA", "pool": "P_FLIP", "tokenMint": "M1", "positions": ["POS2"], "entryTs": ts,
             "capitalSol": 5.0, "pnlSol": 0.1, "feesSol": 0.15, "pnlPct": 2.0, "priceChg1h": None,
             "poolAgeHours": 20.0, "volMcap24h": 1.2, "binStep": 100, "holdMin": 180.0, "entryHourLocal": 19},
            {"symbol": "BBB", "pool": "P_STD", "tokenMint": "M2", "positions": ["POS3"], "entryTs": ts,
             "capitalSol": 2.0, "pnlSol": -0.2, "feesSol": 0.05, "pnlPct": -10.0, "priceChg1h": None,
             "poolAgeHours": 10.0, "volMcap24h": 0.5, "binStep": 80, "holdMin": 60.0, "entryHourLocal": 3},
        ]
        cfg = {"gates": {"maxPriceChg1hPct": 5}, "flags": {"nightEntryLocalHours": [0, 9]}}
        res = review.summarize(es, cfg, data_dir=tmp)
        coins = {c["symbol"]: c for c in res["coins"]}
        self.assertEqual(coins["AAA"]["avgChg1h"], 10.0)     # None ignored, not averaged as 0
        self.assertIsNone(coins["BBB"]["avgChg1h"])
        self.assertAlmostEqual(res["netPnl"]["txFeeSol"], 0.00102, places=5)
        self.assertLess(res["netPnl"]["netPnlSol"], res["netPnl"]["grossPnlSol"])
        self.assertEqual(res["campaigns"]["flipped"]["n"], 2)
        self.assertEqual(res["campaigns"]["standard"]["n"], 1)
        self.assertEqual(res["counterfactual"]["savedDump40"], 1)
        self.assertEqual(res["counterfactual"]["missedSafe"], 1)
        self.assertEqual(res["counterfactual"]["followedRules"]["n"], 2)
        self.assertEqual(res["counterfactual"]["overridden"]["n"], 1)
        narr_map = {n["tag"]: n for n in res["narratives"]}
        self.assertEqual(narr_map["KUAT"]["n"], 2)
        self.assertEqual(narr_map["tanpa riset"]["n"], 1)
        self.assertEqual(len(res["breakdowns"]["byBinStep"]), 2)


class SettingsAndTgBotTests(unittest.TestCase):
    def test_new_settings_keys_roundtrip(self):
        tmp = Path(tempfile.mkdtemp()) / "settings.json"
        base = json.loads((Path(settings.__file__).resolve().parent / "config.json").read_text())
        with mock.patch.object(settings, "PATH", tmp):
            ov = settings.save(base, {
                "flip.staleAskHours": "8",
                "tx.parallelSlices": "4",
                "autoReentry.abovePct": "7.5",
                "web.backgroundPickMin": "10",
                "web.tgBot": False,
            })
            self.assertEqual(ov["flip.staleAskHours"], 8.0)
            self.assertEqual(ov["tx.parallelSlices"], 4)
            cfg = settings.apply(json.loads(json.dumps(base)))
            self.assertEqual(cfg["flip"]["staleAskHours"], 8.0)
            self.assertEqual(cfg["tx"]["parallelSlices"], 4)
            self.assertEqual(cfg["autoReentry"]["abovePct"], 7.5)
            self.assertEqual(cfg["web"]["backgroundPickMin"], 10)
            self.assertFalse(cfg["web"]["tgBot"])

    def test_tgbot_pause_resume_and_health(self):
        tmp = Path(tempfile.mkdtemp())
        cfg = cli.load_config(None)
        with mock.patch.object(web, "_pause_file", lambda: tmp / "paused.json"):
            reply, _ = tgbot.handle_command("/pause", cfg, web)
            self.assertIn("PAUSED", reply)
            self.assertTrue(web.is_paused())
            reply, _ = tgbot.handle_command("/health", cfg, web)
            self.assertIn("PAUSED", reply)
            toast, msg = tgbot.handle_callback("pause:toggle", cfg, web)
            self.assertEqual(toast, "Resumed")
            self.assertFalse(web.is_paused())

    def test_multi_benchmark_smart_lp_consensus(self):
        cfg = cli.load_config(None)
        cfg["signal"]["benchmarkWallets"] = ["WALLET_B_11111111111111111111111111111111"]
        prof = {"wallet": "WALLET_A_11111111111111111111111111111111", "days": 20, "bands": {}, "binSteps": {}}
        state = {}
        sent = []
        fake_c = {"pool": "POOL1", "name": "MEME-SOL", "symbol": "MEME", "gatesFailed": [], "flags": [],
                  "feeApr24h": 2000, "feeApr1h": 1500, "tvlUsd": 50000, "poolAgeHours": 10, "mcapUsd": 1e6,
                  "binStep": 100, "fees1hUsd": 50, "fees24hUsd": 1000, "priceChg1h": 1, "priceChg6h": 2,
                  "sizeVsTvlPct": 2, "priceSol": 0.001, "plan": {"strategy": "Spot", "side": "SOL-only", "sizeSol": 8, "rangeBottomPct": -70}}
        fake_m = {"score": 1.0, "hits": ["x"], "misses": [], "dims": 1}
        holdings = {"WALLET_A_11111111111111111111111111111111": [], "WALLET_B_11111111111111111111111111111111": []}
        with mock.patch.object(cli.api, "open_portfolio", lambda w: holdings[w]), \
             mock.patch.object(cli.api, "pool", lambda p: {"address": p}), \
             mock.patch.object(cli, "_candidate", lambda *a, **k: (fake_c, fake_m)), \
             mock.patch.object(cli, "notify", sent.append), \
             mock.patch.object(cli, "append", lambda *a: None):
            # Initial tick learns empty sets
            self.assertEqual(cli._wallet_entries(cfg, prof, state, now=1000.0), [])
            # Both wallets enter POOL1 within 10 minutes
            holdings["WALLET_A_11111111111111111111111111111111"] = [{"poolAddress": "POOL1"}]
            out1 = cli._wallet_entries(cfg, prof, state, now=1100.0)
            self.assertEqual(out1[0]["kind"], "walletEntry")
            holdings["WALLET_B_11111111111111111111111111111111"] = [{"poolAddress": "POOL1"}]
            out2 = cli._wallet_entries(cfg, prof, state, now=1600.0)
            self.assertEqual(out2[0]["kind"], "walletConsensus")
            self.assertIn("SMART LP CONSENSUS", sent[-1])


if __name__ == "__main__":
    unittest.main()
