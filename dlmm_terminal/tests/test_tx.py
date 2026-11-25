import unittest

from dlmm_terminal import node
from dlmm_terminal.cli import tx_landing_lines


class TxEnv(unittest.TestCase):
    def test_config_to_env(self):
        env = node.tx_env({"tx": {"priorityLevel": "VeryHigh", "maxFeeSol": 0.002, "minMicroLamports": 10000,
                                  "sender": "off", "senderTipSol": 0.00002, "rebroadcastSec": 1.5, "parallelSlices": 0}})
        self.assertEqual(env, {"DLMM_FEE_LEVEL": "VeryHigh", "DLMM_FEE_MAX_LAMPORTS": "2000000", "DLMM_FEE_MIN_MICRO": "10000",
                               "DLMM_SENDER": "off", "DLMM_SENDER_TIP_LAMPORTS": "20000", "DLMM_REBROADCAST_MS": "1500",
                               "DLMM_PARALLEL_SLICES": "1"})

    def test_bool_sender_and_missing(self):
        self.assertEqual(node.tx_env({"tx": {"sender": False}}), {"DLMM_SENDER": "off"})
        self.assertEqual(node.tx_env({}), {})

    def test_repo_config_has_tx(self):
        env = node.tx_env()
        self.assertEqual(env.get("DLMM_FEE_MAX_LAMPORTS"), "1000000")
        self.assertEqual(env.get("DLMM_SENDER"), "swqos")


class Landing(unittest.TestCase):
    def test_summary(self):
        rows = [{"tx": [{"label": "slice 1", "ms": 3000, "ok": True, "sends": 2, "feeLamports": 100000, "tipLamports": 10000},
                        {"label": "slice 2", "ms": 5000, "ok": True, "sends": 3, "feeLamports": 100000, "tipLamports": 10000},
                        {"label": "close ab12", "ms": 90000, "ok": False, "expired": True, "sends": 40}]}]
        out = "\n".join(tx_landing_lines(rows))
        self.assertIn("3 transaksi", out)
        self.assertIn("buka slice", out)
        self.assertIn("expired 1", out)
        self.assertIn("median 5.0s", out)

    def test_empty(self):
        self.assertIn("belum ada data", tx_landing_lines([{}])[0])


if __name__ == "__main__":
    unittest.main()
