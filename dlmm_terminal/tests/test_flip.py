import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dlmm_terminal import exits, flip, web

CFG = {"confirmMinutes": 4, "confirmChecks": 2, "maxFlipsPer24h": 8}


class FlipDecisionTest(unittest.TestCase):
    def test_side_from_where_it_sits(self):
        self.assertEqual(flip.side_of(1.0, 0.3, 0.9, True), "bid")      # SOL waiting below the price
        self.assertEqual(flip.side_of(0.2, 0.3, 0.9, False), "ask")     # token waiting above the price
        self.assertEqual(flip.side_of(0.5, 0.3, 0.9, True), "bid")      # in range: what was deposited
        self.assertIsNone(flip.side_of(0.5, 0.3, 0.9, False))

    def test_bid_flips_after_confirm_window(self):
        st = flip.FlipState(side="bid")
        d = flip.evaluate(0, 0.25, 0.3, 0.9, True, st, CFG, 0)          # price fell through the bottom
        self.assertEqual(d.kind, "confirming")
        d = flip.evaluate(120, 0.25, 0.3, 0.9, True, st, CFG, 0)        # 2 checks, only 2 minutes
        self.assertEqual(d.kind, "confirming")
        d = flip.evaluate(300, 0.25, 0.3, 0.9, True, st, CFG, 0)
        self.assertEqual((d.kind, d.to), ("flip", "ask"))

    def test_wick_resets(self):
        st = flip.FlipState(side="bid")
        flip.evaluate(0, 0.25, 0.3, 0.9, True, st, CFG, 0)
        d = flip.evaluate(120, 0.5, 0.3, 0.9, True, st, CFG, 0)         # back in range
        self.assertEqual(d.kind, "wait")
        self.assertIsNone(st.crossed_since)
        d = flip.evaluate(300, 0.25, 0.3, 0.9, True, st, CFG, 0)
        self.assertEqual(d.kind, "confirming")

    def test_ask_flips_back_when_price_runs_up(self):
        st = flip.FlipState(side="ask")
        flip.evaluate(0, 1.2, 0.3, 0.9, False, st, CFG, 0)
        d = flip.evaluate(300, 1.2, 0.3, 0.9, False, st, CFG, 0)
        self.assertEqual((d.kind, d.to), ("flip", "bid"))

    def test_daily_limit(self):
        st = flip.FlipState(side="bid")
        flip.evaluate(0, 0.2, 0.3, 0.9, True, st, CFG, 8)
        self.assertEqual(flip.evaluate(600, 0.2, 0.3, 0.9, True, st, CFG, 8).kind, "limit")

    def test_armed_pool_is_not_closed_below_range(self):
        ex = {"closeBelowRangeAfterMin": 10, "priceStopBelowEntryPct": -40, "alertAtPnlPct": -10}
        t = exits.Tick("P", "POOL", "X", 10_000, None, -5, None, price=0.2, range_min=0.3, range_max=0.9)
        st = exits.State(below_since=0)
        self.assertTrue(any(e["kind"] == "close" for e in exits.evaluate(t, st, ex)))
        st = exits.State(below_since=0)
        self.assertFalse(any(e["kind"] == "close" for e in exits.evaluate(t, st, flip.exits_for(ex, True))))


class FlipLoopTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.p = [mock.patch.object(web, "_flip_file", lambda: self.tmp / "flip.json"),
                  mock.patch.object(web, "_auto_file", lambda: self.tmp / "auto_exit.json"),
                  mock.patch("dlmm_terminal.cli.append", lambda *a, **k: None),
                  mock.patch("dlmm_terminal.cli.notify", lambda *a, **k: None)]
        for x in self.p:
            x.start()
        self.cfg = {"flip": {"confirmMinutes": 0, "confirmChecks": 1}}

    def tearDown(self):
        for x in self.p:
            x.stop()

    def ticks(self, price):
        return lambda w, now: [exits.Tick("POS", "POOL", "X", now, None, -3, None, price=price, range_min=0.3, range_max=0.9)]

    def test_auto_sends_flip_and_tracks_new_position(self):
        web.flip_set("POOL", "X", "auto")
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(1.0)), mock.patch.object(web.node, "run") as run:
            web.flip_once(self.cfg, "W")                                 # price above the bid: waiting
            run.assert_not_called()
        res = {"ok": True, "newPosition": "NEW", "range": {"lo": 1, "hi": 70}}
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(0.2)), \
                mock.patch.object(web.node, "run", return_value=res) as run:
            done = web.flip_once(self.cfg, "W")
            self.assertEqual(run.call_args[0][0], "flip.mjs")
            self.assertIn("ask", run.call_args[0][1])
        self.assertEqual(done, [{"pool": "POOL", "position": "POS", "to": "ask", "ok": True}])
        d = web.flip_load()
        self.assertNotIn("POS", d["positions"])
        self.assertEqual(d["positions"]["NEW"]["side"], "ask")
        self.assertEqual(flip.flips_24h(d, "POOL", d["history"][-1]["at"]), 1)
        # the API does not list NEW yet: it is kept, not forgotten
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", lambda w, now: []):
            web.flip_once(self.cfg, "W")
        self.assertIn("NEW", web.flip_load()["positions"])

    def ladder(self, price):
        """A 3-slice SOL ladder under the price: 0.7-0.9, 0.5-0.7, 0.3-0.5."""
        return lambda w, now: [exits.Tick(f"S{i}", "POOL", "X", now, None, -3, None, price=price, range_min=lo, range_max=hi)
                               for i, (lo, hi) in enumerate(((0.7, 0.9), (0.5, 0.7), (0.3, 0.5)), 1)]

    def test_bids_wait_for_the_whole_ladder_then_flip_together(self):
        web.flip_set("POOL", "X", "auto")
        res = {"ok": True, "newPosition": "NEW", "range": {"lo": 1, "hi": 70}}
        # price through slices 1 and 2 but still inside slice 3: nothing flips
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ladder(0.45)), mock.patch.object(web.node, "run") as run:
            web.flip_once(self.cfg, "W")
            run.assert_not_called()
        st = web.flip_load()["positions"]["S1"]
        self.assertFalse(st["ready"])
        self.assertIn("seluruh ladder", st["msg"])
        # under the bottom of slice 3: all three flip
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ladder(0.25)), \
                mock.patch.object(web.node, "run", return_value=res) as run:
            done = web.flip_once(self.cfg, "W")
        self.assertEqual(sorted(x["position"] for x in done), ["S1", "S2", "S3"])

    def test_whole_ladder_off_flips_per_slice(self):
        web.flip_set("POOL", "X", "auto")
        cfg = {"flip": {**self.cfg["flip"], "wholeLadder": False}}
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ladder(0.45)), \
                mock.patch.object(web.node, "run", return_value={"ok": True, "newPosition": "N", "range": {"lo": 1, "hi": 2}}):
            done = web.flip_once(cfg, "W")
        self.assertEqual(sorted(x["position"] for x in done), ["S1", "S2"])

    def test_a_flip_turns_the_tp_off(self):
        web.flip_set("POOL", "X", "auto")
        web.auto_set("POOL", "X", 5)
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(0.2)), \
                mock.patch.object(web.node, "run", return_value={"ok": True, "newPosition": "NEW", "range": {"lo": 1, "hi": 70}}):
            web.flip_once(self.cfg, "W")
        a = web.auto_load()["POOL"]
        self.assertEqual(a["status"], "disarmed")
        self.assertIn("flip", a["msg"])
        self.assertFalse(web.auto_disarm("POOL", "again"))              # already off: nothing to do

    def test_alert_mode_waits_for_the_button(self):
        web.flip_set("POOL", "X", "alert")
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(0.2)), mock.patch.object(web.node, "run") as run:
            web.flip_once(self.cfg, "W")
            run.assert_not_called()
        st = web.flip_load()["positions"]["POS"]
        self.assertTrue(st["ready"])
        self.assertEqual(st["to"], "ask")

    def test_not_ready_on_chain_is_not_history(self):
        web.flip_set("POOL", "X", "auto")
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(0.2)), \
                mock.patch.object(web.node, "run", return_value={"ok": False, "notReady": True, "error": "belum"}):
            web.flip_once(self.cfg, "W")
        d = web.flip_load()
        self.assertEqual(d["history"], [])
        self.assertIn("POS", d["positions"])

    def test_failed_flip_backs_off(self):
        web.flip_set("POOL", "X", "auto")
        with mock.patch("dlmm_terminal.cli.ticks_for_wallet", self.ticks(0.2)), \
                mock.patch.object(web.node, "run", return_value={"ok": False, "error": "SOL kurang"}) as run:
            web.flip_once(self.cfg, "W")
            web.flip_once(self.cfg, "W")
            self.assertEqual(run.call_count, 1)
        self.assertEqual(web.flip_load()["positions"]["POS"]["error"], "SOL kurang")


if __name__ == "__main__":
    unittest.main()
