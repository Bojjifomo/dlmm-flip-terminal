import unittest

from dlmm_terminal import review

CFG = {"gates": {"maxPriceChg1hPct": 5}, "flags": {"pump1hPct": 25, "youngPoolHours": 6, "volMcapBand": [0.3, 3], "maxBinStep": 100}}


def e(sym, chg1h, pnl, fee, cap=5.0, age=48.0, vm=1.0, bs=100, hold=120.0):
    return {"symbol": sym, "pool": sym, "entryTs": "2026-11-10T00:00:00+00:00", "capitalSol": cap, "pnlSol": pnl, "feesSol": fee,
            "pnlPct": pnl / cap * 100, "priceChg1h": chg1h, "poolAgeHours": age, "volMcap24h": vm, "binStep": bs, "holdMin": hold}


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.es = ([e(f"A{i}", -3, 0.15, 0.2) for i in range(6)] +          # flat/red hour: +3%
                   [e(f"B{i}", 12, -0.05, 0.2) for i in range(6)])          # after a +12% hour: -1%

    def test_totals_split_fee_and_price(self):
        r = review.summarize(self.es, CFG)
        self.assertEqual(r["total"]["n"], 12)
        self.assertAlmostEqual(r["total"]["feesSol"], 2.4)
        self.assertAlmostEqual(r["total"]["priceSol"], 0.6 - 2.4)

    def test_pump_rule_proven_with_loto(self):
        r = review.summarize(self.es, CFG)
        pump = next(x for x in r["rules"] if x["key"] == "pump1h")
        self.assertEqual((pump["kept"]["n"], pump["out"]["n"]), (6, 6))
        self.assertEqual(pump["holdsLoto"], 12)
        self.assertEqual(pump["verdict"], "kebukti")

    def test_coin_classes(self):
        es = [e("GOOD", 0, 0.2, 0.25), e("ATE", 0, -0.1, 0.3), e("THIN", 0, 0.02, 0.05)]
        cls = {c["symbol"]: c["class"] for c in review.summarize(es, CFG)["coins"]}
        self.assertEqual(cls, {"GOOD": "good", "ATE": "priceAte", "THIN": "thin"})

    def test_rule_off_is_left_out_and_small_sample_says_so(self):
        r = review.summarize(self.es[:7], {"gates": {"maxPriceChg1hPct": None}, "flags": {"maxBinStep": 100}})
        self.assertEqual([x["key"] for x in r["rules"]], ["binStep"])
        self.assertEqual(r["rules"][0]["verdict"], "data kurang")


if __name__ == "__main__":
    unittest.main()
