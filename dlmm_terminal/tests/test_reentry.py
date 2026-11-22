import unittest

from dlmm_terminal import reentry

S = [{"rangeMin": 0.5, "rangeMax": 1.0, "solOnly": True}, {"rangeMin": 0.3, "rangeMax": 0.5, "solOnly": True}]
CFG = {"abovePct": 5, "confirmChecks": 2, "respectEntryCheck": True, "cooldownMin": 30, "maxPer24h": 6}
NOW = 1_800_000_000.0


class ReentryTests(unittest.TestCase):
    def test_waits_below_trigger_and_resets_checks(self):
        d = reentry.evaluate(NOW, S, 1.04, {"checks": 1}, CFG, 0, None)
        self.assertEqual((d.kind, d.checks), ("wait", 0))

    def test_needs_confirm_checks_then_fires(self):
        d = reentry.evaluate(NOW, S, 1.06, {"checks": 0}, CFG, 0, None)
        self.assertEqual((d.kind, d.checks), ("wait", 1))
        d = reentry.evaluate(NOW, S, 1.06, {"checks": 1}, CFG, 0, [])
        self.assertEqual(d.kind, "fire")

    def test_entry_check_blocks_when_respected(self):
        d = reentry.evaluate(NOW, S, 1.2, {"checks": 5}, CFG, 0, ["pump1h: +12% > +5% (wait for a dip)"])
        self.assertEqual(d.kind, "wait")
        self.assertIn("entry check", d.msg)
        d = reentry.evaluate(NOW, S, 1.2, {"checks": 5}, {**CFG, "respectEntryCheck": False}, 0, ["pump1h"])
        self.assertEqual(d.kind, "fire")

    def test_cooldown_cap_and_token_ladders(self):
        self.assertEqual(reentry.evaluate(NOW, S, 1.2, {"checks": 5, "lastAt": NOW - 600}, CFG, 0, []).kind, "wait")
        self.assertEqual(reentry.evaluate(NOW, S, 1.2, {"checks": 5}, CFG, 6, []).kind, "wait")
        mixed = S + [{"rangeMin": 1.1, "rangeMax": 1.3, "solOnly": False}]
        self.assertEqual(reentry.evaluate(NOW, mixed, 2.0, {"checks": 5}, CFG, 0, []).kind, "wait")

    def test_plan_keeps_slices_and_depth(self):
        self.assertEqual(reentry.plan(S), {"slices": 2, "bottom": 70.0})


if __name__ == "__main__":
    unittest.main()
