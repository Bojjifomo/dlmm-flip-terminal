import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import mock

from dlmm_terminal import narrative

OK = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 4, "duration_ms": 61000,
      "result": "**Narasi**: kucing AI.\nSUMBER:\nhttps://x.com/a/status/1\nhttps://dexscreener.com/solana/abc.\nTAG: KUAT",
      "usage": {"input_tokens": 10, "output_tokens": 5, "server_tool_use": {"web_search_requests": 3, "web_fetch_requests": 1}},
      "modelUsage": {"claude-opus-5-5": {}}}


class NarrativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(narrative, "DIR", Path(self.tmp.name) / "n"),
                  mock.patch.object(narrative, "LOG", Path(self.tmp.name) / "n.jsonl"),
                  mock.patch.object(narrative, "token_info", lambda mint: {"symbol": "CAT"}),
                  mock.patch.object(narrative, "find_claude", lambda: "/usr/bin/claude")]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        self.tmp.cleanup()

    def test_claude_code_answer_parsed_cached_and_never_gets_an_api_key(self):
        seen = {}

        def run(cmd, **kw):
            seen["cmd"], seen["env"] = cmd, kw["env"]
            return NS(returncode=0, stdout=json.dumps(OK), stderr="")
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-x", "ANTHROPIC_AUTH_TOKEN": "t"}), \
             mock.patch.object(narrative.subprocess, "run", run):
            r = narrative.research("MINT1", "CAT", {})
        self.assertTrue(r["ok"])
        self.assertEqual((r["provider"], r["tag"], r["model"]), ("claude-code", "KUAT", "claude-opus-5-5"))
        self.assertEqual([s["url"] for s in r["sources"]], ["https://x.com/a/status/1", "https://dexscreener.com/solana/abc"])
        self.assertEqual(r["usage"]["turns"], 4)
        self.assertNotIn("ANTHROPIC_API_KEY", seen["env"])           # subscription, never API credit
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", seen["env"])
        self.assertIn("WebSearch,WebFetch", seen["cmd"])
        self.assertEqual(seen["cmd"][seen["cmd"].index("--tools") + 1], "WebSearch,WebFetch")
        self.assertTrue(narrative.research("MINT1", "CAT", {})["cached"])  # second ask: from cache

    def test_not_logged_in_and_limit_say_what_to_do(self):
        for msg, hint in (("Invalid API key · Please run /login", "login"), ("Claude usage limit reached", "jatah langganan")):
            out = json.dumps({"type": "result", "is_error": True, "result": msg})
            with mock.patch.object(narrative.subprocess, "run", lambda cmd, **kw: NS(returncode=1, stdout=out, stderr="")):
                r = narrative.research("MINT-" + hint, "CAT", {})
            self.assertFalse(r["ok"])
            self.assertIn(hint, r["error"])

    def test_missing_cli_and_timeout(self):
        with mock.patch.object(narrative, "find_claude", lambda: None):
            self.assertIn("install.sh", narrative.research("M2", "CAT", {})["error"])

        def slow(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 1)
        with mock.patch.object(narrative.subprocess, "run", slow):
            self.assertIn("nggak selesai", narrative.research("M3", "CAT", {})["error"])


if __name__ == "__main__":
    unittest.main()
