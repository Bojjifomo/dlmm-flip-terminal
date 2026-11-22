"""Wallet review: what your own ladders of the last N days earned, coin by coin, and whether the entry
rules (config.json gates / flags) would have kept you in the good ones.

build()      every ladder you opened in the window (Meteora data API, 0 RPC): slices opened within
             30 min in one pool are one entry, with the pool's state at entry (price 1h / 6h, age, fees,
             volume / mcap, bin step) and its result (PnL, fees, price loss = PnL - fees).
summarize()  totals, per coin (good: fees and price held / fees eaten by price / thin fees), and each
             rule's split: entries it would have let in vs kept out, with a leave-one-coin-out check.

The web runs it in the background (📊 Review in Portfolio) and keeps the last result in data/review.json.
Small samples: it says how many entries each number stands on, and never changes a setting by itself.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from . import api, benchmark, filters

PATH = Path(__file__).resolve().parent / "data" / "review.json"
_state = {"running": False, "progress": "", "error": None}
_lock = threading.Lock()


def build(wallet: str, days: float = 30, now: float | None = None, log=lambda s: None) -> list[dict]:
    now = now or time.time()
    since = now - days * 86400
    pools = [p for p in api.portfolio(wallet, since) if benchmark._side(p)]
    out = []
    for i, row in enumerate(pools, 1):
        addr, side = row["poolAddress"], benchmark._side(row)
        try:
            pos = [p for p in api.position_pnl(addr, wallet, "closed") if p["createdAt"] >= since]
            try:
                pos += [p for p in api.position_pnl(addr, wallet, "open") if p["createdAt"] >= since]
            except Exception:
                pass
            if not pos:
                continue
            snap = api.pool(addr)
            start = int(min(p["createdAt"] for p in pos) - 25 * 3600)
            end = int(min(now, max((p.get("closedAt") or now) for p in pos) + 3600))
            vol = api.chunked(api.volume_history, addr, start, end)
            candles = api.chunked(api.ohlcv, addr, start, end)
        except Exception as exc:
            log(f"skip {row.get('tokenX')}: {exc}")
            continue
        for g in benchmark.group_entries(pos):
            f = benchmark.entry_features(g, snap, vol, candles, side)
            t = min(p["createdAt"] for p in g)
            hour = t - t % 3600
            f["open"] = any(not p.get("closedAt") for p in g)
            f["feesSol"] = round(sum(float(((p.get("allTimeFees") or {}).get("total") or {}).get("sol") or 0) for p in g), 4)
            f["vol24hUsd"] = round(benchmark._bucket_sum(vol, "volume", hour - 86400, hour), 2)
            f["volMcap24h"] = round(f["vol24hUsd"] / f["mcapUsd"], 3) if f.get("mcapUsd") else None
            out.append(f)
        log(f"{i}/{len(pools)} {row.get('tokenX')}")
    return sorted(out, key=lambda e: e["entryTs"])


def _sum(es: list[dict]) -> dict:
    cap = sum(e["capitalSol"] for e in es)
    pnl = sum(e["pnlSol"] for e in es)
    fee = sum(e["feesSol"] for e in es)
    return {"n": len(es), "capitalSol": round(cap, 3), "pnlSol": round(pnl, 4), "feesSol": round(fee, 4),
            "priceSol": round(pnl - fee, 4), "pnlPct": round(pnl / cap * 100, 2) if cap else None,
            "feePct": round(fee / cap * 100, 2) if cap else None, "pricePct": round((pnl - fee) / cap * 100, 2) if cap else None,
            "wins": sum(e["pnlSol"] > 0 for e in es), "bigLosses": sum((e["pnlPct"] or 0) < -2 for e in es)}


def _rules(cfg: dict) -> list[tuple[str, str, object]]:
    """(key, text, keep(entry) -> True/False/None) for each rule that is on in cfg."""
    g, fl = cfg.get("gates", {}), cfg.get("flags", {})
    out = []
    if g.get("maxPriceChg1hPct") is not None:
        m = g["maxPriceChg1hPct"]
        out.append(("pump1h", f"gate: harga 1h ≤ +{m:g}%", lambda e: None if e["priceChg1h"] is None else e["priceChg1h"] <= m))
    if fl.get("youngPoolHours") is not None:
        h = fl["youngPoolHours"]
        out.append(("youngPool", f"flag: pool ≥ {h:g} jam", lambda e: e["poolAgeHours"] >= h))
    if fl.get("volMcapBand"):
        lo, hi = fl["volMcapBand"]
        out.append(("volMcap", f"flag: vol 24h ÷ mcap {lo:g}–{hi:g}×", lambda e: None if e.get("volMcap24h") is None else lo <= e["volMcap24h"] <= hi))
    if fl.get("maxBinStep") is not None:
        b = fl["maxBinStep"]
        out.append(("binStep", f"flag: bin step ≤ {b}", lambda e: None if e["binStep"] is None else e["binStep"] <= b))
    if fl.get("pump1hPct") is not None:
        p = fl["pump1hPct"]
        out.append(("pump1hFlag", f"flag: harga 1h < +{p:g}%", lambda e: None if e["priceChg1h"] is None else e["priceChg1h"] < p))
    return out


def summarize(entries: list[dict], cfg: dict) -> dict:
    es = [e for e in entries if e["capitalSol"] and e["capitalSol"] > 0.05]
    coins: dict[str, list[dict]] = {}
    for e in es:
        coins.setdefault(e["symbol"] or e["pool"][:6], []).append(e)
    per_coin = []
    for sym, g in coins.items():
        s = _sum(g)
        cls = ("good" if s["feePct"] >= 3 and s["pnlPct"] >= 2.5 else
               "priceAte" if s["feePct"] >= 3 else "thin")
        per_coin.append({"symbol": sym, "class": cls, "binSteps": sorted({e["binStep"] for e in g if e["binStep"]}),
                         "avgChg1h": round(sum(e["priceChg1h"] or 0 for e in g) / len(g), 1), **s})
    per_coin.sort(key=lambda c: -c["pnlSol"])
    rules = []
    syms = list(coins)
    for key, text, keep in _rules(cfg):
        a = [e for e in es if keep(e) is True]
        b = [e for e in es if keep(e) is False]
        sa, sb = _sum(a), _sum(b)
        # Does the split hold when any one coin is left out?
        holds = 0
        for s in syms:
            xa, xb = _sum([e for e in a if e["symbol"] != s]), _sum([e for e in b if e["symbol"] != s])
            if xa["pnlPct"] is not None and xb["pnlPct"] is not None and xa["pnlPct"] > xb["pnlPct"]:
                holds += 1
        verdict = ("kebukti" if sb["n"] >= 5 and sa["pnlPct"] is not None and sb["pnlPct"] is not None
                   and sa["pnlPct"] > sb["pnlPct"] and holds >= 0.8 * len(syms) else
                   "data kurang" if sb["n"] < 5 else "belum kebukti")
        rules.append({"key": key, "text": text, "kept": sa, "out": sb, "holdsLoto": holds, "coins": len(syms), "verdict": verdict})
    hold = {"<4h": _sum([e for e in es if e["holdMin"] < 240]), "4-10h": _sum([e for e in es if 240 <= e["holdMin"] < 600]),
            ">10h": _sum([e for e in es if e["holdMin"] >= 600])}
    return {"total": _sum(es), "coins": per_coin, "rules": rules, "hold": hold,
            "from": es[0]["entryTs"] if es else None, "to": es[-1]["entryTs"] if es else None}


def load() -> dict | None:
    try:
        return json.loads(PATH.read_text())
    except (OSError, ValueError):
        return None


def status() -> dict:
    with _lock:
        return {**_state, "last": load()}


def start(wallet: str, cfg: dict, days: float = 30) -> dict:
    """Run build + summarize in a thread (a few minutes for ~30 pools); the result lands in data/review.json."""
    with _lock:
        if _state["running"]:
            return {"ok": True, "running": True}
        _state.update(running=True, progress="mulai…", error=None)

    def work():
        try:
            def log(s):
                with _lock:
                    _state["progress"] = s
            entries = build(wallet, days, log=log)
            res = {"t": time.time(), "wallet": wallet, "days": days, "entries": entries, **summarize(entries, cfg)}
            PATH.parent.mkdir(exist_ok=True)
            PATH.write_text(json.dumps(res))
        except Exception as exc:
            with _lock:
                _state["error"] = str(exc)[:300]
        finally:
            with _lock:
                _state["running"] = False
                _state["progress"] = ""

    threading.Thread(target=work, daemon=True).start()
    return {"ok": True, "running": True}
