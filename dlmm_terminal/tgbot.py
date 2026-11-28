"""Lightweight 2-way Telegram interactive bot (stdlib only, no extra packages).

Runs as a background daemon thread inside DLMM Web when DLMM_TG_BOT_TOKEN and DLMM_TG_CHAT_ID
are set (and web.tgBot is enabled). Strictly accepts messages and button presses ONLY from
DLMM_TG_CHAT_ID.

Commands:
  /pf              portfolio summary (PnL, deployed %, SOL vs token exposure)
  /pick            current 🎯 PICK pools (with 🔎 Riset & ★ Watch buttons)
  /health          daemon loops, pause status, Helius RPC pace & landing times
  /pause /resume   global kill-switch for auto-exit, auto-flip, and auto-reentry
  /narr <SYM|MINT> run Claude Code narrative research and reply here
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request

from . import api, narrative

# Short callback_data registry (Telegram limits callback_data to 64 bytes)
_cb_lock = threading.Lock()
_cb_map: dict[str, dict] = {}


def register_cb(kind: str, payload: dict) -> str:
    """Register an action payload and return a <=40-byte callback_data token."""
    key = f"{kind}:{payload.get('id') or payload.get('pool', '')[:12] or payload.get('position', '')[:12]}"
    with _cb_lock:
        _cb_map[key] = {"kind": kind, **payload, "t": time.time()}
        if len(_cb_map) > 500:
            oldest = sorted(_cb_map, key=lambda k: _cb_map[k]["t"])[:100]
            for k in oldest:
                _cb_map.pop(k, None)
    return key[:64]


def _tg_call(token: str, method: str, fields: dict, timeout: float = 15) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(fields).encode()
    with api.urlopen(url, timeout=timeout, data=data) as r:
        return json.load(r)


def _send(token: str, chat_id: str, text: str, reply_markup: dict | None = None) -> None:
    from .cli import _tg_chunks
    chunks = _tg_chunks(text)
    for i, chunk in enumerate(chunks):
        fields = {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": "true"}
        if reply_markup and i == len(chunks) - 1:
            fields["reply_markup"] = json.dumps(reply_markup)
        try:
            _tg_call(token, "sendMessage", fields, timeout=12)
        except Exception:
            pass


def _answer_cb(token: str, cb_id: str, text: str = "") -> None:
    try:
        _tg_call(token, "answerCallbackQuery", {"callback_query_id": cb_id, "text": text[:180]}, timeout=8)
    except Exception:
        pass


def handle_command(text: str, cfg: dict, web_mod) -> tuple[str, dict | None]:
    """Process one authorized text command and return (reply_text, optional reply_markup)."""
    parts = (text or "").strip().split()
    if not parts:
        return "", None
    cmd = parts[0].lower().split("@")[0]
    arg = " ".join(parts[1:]).strip()

    if cmd in ("/start", "/help"):
        return (
            "🤖 DLMM Terminal Bot\n"
            "/pf — ringkasan portfolio & exposure (SOL vs token)\n"
            "/pick — pool 🎯 PICK sekarang\n"
            "/narr <SYMBOL/MINT> — riset narasi Claude Code\n"
            "/health — status daemon, auto-pause, RPC Helius\n"
            "/pause — matikan sementara semua auto-trade\n"
            "/resume — nyalakan lagi semua auto-trade"
        ), None

    if cmd == "/pause":
        web_mod.set_paused(True)
        return "⏸ AUTO-TRADE PAUSED. Semua auto-exit, auto-flip, dan auto-reentry ditahan sampai /resume.", None

    if cmd == "/resume":
        web_mod.set_paused(False)
        return "▶️ AUTO-TRADE RESUMED. Auto-exit, auto-flip, dan auto-reentry aktif kembali.", None

    if cmd == "/health":
        h = web_mod.health_report(cfg)
        rpc = h.get("rpc") or {}
        loops = ", ".join(f"{k}:{'ok' if not v.get('error') else 'ERR'}" for k, v in (h.get("loops") or {}).items())
        lines = [
            f"🩺 DLMM Health · {'⏸ PAUSED' if h.get('paused') else '▶️ ACTIVE'}",
            f"Loops: {loops or '-'}",
            f"RPC 30d: Helius {rpc.get('helius', 0)} (pace ≈ {rpc.get('pace30d', 0):,}/30d) · public {rpc.get('public', 0)}",
        ]
        for l in (rpc.get("landing") or [])[:5]:
            lines.append(l)
        return "\n".join(lines), None

    if cmd == "/pf":
        tw = web_mod.node.trade_wallet()
        wallet = tw.get("pubkey") or os.environ.get("DLMM_WALLET")
        if not wallet:
            return "Wallet belum di-set di .env (DLMM_WALLET / DLMM_PRIVATE_KEY).", None
        pf = web_mod.portfolio(wallet, cfg)
        exp = pf.get("exposure") or {}
        pnl_pct = pf["pnlSol"] / pf["depositSol"] * 100 if pf.get("depositSol") else 0.0
        lines = [
            f"💼 PORTFOLIO ({wallet[:6]}…{wallet[-4:]}) · {'⏸ PAUSED' if web_mod.is_paused() else '▶️ ACTIVE'}",
            f"Nilai: ◎{pf['valueSol']:.3f} · Fee unclaimed: ◎{pf['unclaimedSol']:.4f} · Wallet bebas: ◎{pf.get('walletSol') or 0:.3f}",
            f"PnL: {pf['pnlSol']:+.4f} SOL ({pnl_pct:+.2f}%) · Deposit: ◎{pf['depositSol']:.2f}",
            f"Exposure: {exp.get('deployedPct', 0):.1f}% bankroll ({exp.get('pools', 0)} pool) · SOL-only: {exp.get('solOnlyPools', 0)} · Pegang token: {exp.get('tokenExposedPools', 0)}",
        ]
        by_pool: dict[str, list[dict]] = {}
        for r in pf.get("rows") or []:
            by_pool.setdefault(r["pool"], []).append(r)
        for pool, rs in list(by_pool.items())[:8]:
            p = rs[0]
            pnl_s = p.get("poolPnlSol") or 0
            dep_s = p.get("poolDepositSol") or 0
            pct = pnl_s / dep_s * 100 if dep_s else 0
            stale = any(r.get("staleAsk") for r in rs)
            lines.append(f"• {p['symbol']} ({len(rs)}s): {pnl_s:+.3f} SOL ({pct:+.1f}%){' 🧊STALE' if stale else ''}")
        kb = {"inline_keyboard": [[{"text": "▶️ Resume Auto" if web_mod.is_paused() else "⏸ Pause Auto", "callback_data": "pause:toggle"}]]}
        return "\n".join(lines), kb

    if cmd == "/pick":
        data = web_mod.pool_rows(cfg, 2000, force=False)
        picks = sorted([r for r in data.get("rows") or [] if r.get("pick")],
                       key=lambda r: -(r.get("feePctDay", {}).get("1h") or r.get("feePctDay", {}).get("24h") or 0))
        if not picks:
            return "🎯 PICK: belum ada pool yang lolos filter review sekarang.", None
        lines = [f"🎯 PICK sekarang ({len(picks)} pool):"]
        btns = []
        for r in picks[:6]:
            nt = f" [{r['narrativeTag']}]" if r.get("narrativeTag") else ""
            f1h = (r.get("fees", {}).get("1h") or 0) / r["tvlUsd"] * 100 if r.get("tvlUsd") else 0
            lines.append(
                f"• {r['symbol']}{nt} bin {r['binStep']} · 1h {r['priceChg1h']:+.0f}% · fee 1j {f1h:.2f}% ({r['feePctDay']['24h']:.0f}%/d)"
                f" · TVL ${r['tvlUsd']:,.0f}"
            )
            cb_n = register_cb("narr", {"pool": r["pool"], "mint": r["tokenMint"], "symbol": r["symbol"],
                                        "mcapUsd": r.get("mcapUsd"), "priceChg1h": r.get("priceChg1h"),
                                        "priceChg24h": r.get("priceChg24h"), "vol24hUsd": r.get("vol24")})
            cb_w = register_cb("watch", {"pool": r["pool"], "symbol": r["symbol"]})
            btns.append([
                {"text": f"🔎 Riset {r['symbol']}", "callback_data": cb_n},
                {"text": f"★ Watch {r['symbol']}", "callback_data": cb_w},
            ])
        return "\n".join(lines), {"inline_keyboard": btns[:5]}

    if cmd == "/narr":
        if not arg:
            return "Pakai: /narr <SYMBOL atau MINT>", None
        data = web_mod.pool_rows(cfg, 1000, force=False)
        low = arg.lower()
        hit = next((r for r in data.get("rows") or []
                    if (r.get("symbol") or "").lower() == low or (r.get("tokenMint") or "").lower() == low), None)
        mint = hit["tokenMint"] if hit else arg
        sym = hit["symbol"] if hit else arg[:10]
        extra = {k: hit.get(k) for k in ("mcapUsd", "priceChg1h", "priceChg24h", "vol24") if hit and hit.get(k) is not None} if hit else None
        res = narrative.research(mint, sym, cfg, pool=hit["pool"] if hit else None, extra=extra)
        if not res.get("ok"):
            return f"✗ Riset {sym} gagal: {res.get('error')}", None
        return f"🔎 NARASI {sym} [{res.get('tag') or '?'}]\n\n{res.get('text', '')[:3400]}", None

    return "", None


def handle_callback(data_str: str, cfg: dict, web_mod) -> tuple[str, str]:
    """Handle inline button press. Returns (toast_text, message_to_send)."""
    if data_str == "pause:toggle":
        new_state = not web_mod.is_paused()
        web_mod.set_paused(new_state)
        return ("Paused" if new_state else "Resumed"), ("⏸ AUTO-TRADE PAUSED." if new_state else "▶️ AUTO-TRADE RESUMED.")

    with _cb_lock:
        payload = _cb_map.get(data_str)
    if not payload:
        return "Tombol kadaluarsa", ""

    kind = payload.get("kind")
    if kind == "watch":
        web_mod.watch_set(payload["pool"], payload.get("symbol", ""), True)
        return f"★ {payload.get('symbol')} masuk watchlist", f"★ {payload.get('symbol')} ditambahkan ke watchlist."

    if kind == "narr":
        sym = payload.get("symbol") or payload.get("mint", "")[:8]
        extra = {k: payload.get(k) for k in ("mcapUsd", "priceChg1h", "priceChg24h", "vol24hUsd") if payload.get(k) is not None}
        res = narrative.research(payload["mint"], sym, cfg, pool=payload.get("pool"), extra=extra)
        if not res.get("ok"):
            return "Riset gagal", f"✗ Riset narasi {sym} gagal: {res.get('error')}"
        return f"Narasi {sym}: {res.get('tag')}", f"🔎 NARASI {sym} [{res.get('tag') or '?'}]\n\n{res.get('text', '')[:3400]}"

    if kind == "flip":
        if web_mod.is_paused():
            return "Auto lagi di-pause", "⏸ Auto-trade lagi di-pause (/resume dulu kalau mau flip)."
        if not web_mod.node.trade_wallet().get("ok"):
            return "Key belum diset", "✗ DLMM_PRIVATE_KEY belum kebaca di .env."
        res = web_mod.flip_run(cfg, payload["pool"], payload["position"], payload["to"], payload.get("symbol", ""), source="telegram")
        return ("Flip OK" if res.get("ok") else "Flip gagal"), ""   # flip_run already notifies Telegram

    return "Unknown action", ""


def poll_loop(cfg: dict, web_mod, health_cb=None) -> None:
    """Long-polling Telegram loop. Quietly idles when token/chat or web.tgBot is off."""
    offset = 0
    while True:
        token = os.environ.get("DLMM_TG_BOT_TOKEN")
        chat = os.environ.get("DLMM_TG_CHAT_ID")
        enabled = bool((cfg.get("web") or {}).get("tgBot", True))
        if not token or not chat or not enabled:
            if health_cb:
                health_cb("tgBot", None, "idle (off/no token)")
            time.sleep(15)
            continue
        try:
            res = _tg_call(token, "getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": json.dumps(["message", "callback_query"])}, timeout=35)
            if health_cb:
                health_cb("tgBot", None, "ok")
            for upd in res.get("result") or []:
                offset = max(offset, int(upd["update_id"]) + 1)
                msg = upd.get("message")
                if msg and str((msg.get("chat") or {}).get("id")) == str(chat) and msg.get("text"):
                    txt = msg["text"]
                    def _run_cmd(t=txt):
                        try:
                            reply, kb = handle_command(t, cfg, web_mod)
                            if reply:
                                _send(token, chat, reply, kb)
                        except Exception as exc:
                            _send(token, chat, f"✗ Error: {str(exc)[:200]}")
                    threading.Thread(target=_run_cmd, daemon=True).start()
                cb = upd.get("callback_query")
                if cb and str(((cb.get("message") or {}).get("chat") or {}).get("id")) == str(chat):
                    cb_id, cb_data = cb["id"], cb.get("data") or ""
                    _answer_cb(token, cb_id, "⏳ diproses…")
                    def _run_cb(d=cb_data):
                        try:
                            _, reply = handle_callback(d, cfg, web_mod)
                            if reply:
                                _send(token, chat, reply)
                        except Exception as exc:
                            _send(token, chat, f"✗ Error: {str(exc)[:200]}")
                    threading.Thread(target=_run_cb, daemon=True).start()
        except Exception as exc:
            if health_cb:
                health_cb("tgBot", str(exc)[:160])
            time.sleep(10)
