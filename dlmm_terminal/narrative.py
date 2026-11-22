"""🔎 Narasi: research what a token's story is, who is talking about it, and its red flags, before you open a ladder.

Grok (xAI Responses API with the x_search + web_search tools) first: memecoin narratives live on X. When Grok has no key,
runs out of credit / rate limit, or fails, the same question goes to Claude (Anthropic SDK, web_search server tool).
Keys in .env: XAI_API_KEY, ANTHROPIC_API_KEY. Results are cached per token (narrative.cacheHours) in data/narrative/
and logged to data/narratives.jsonl, so 📊 Review can later tell which kinds of narrative paid.

Context, not a signal: the answer can be wrong, so every claim should carry a source; nothing here opens or blocks a trade.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import api, blast

DIR = Path(__file__).resolve().parent / "data" / "narrative"
LOG = Path(__file__).resolve().parent / "data" / "narratives.jsonl"
XAI_URL = "https://api.x.ai/v1/responses"
DEFAULTS = {"grokModel": "grok-4.7", "claudeModel": "claude-opus-5-5", "cacheHours": 6, "xDays": 14, "maxTurns": 4,
            "claudeMaxSearches": 5}
TAGS = ("KUAT", "SEDANG", "LEMAH", "BAHAYA")

SYSTEM = (
    "Kamu analis narasi memecoin Solana buat LP (liquidity provider) yang mau buka posisi DLMM. "
    "Jawab dalam Bahasa Indonesia santai (lu/gue), singkat dan padat, pakai bullet. "
    "Jangan ngarang: setiap klaim harus dari sumber yang kamu temuin (sebut akun X / situsnya). "
    "Kalau nggak nemu sesuatu, bilang nggak nemu. Bedain fakta dari dugaan."
)


def token_info(mint: str) -> dict:
    """Free context from DexScreener: socials, websites, first pair time, boosts (one request)."""
    req = urllib.request.Request(blast.TOKEN_PAIRS + mint, headers={"User-Agent": "dlmm-terminal/1", "Accept": "application/json"})
    try:
        with api.urlopen(req, timeout=10) as r:
            pairs = json.load(r) or []
    except Exception:
        return {}
    socials, sites, first, boosts, name, sym = {}, set(), None, 0, None, None
    for p in pairs:
        info = p.get("info") or {}
        for s in info.get("socials") or []:
            if s.get("url"):
                socials[s.get("type") or "link"] = s["url"]
        for w in info.get("websites") or []:
            if w.get("url"):
                sites.add(w["url"])
        t = p.get("pairCreatedAt")
        first = t if t and (first is None or t < first) else first
        boosts = max(boosts, (p.get("boosts") or {}).get("active") or 0)
        base = p.get("baseToken") or {}
        if base.get("address") == mint:
            name, sym = base.get("name"), base.get("symbol")
    return {"name": name, "symbol": sym, "socials": socials, "websites": sorted(sites), "boosts": boosts,
            "firstPairAt": datetime.fromtimestamp(first / 1000, timezone.utc).isoformat(timespec="minutes") if first else None,
            "pairs": len(pairs)}


def prompt(mint: str, symbol: str, info: dict, extra: dict | None = None) -> str:
    e = extra or {}
    lines = [f"Token: {info.get('name') or symbol} (${info.get('symbol') or symbol}) · Solana mint {mint}"]
    if info.get("firstPairAt"):
        lines.append(f"Pair pertama: {info['firstPairAt']} UTC")
    if info.get("socials"):
        lines.append("Social resmi: " + ", ".join(f"{k}: {v}" for k, v in info["socials"].items()))
    if info.get("websites"):
        lines.append("Website: " + ", ".join(info["websites"]))
    if info.get("boosts"):
        lines.append(f"DexScreener boost aktif: {info['boosts']}")
    for k, lab in (("mcapUsd", "Mcap $"), ("priceChg1h", "Harga 1h %"), ("priceChg24h", "Harga 24h %"), ("vol24hUsd", "Volume 24h $")):
        if e.get(k) is not None:
            lines.append(f"{lab}: {e[k]:,.2f}" if isinstance(e[k], (int, float)) else f"{lab}: {e[k]}")
    return "\n".join(lines) + """

