"""Wallet review: what your own ladders of the last N days earned, coin by coin, and whether the entry
rules (config.json gates / flags) would have kept you in the good ones.

build()      every ladder you opened in the window (Meteora data API, 0 RPC): slices opened within
             30 min in one pool are one entry, with the pool's state at entry (price 1h / 6h, age, fees,
             volume / mcap, bin step) and its result (PnL, fees, price loss = PnL - fees).
summarize()  totals, per coin (good: fees and price held / fees eaten by price / thin fees), each
             rule's split with a leave-one-coin-out check, PLUS local-log analytics:
               - netPnl: Gross Meteora PnL minus tx fees/tips (rpc_usage.jsonl) & swap slippage stats
               - campaigns: Flipped / Re-entered lifecycle campaigns vs standard ladders (flips.jsonl)
               - counterfactual: Skipped candidate followups (followup.jsonl) & Override audit (decisions.jsonl)
               - narratives: PnL by narrative research tag (narratives.jsonl)
               - breakdowns: by bin step, entry hour (day/night WIB), and ladder size

The web runs it in the background (📊 Review in Portfolio) and keeps the last result in data/review.json.
Small samples: it says how many entries each number stands on, and never changes a setting by itself.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import api, benchmark, filters

DATA = Path(__file__).resolve().parent / "data"
PATH = DATA / "review.json"
_state = {"running": False, "progress": "", "error": None}
_lock = threading.Lock()


def _read_jsonl(name: str, data_dir: Path | None = None) -> list[dict]:
    p = (data_dir or DATA) / name
    if not p.exists():
        return []
    rows = []
    try:
        for line in p.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        return []
    return rows


def _parse_ts(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


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
        tok = snap["token_x"] if side == "y" else snap["token_y"]
        for g in benchmark.group_entries(pos):
            f = benchmark.entry_features(g, snap, vol, candles, side)
            t = min(p["createdAt"] for p in g)
            hour = t - t % 3600
            f["open"] = any(not p.get("closedAt") for p in g)
            f["tokenMint"] = tok.get("address")
            f["positions"] = [p.get("positionAddress") for p in g if p.get("positionAddress")]
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
    if g.get("minPoolAgeMinutes") and g["minPoolAgeMinutes"] >= 120:
        h = g["minPoolAgeMinutes"] / 60
        out.append(("poolAge", f"gate: pool ≥ {h:g} jam", lambda e: e["poolAgeHours"] >= h))
    elif fl.get("youngPoolHours") is not None:
        h = fl["youngPoolHours"]
        out.append(("youngPool", f"flag: pool ≥ {h:g} jam", lambda e: e["poolAgeHours"] >= h))
    band = fl.get("volMcapBand")
    if band and band[0] is not None and band[1] is not None:
        lo, hi = band
        out.append(("volMcap", f"flag: vol 24h ÷ mcap {lo:g}–{hi:g}×", lambda e: None if e.get("volMcap24h") is None else lo <= e["volMcap24h"] <= hi))
    if fl.get("maxBinStep") is not None:
        b = fl["maxBinStep"]
        out.append(("binStep", f"flag: bin step ≤ {b}", lambda e: None if e["binStep"] is None else e["binStep"] <= b))
    if fl.get("pump1hPct") is not None:
        p = fl["pump1hPct"]
        out.append(("pump1hFlag", f"flag: harga 1h < +{p:g}%", lambda e: None if e["priceChg1h"] is None else e["priceChg1h"] < p))
    return out


def _net_pnl_stats(es: list[dict], gross_pnl_sol: float, data_dir: Path | None = None) -> dict:
    """Estimate True Net PnL by subtracting tx priority fees + Sender tips (rpc_usage.jsonl)
    and tracking swap slippage/recovery from swaps.jsonl in the review window."""
    t_min = min((_parse_ts(e.get("entryTs")) or 0 for e in es), default=0)
    t_max = max((_parse_ts(e.get("entryTs")) or 0 for e in es), default=time.time()) + 86400 * 3
    rpc_rows = _read_jsonl("rpc_usage.jsonl", data_dir)
    tx_fee_sol = 0.0
    tx_count = 0
    for r in rpc_rows:
        ts = _parse_ts(r.get("ts"))
        if ts is None or not (t_min <= ts <= t_max):
            continue
        for tx in r.get("tx") or []:
            tx_fee_sol += ((tx.get("feeLamports") or 0) + (tx.get("tipLamports") or 0)) / 1e9
            tx_count += 1
    swaps = _read_jsonl("swaps.jsonl", data_dir)
    swap_sol = 0.0
    swap_n = 0
    swap_fail = 0
    slip_sol = 0.0
    for s in swaps:
        ts = _parse_ts(s.get("ts"))
        if ts is None or not (t_min <= ts <= t_max):
            continue
        if s.get("ok") and s.get("sol"):
            sol = float(s["sol"])
            swap_sol += sol
            swap_n += 1
            under = s.get("underPct")
            if under is not None and float(under) > 0:
                slip_sol += sol * float(under) / (100.0 - min(99.0, float(under)))
        elif not s.get("ok"):
            swap_fail += 1
    return {
        "grossPnlSol": round(gross_pnl_sol, 4),
        "txFeeSol": round(tx_fee_sol, 5),
        "txCount": tx_count,
        "swapCount": swap_n,
        "swapFailCount": swap_fail,
        "swapProceedsSol": round(swap_sol, 4),
        "swapSlippageSol": round(slip_sol, 4),
        "netPnlSol": round(gross_pnl_sol - tx_fee_sol - slip_sol, 4),
    }


def _campaigns_stats(es: list[dict], data_dir: Path | None = None) -> dict:
    """Group entries into flipped/re-entered lifecycle campaigns vs standard ladders."""
    flips = [f for f in _read_jsonl("flips.jsonl", data_dir) if f.get("ok")]
    reentries = [c for c in _read_jsonl("closes.jsonl", data_dir) if c.get("source") == "auto-reentry" and c.get("ok")]
    flipped_pools = {f.get("pool") for f in flips if f.get("pool")}
    flipped_pos = {p for f in flips for p in (f.get("position"), f.get("newPosition")) if p}
    reentered_pools = {c.get("pool") for c in reentries if c.get("pool")}

    flipped_es, std_es = [], []
    for e in es:
        pos_set = set(e.get("positions") or [])
        is_flip = bool(pos_set & flipped_pos) or e.get("pool") in flipped_pools
        (flipped_es if is_flip else std_es).append(e)

    # Collapse all entries of a flipped pool into one campaign row so lifecycle PnL is honest
    by_pool: dict[str, list[dict]] = {}
    for e in flipped_es:
        by_pool.setdefault(e["pool"], []).append(e)
    camp_rows = []
    for pool, g in by_pool.items():
        s = _sum(g)
        pool_flips = sum(1 for f in flips if f.get("pool") == pool)
        camp_rows.append({"pool": pool, "symbol": g[0].get("symbol") or pool[:6], "legs": len(g),
                          "flips": pool_flips, **s})
    camp_rows.sort(key=lambda x: -x["pnlSol"])
    return {
        "flipped": _sum(flipped_es),
        "standard": _sum(std_es),
        "flipsTotal": len(flips),
        "reentriesTotal": len(reentries),
        "reenteredPools": len(reentered_pools),
        "campaigns": camp_rows[:12],
    }


def _counterfactual_stats(es: list[dict], data_dir: Path | None = None) -> dict:
    """Audit skipped candidates (followup.jsonl) and rules-followed vs override entries (decisions.jsonl)."""
    followups = _read_jsonl("followup.jsonl", data_dir)
    skipped = [f for f in followups if f.get("decision") == "skip" and f.get("minVsEntryPct") is not None]
    dumped40 = sum(1 for f in skipped if (f.get("minVsEntryPct") or 0) <= -40)
    dumped60 = sum(1 for f in skipped if (f.get("minVsEntryPct") or 0) <= -60)
    stayed_safe = sum(1 for f in skipped if (f.get("minVsEntryPct") or 0) > -15 and (f.get("chg24hPct") or 0) >= -5)

    decisions = _read_jsonl("decisions.jsonl", data_dir)
    # Match each entry to an enter decision within ±20 min on the same pool
    enters = [d for d in decisions if d.get("decision") == "enter" and d.get("pool")]
    followed, overridden = [], []
    for e in es:
        ts = _parse_ts(e.get("entryTs"))
        if ts is None:
            continue
        hit = None
        for d in enters:
            dts = _parse_ts(d.get("ts"))
            if d["pool"] == e.get("pool") and dts is not None and abs(dts - ts) <= 1200:
                hit = d
                break
        if hit is not None:
            (overridden if hit.get("override") else followed).append(e)
    return {
        "skippedFollowed": len(skipped),
        "savedDump40": dumped40,
        "savedDump60": dumped60,
        "missedSafe": stayed_safe,
        "followedRules": _sum(followed),
        "overridden": _sum(overridden),
    }


def _narrative_stats(es: list[dict], data_dir: Path | None = None) -> list[dict]:
    """Join narratives.jsonl tags (KUAT/SEDANG/LEMAH/BAHAYA) to entries opened within 24h after research."""
    narrs = _read_jsonl("narratives.jsonl", data_dir)
    if not narrs:
        return []
    buckets: dict[str, list[dict]] = {}
    for e in es:
        ets = _parse_ts(e.get("entryTs"))
        tag = "tanpa riset"
        best_dt = float("inf")
        for n in narrs:
            nts = _parse_ts(n.get("ts"))
            if nts is None or ets is None:
                continue
            same = (e.get("tokenMint") and n.get("mint") == e.get("tokenMint")) or (n.get("pool") == e.get("pool")) or (n.get("symbol") == e.get("symbol"))
            if same and 0 <= ets - nts <= 86400 and (ets - nts) < best_dt and n.get("tag"):
                best_dt = ets - nts
                tag = str(n["tag"]).upper()
        buckets.setdefault(tag, []).append(e)
    order = ("KUAT", "SEDANG", "LEMAH", "BAHAYA", "tanpa riset")
    return [{"tag": t, **_sum(buckets[t])} for t in order if t in buckets]


def _breakdowns(es: list[dict], cfg: dict) -> dict:
    """Entry hour (day vs night WIB), bin step, and ladder size breakdowns."""
    lo, hi = (cfg.get("flags") or {}).get("nightEntryLocalHours") or [0, 9]
    night = [e for e in es if e.get("entryHourLocal") is not None and lo <= e["entryHourLocal"] < hi]
    day = [e for e in es if e.get("entryHourLocal") is not None and not (lo <= e["entryHourLocal"] < hi)]

    by_bin: dict[str, list[dict]] = {}
    for e in es:
        if e.get("binStep") is not None:
            by_bin.setdefault(str(e["binStep"]), []).append(e)
    bin_rows = [{"binStep": int(k), **_sum(v)} for k, v in sorted(by_bin.items(), key=lambda kv: int(kv[0]))]

    by_size = {
        "<3 SOL": _sum([e for e in es if e["capitalSol"] < 3]),
        "3–6 SOL": _sum([e for e in es if 3 <= e["capitalSol"] <= 6]),
        ">6 SOL": _sum([e for e in es if e["capitalSol"] > 6]),
    }
    return {
        "bySession": {"siang": _sum(day), f"malam ({lo:02d}-{hi:02d} WIB)": _sum(night)},
        "byBinStep": bin_rows,
        "bySize": by_size,
    }


def summarize(entries: list[dict], cfg: dict, data_dir: Path | None = None) -> dict:
    es = [e for e in entries if e["capitalSol"] and e["capitalSol"] > 0.05]
    coins: dict[str, list[dict]] = {}
    for e in es:
        coins.setdefault(e["symbol"] or e["pool"][:6], []).append(e)
    per_coin = []
    for sym, g in coins.items():
        s = _sum(g)
        cls = ("good" if s["feePct"] >= 3 and s["pnlPct"] >= 2.5 else
               "priceAte" if s["feePct"] >= 3 else "thin")
        # Fix bias: average only over entries that actually have a priceChg1h reading
        chg_vals = [e["priceChg1h"] for e in g if e.get("priceChg1h") is not None]
        avg_chg = round(sum(chg_vals) / len(chg_vals), 1) if chg_vals else None
        per_coin.append({"symbol": sym, "class": cls, "binSteps": sorted({e["binStep"] for e in g if e["binStep"]}),
                         "avgChg1h": avg_chg, **s})
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
    tot = _sum(es)
    return {
        "total": tot,
        "netPnl": _net_pnl_stats(es, tot["pnlSol"], data_dir),
        "campaigns": _campaigns_stats(es, data_dir),
        "counterfactual": _counterfactual_stats(es, data_dir),
        "narratives": _narrative_stats(es, data_dir),
        "breakdowns": _breakdowns(es, cfg),
        "coins": per_coin,
        "rules": rules,
        "hold": hold,
        "from": es[0]["entryTs"] if es else None,
        "to": es[-1]["entryTs"] if es else None,
    }


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
