import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from dlmm_terminal import narrative

GROK_OK = {"model": "grok-4.7", "output": [
    {"type": "x_search_call"},
    {"type": "message", "content": [{"type": "output_text", "text": "**Narasi**: kucing AI [[1]](https://x.com/a/status/1)\nTAG: KUAT",
                                     "annotations": [{"type": "url_citation", "url": "https://x.com/a/status/1", "title": "1"}]}]}],
    "usage": {"input_tokens": 100, "output_tokens": 50, "server_side_tool_usage_details": {"x_posts_fetched": 12, "x_search_calls": 2}}}


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class NarrativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(narrative, "DIR", Path(self.tmp.name) / "n"),
                  mock.patch.object(narrative, "LOG", Path(self.tmp.name) / "n.jsonl"),
                  mock.patch.object(narrative, "token_info", lambda mint: {"symbol": "CAT"})]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        self.tmp.cleanup()

    def test_grok_answer_parsed_with_sources_tag_and_cache(self):
        with mock.patch.dict(os.environ, {"XAI_API_KEY": "k"}), \
             mock.patch.object(narrative.api, "urlopen", lambda req, timeout=0: Resp(json.dumps(GROK_OK).encode())):
            r = narrative.research("MINT1", "CAT", {})
        self.assertTrue(r["ok"])
        self.assertEqual((r["provider"], r["tag"]), ("grok", "KUAT"))
        self.assertEqual(r["sources"][0]["url"], "https://x.com/a/status/1")
        self.assertEqual(r["usage"]["xPosts"], 12)
        self.assertTrue(narrative.research("MINT1", "CAT", {})["cached"])           # second ask: from cache, no call

    def test_grok_out_of_credit_falls_back_to_claude(self):
        def boom(req, timeout=0):
            raise urllib.error.HTTPError(narrative.XAI_URL, 402, "Payment Required", {}, io.BytesIO(b"no credits"))
        claude = {"provider": "claude", "model": "claude-opus-5-5", "text": "ok\nTAG: LEMAH", "sources": [], "usage": {}}
        with mock.patch.dict(os.environ, {"XAI_API_KEY": "k"}), mock.patch.object(narrative.api, "urlopen", boom), \
             mock.patch.object(narrative, "ask_claude", lambda user, nc: claude):
            r = narrative.research("MINT2", "CAT", {})
        self.assertEqual((r["provider"], r["tag"]), ("claude", "LEMAH"))
        self.assertIn("kredit xAI habis", r["fallbackFrom"][0])

    def test_no_keys_says_so(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            r = narrative.research("MINT3", "CAT", {})
        self.assertFalse(r["ok"])
        self.assertIn("XAI_API_KEY", r["error"])
        self.assertIn("ANTHROPIC_API_KEY", r["error"])


if __name__ == "__main__":
    unittest.main()