Riset token ini (cari di X dan web, fokus 2 minggu terakhir) dan jawab persis dengan bagian ini:
1. **Narasi**: ceritanya apa (1-2 kalimat). Meme / AI / celeb / politik / tech / copycat dari token lain?
2. **Momentum**: narasinya baru mulai, lagi naik, puncak, atau udah basi? Kapan mulai rame?
3. **Siapa yang ngomongin**: akun besar / KOL (sebut handle + kira-kira follower), komunitas organik, atau kebanyakan bot / shill / akun baru? Akun resmi token: umur akun, follower, aktif nggak?
4. **Red flags**: ticker/nama sama dengan token lain (copycat), dev atau wallet besar jual, bundling / sniper, klaim palsu (partnership, listing), akun resmi baru dibuat, website kosong.
5. **Kesimpulan**: satu kalimat buat LP: kuat atau nggak narasinya, dan apa yang perlu dicek sebelum buka posisi.

Baris terakhir harus persis: TAG: KUAT atau TAG: SEDANG atau TAG: LEMAH atau TAG: BAHAYA"""


class ProviderError(Exception):
    def __init__(self, msg: str, fallback: bool = True):
        super().__init__(msg)
        self.fallback = fallback


def _tag(text: str) -> str | None:
    m = re.search(r"TAG:\s*\**\s*(KUAT|SEDANG|LEMAH|BAHAYA)", text or "", re.I)
    return m.group(1).upper() if m else None


def ask_grok(user: str, nc: dict) -> dict:
    key = os.environ.get("XAI_API_KEY")
    if not key:
        raise ProviderError("XAI_API_KEY belum diisi")
    since = (datetime.now(timezone.utc) - timedelta(days=int(nc["xDays"]))).strftime("%Y-%m-%d")
    body = {"model": nc["grokModel"], "max_turns": int(nc["maxTurns"]),
            "input": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
            "tools": [{"type": "x_search", "from_date": since}, {"type": "web_search"}]}
    req = urllib.request.Request(XAI_URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "User-Agent": "dlmm-terminal/1"})
    try:
        with api.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        why = {401: "key xAI salah", 402: "kredit xAI habis", 403: "akses xAI ditolak / kredit habis", 429: "limit xAI kena"}
        raise ProviderError(f"Grok HTTP {exc.code} ({why.get(exc.code, 'error')}): {detail}") from None
    except Exception as exc:
        raise ProviderError(f"Grok nggak jawab: {exc}") from None
    text, sources = [], {}
    for item in d.get("output") or []:
        if item.get("type") != "message":
            continue
        for c in item.get("content") or []:
            if c.get("type") == "output_text":
                text.append(c.get("text") or "")
                for a in c.get("annotations") or []:
                    if a.get("type") == "url_citation" and a.get("url"):
                        sources.setdefault(a["url"], a.get("title") or a["url"])
    for u in d.get("citations") or []:
        if isinstance(u, str):
            sources.setdefault(u, u)
    out = "\n".join(text).strip()
    if not out:
        raise ProviderError("Grok balikin jawaban kosong")
    usage = d.get("usage") or {}
    tools = usage.get("server_side_tool_usage_details") or {}
    return {"provider": "grok", "model": d.get("model") or nc["grokModel"], "text": out,
            "sources": [{"url": u, "title": t} for u, t in sources.items()],
            "usage": {"in": usage.get("input_tokens"), "out": usage.get("output_tokens"),
                      "xPosts": tools.get("x_posts_fetched"), "xSearches": tools.get("x_search_calls")}}


def ask_claude(user: str, nc: dict) -> dict:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise ProviderError("ANTHROPIC_API_KEY belum diisi", fallback=False)
    try:
        import anthropic
    except ImportError:
        raise ProviderError("paket 'anthropic' belum ke-install: python3 -m pip install --user anthropic", fallback=False) from None
    client = anthropic.Anthropic(timeout=240.0)
    messages = [{"role": "user", "content": user}]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": int(nc["claudeMaxSearches"])}]
    try:
        for _ in range(3):                                  # a long server-tool turn can pause: send it back to continue
            resp = client.beta.messages.create(
                model=nc["claudeModel"], max_tokens=16000, system=SYSTEM, messages=messages, tools=tools,
                output_config={"effort": "medium"},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
            if resp.stop_reason != "pause_turn":
                break
            messages = messages + [{"role": "assistant", "content": resp.content}]
    except anthropic.AuthenticationError:
        raise ProviderError("key Anthropic salah", fallback=False) from None
    except anthropic.RateLimitError:
        raise ProviderError("limit Anthropic kena, coba lagi sebentar", fallback=False) from None
    except anthropic.APIStatusError as exc:
        raise ProviderError(f"Claude HTTP {exc.status_code}: {exc.message[:200]}", fallback=False) from None
    except anthropic.APIConnectionError:
        raise ProviderError("Claude nggak kejangkau (internet?)", fallback=False) from None
    if resp.stop_reason == "refusal":
        raise ProviderError("Claude nolak pertanyaan ini", fallback=False)
    text, sources = [], {}
    for b in resp.content:
        if b.type == "text":
            text.append(b.text)
            for c in getattr(b, "citations", None) or []:
                url = getattr(c, "url", None)
                if url:
                    sources.setdefault(url, getattr(c, "title", None) or url)
        elif b.type == "web_search_tool_result" and isinstance(b.content, list):
            for r in b.content:
                url = getattr(r, "url", None)
                if url:
                    sources.setdefault(url, getattr(r, "title", None) or url)
    out = "".join(text).strip()
    if not out:
        raise ProviderError("Claude balikin jawaban kosong", fallback=False)
    u = resp.usage
    return {"provider": "claude", "model": resp.model, "text": out,
            "sources": [{"url": k, "title": v} for k, v in sources.items()],
            "usage": {"in": u.input_tokens, "out": u.output_tokens,
                      "searches": getattr(getattr(u, "server_tool_use", None), "web_search_requests", None)}}


def _cache_path(mint: str) -> Path:
    return DIR / f"{re.sub(r'[^A-Za-z0-9]', '', mint)[:64]}.json"


def cached(mint: str) -> dict | None:
    try:
        return json.loads(_cache_path(mint).read_text())
    except (OSError, ValueError):
        return None


def research(mint: str, symbol: str, cfg: dict, pool: str | None = None, extra: dict | None = None,
             force: bool = False, prefer: str = "grok") -> dict:
    nc = {**DEFAULTS, **(cfg.get("narrative") or {})}
    hit = cached(mint)
    if hit and not force and time.time() - hit.get("t", 0) < float(nc["cacheHours"]) * 3600:
        return {**hit, "cached": True}
    info = token_info(mint)
    user = prompt(mint, symbol, info, extra)
    tried = []
    order = [ask_grok, ask_claude] if prefer != "claude" else [ask_claude]
    res = None
    for fn in order:
        try:
            res = fn(user, nc)
            break
        except ProviderError as exc:
            tried.append(str(exc))
            if not exc.fallback:
                break
    if res is None:
        return {"ok": False, "error": " | ".join(tried) or "nggak ada provider", "tried": tried}
    out = {"ok": True, "t": time.time(), "mint": mint, "symbol": symbol, "pool": pool, "tag": _tag(res["text"]),
           "fallbackFrom": tried, "info": info, **res}
    DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(mint).write_text(json.dumps(out))
    with LOG.open("a") as f:
        f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "mint": mint, "symbol": symbol,
                            "pool": pool, "provider": res["provider"], "model": res["model"], "tag": out["tag"],
                            "usage": res["usage"], "fallbackFrom": tried}) + "\n")
    return out
