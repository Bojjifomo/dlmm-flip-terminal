"""🔎 Narasi: research what a token's story is, who is talking about it, and its red flags, before you open a ladder.

Runs Claude Code (`claude -p`, web search + web fetch only) on this Mac, logged in with the owner's Claude subscription,
so it uses the subscription's usage, not API credit: no API key is read or passed. Results are cached per token
(narrative.cacheHours) in data/narrative/ and logged to data/narratives.jsonl, so 📊 Review can later tell which kinds
of narrative paid.

Context, not a signal: the answer can be wrong, so every claim should carry a source; nothing here opens or blocks a trade.
"""
from __future__ import annotations

import json
import os
import re
import time
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import api, blast

DIR = Path(__file__).resolve().parent / "data" / "narrative"
LOG = Path(__file__).resolve().parent / "data" / "narratives.jsonl"
DEFAULTS = {"cacheHours": 6, "timeoutSec": 300, "model": None}   # model None = Claude Code's default for the subscription
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

Pakai web search (termasuk cari di x.com / twitter.com, DexScreener, pump.fun, situs token). Jangan jalanin hal lain.
Sesudah kesimpulan tulis "SUMBER:" lalu daftar URL yang kamu pakai, satu per baris.
Baris terakhir harus persis: TAG: KUAT atau TAG: SEDANG atau TAG: LEMAH atau TAG: BAHAYA"""


class ProviderError(Exception):
    pass


def _tag(text: str) -> str | None:
    m = re.search(r"TAG:\s*\**\s*(KUAT|SEDANG|LEMAH|BAHAYA)", text or "", re.I)
    return m.group(1).upper() if m else None


def find_claude() -> str | None:
    """The Claude Code CLI. A server started from Finder may not have ~/.local/bin on PATH, so look there too."""
    hit = shutil.which("claude")
    if hit:
        return hit
    for p in ("~/.local/bin/claude", "~/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        p = os.path.expanduser(p)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _sources(text: str) -> list[dict]:
    out, seen = [], set()
    for url in re.findall(r"https?://[^\s)\]>\"']+", text or ""):
        url = url.rstrip(".,;")
        if url not in seen:
            seen.add(url)
            out.append({"url": url, "title": url})
    return out


def ask_claude_code(user: str, nc: dict) -> dict:
    """Claude Code in print mode, logged in with the owner's Claude subscription: the usage counts against the
    subscription, not API credit. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from its environment on
    purpose, or Claude Code would bill that key instead. Only the web tools are available to it."""
    exe = find_claude()
    if not exe:
        raise ProviderError("Claude Code belum ke-install di Mac ini: jalanin  curl -fsSL https://claude.ai/install.sh | bash  "
                            "lalu  claude  sekali buat login pakai akun Claude lu")
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    cmd = [exe, "-p", user, "--output-format", "json", "--append-system-prompt", SYSTEM,
           "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--permission-mode", "dontAsk",
           "--no-session-persistence", "--strict-mcp-config"]
    if nc.get("model"):
        cmd += ["--model", str(nc["model"])]
    DIR.mkdir(parents=True, exist_ok=True)          # run outside the repo: no project CLAUDE.md or settings
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=float(nc["timeoutSec"]), env=env, cwd=str(DIR))
    except subprocess.TimeoutExpired:
        raise ProviderError(f"Claude Code nggak selesai dalam {nc['timeoutSec']:g} detik") from None
    try:
        d = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
    except ValueError:
        d = {}
    text = (d.get("result") or "").strip()
    if r.returncode != 0 or d.get("is_error") or not text:
        why = text or (r.stderr or r.stdout or "").strip()[-300:] or f"exit {r.returncode}"
        low = why.lower()
        if "login" in low or "not logged in" in low or "authenticat" in low or "api key" in low:
            why += "  → buka Terminal, jalanin  claude  dan login pakai akun Claude lu (langganan)"
        elif "limit" in low:
            why += "  → jatah langganan lagi abis; coba lagi setelah reset"
        raise ProviderError(f"Claude Code: {why[:400]}")
    u = d.get("usage") or {}
    return {"provider": "claude-code", "model": next(iter(d.get("modelUsage") or {}), None) or "claude-code", "text": text,
            "sources": _sources(text),
            "usage": {"in": u.get("input_tokens"), "out": u.get("output_tokens"), "turns": d.get("num_turns"),
                      "seconds": round((d.get("duration_ms") or 0) / 1000)}}


def _cache_path(mint: str) -> Path:
    return DIR / f"{re.sub(r'[^A-Za-z0-9]', '', mint)[:64]}.json"


def cached(mint: str) -> dict | None:
    try:
        return json.loads(_cache_path(mint).read_text())
    except (OSError, ValueError):
        return None


def research(mint: str, symbol: str, cfg: dict, pool: str | None = None, extra: dict | None = None,
             force: bool = False) -> dict:
    nc = {**DEFAULTS, **(cfg.get("narrative") or {})}
    hit = cached(mint)
    if hit and not force and time.time() - hit.get("t", 0) < float(nc["cacheHours"]) * 3600:
        return {**hit, "cached": True}
    info = token_info(mint)
    user = prompt(mint, symbol, info, extra)
    try:
        res = ask_claude_code(user, nc)
    except ProviderError as exc:
        return {"ok": False, "error": str(exc)}
    out = {"ok": True, "t": time.time(), "mint": mint, "symbol": symbol, "pool": pool, "tag": _tag(res["text"]),
           "info": info, **res}
    DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(mint).write_text(json.dumps(out))
    with LOG.open("a") as f:
        f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "mint": mint, "symbol": symbol,
                            "pool": pool, "provider": res["provider"], "model": res["model"], "tag": out["tag"],
                            "usage": res["usage"]}) + "\n")
    return out
