"""On-chain token safety (0 RPC, RugCheck) & DLMM microstructure analytics.

All functions here are pure or use free HTTP APIs (RugCheck / DexScreener) with caching and
graceful fallback so they never spend Helius RPC quota and never block trading if an API is down.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any

from . import api

RUGCHECK_URL = "https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary"
SAFETY_TTL = 30 * 60   # 30 minutes cache per mint

_lock = threading.Lock()
_cache: dict[str, dict] = {}


def parse_rugcheck(raw: dict | None) -> dict:
    """Normalise a RugCheck summary response into concise LP-relevant safety flags."""
    if not isinstance(raw, dict):
        return {"ok": False, "error": "empty response"}
    risks = raw.get("risks") or []
    score = raw.get("score")
    score_norm = raw.get("score_normalised")
    rugged = bool(raw.get("rugged"))
    mint_auth = bool(raw.get("mintAuthority")) or any("mint authority" in str(r.get("name", "")).lower() for r in risks)
    freeze_auth = bool(raw.get("freezeAuthority")) or any("freeze authority" in str(r.get("name", "")).lower() for r in risks)

    # Token-2022 transfer fee / tax (breaks DLMM math & bid-ask flips)
    tf = raw.get("transferFee") or {}
    transfer_fee_pct = None
    if isinstance(tf, dict) and tf.get("pct") is not None:
        try:
            transfer_fee_pct = float(tf["pct"])
        except (TypeError, ValueError):
            pass
    has_transfer_tax = (transfer_fee_pct is not None and transfer_fee_pct > 0) or any(
        "transfer fee" in str(r.get("name", "")).lower() or "transfer hook" in str(r.get("name", "")).lower()
        for r in risks
    )

    # Top holders concentration (exclude known LP / insider already summarised when available)
    top_holders = raw.get("topHolders") or []
    top10_pct = None
    if top_holders:
        vals = [float(h.get("pct") or 0) for h in top_holders[:10] if not h.get("insider") is None or h.get("pct") is not None]
        if vals:
            top10_pct = round(sum(vals), 1)
    if top10_pct is None:
        for r in risks:
            name = str(r.get("name", "")).lower()
            if "top 10" in name or "single holder" in name:
                val = str(r.get("value", "")).replace("%", "").strip()
                try:
                    top10_pct = round(float(val), 1)
                    break
                except ValueError:
                    pass

    danger_risks = []
    warn_risks = []
    for r in risks:
        lvl = str(r.get("level", "")).lower()
        txt = str(r.get("name") or r.get("description") or "").strip()
        val = str(r.get("value") or "").strip()
        label = f"{txt} ({val})" if val and val not in txt else txt
        if not label:
            continue
        if lvl in ("danger", "critical", "high"):
            danger_risks.append(label)
        elif lvl in ("warn", "warning", "medium"):
            warn_risks.append(label)

    # Overall LP safety verdict
    if rugged or has_transfer_tax or freeze_auth or (score_norm is not None and score_norm >= 70) or len(danger_risks) >= 2:
        level = "DANGER"
    elif mint_auth or (top10_pct is not None and top10_pct >= 35) or danger_risks or (score_norm is not None and score_norm >= 35):
        level = "WARN"
    else:
        level = "OK"

    return {
        "ok": True,
        "level": level,
        "score": score,
        "scoreNorm": score_norm,
        "rugged": rugged,
        "mintAuth": mint_auth,
        "freezeAuth": freeze_auth,
        "transferTax": has_transfer_tax,
        "transferFeePct": transfer_fee_pct,
        "top10Pct": top10_pct,
        "dangers": danger_risks[:6],
        "warns": warn_risks[:6],
        "lpLockedPct": raw.get("totalLPProviders"),
    }


def token_safety(mint: str, force: bool = False) -> dict:
    """Fetch & cache RugCheck safety summary for a Solana token mint (0 RPC)."""
    if not mint:
        return {"ok": False, "error": "empty mint"}
    now = time.time()
    with _lock:
        hit = _cache.get(mint)
        if hit and not force and now - hit["t"] < SAFETY_TTL:
            return {**hit["data"], "cached": True}
    req = urllib.request.Request(
        RUGCHECK_URL.format(mint=mint),
        headers={"User-Agent": "dlmm-terminal/1", "Accept": "application/json"},
    )
    try:
        with api.urlopen(req, timeout=10) as r:
            raw = json.load(r)
        res = parse_rugcheck(raw)
        res["t"] = now
    except Exception as exc:
        res = {"ok": False, "error": str(exc)[:200], "t": now}
    with _lock:
        _cache[mint] = {"t": now, "data": res}
    return res


def dlmm_volume_share(pool_vol_24h: float | None, token_vol_24h: float | None) -> float | None:
    """Share (%) of a token's total 24h volume routed through this specific DLMM pool."""
    if not pool_vol_24h or not token_vol_24h or token_vol_24h <= 0:
        return None
    return round(min(100.0, pool_vol_24h / token_vol_24h * 100.0), 1)


def fee_momentum(fees_1h: float | None, fees_24h: float | None, age_h: float | None = None) -> float | None:
    """Ratio of last-1h fee run-rate vs 24h average hourly fee (>1.5x accelerating, <0.4x decaying)."""
    if fees_1h is None or not fees_24h or fees_24h <= 0:
        return None
    hours = min(24.0, max(1.0, age_h)) if age_h and age_h > 0 else 24.0
    avg_1h = fees_24h / hours
    if avg_1h <= 0:
        return None
    return round(fees_1h / avg_1h, 2)


def il_breakeven(size_sol: float, bottom_pct: float, fee_1h_pct_tvl: float | None,
                 slices: int = 5) -> dict:
    """Estimate drawdown loss & hours of current 1h fee pace needed to break even on a 1:2:...:n
    SOL-only Spot ladder from 0% down to -bottom_pct%.

    Model: slice i has weight w_i = i / sum(1..n), covers [near_i, far_i] linearly in % drop.
    If price falls to -D%, slices entirely above -D% converted at their midpoint price, slices
    straddling -D% converted proportionally. Loss in SOL is computed vs holding SOL.
    """
    n = max(1, int(slices or 5))
    b = abs(float(bottom_pct or 70.0))
    w_sum = n * (n + 1) / 2.0

    def loss_at_drop(drop_pct: float) -> float:
        """Expected unrealized SOL loss % of ladder capital when price drops by drop_pct%."""
        if drop_pct <= 0:
            return 0.0
        p_now = max(0.01, 1.0 - drop_pct / 100.0)
        total_val = 0.0
        for i in range(1, n + 1):
            w = i / w_sum
            near = b * (i - 1) / n
            far = b * i / n
            if drop_pct <= near:
                # Still 100% SOL
                total_val += w
            elif drop_pct >= far:
                # 100% converted to token at geometric-like midpoint of slice
                p_avg = max(0.01, 1.0 - (near + far) / 200.0)
                total_val += w * (p_now / p_avg)
            else:
                # Partially filled slice
                frac = (drop_pct - near) / max(1e-9, (far - near))
                p_avg = max(0.01, 1.0 - (near + drop_pct) / 200.0)
                total_val += w * ((1.0 - frac) + frac * (p_now / p_avg))
        return max(0.0, (1.0 - total_val) * 100.0)

    scenarios = []
    for d in (30, 50, int(round(b))):
        if d > 95:
            continue
        loss_pct = round(loss_at_drop(d), 2)
        loss_sol = round(size_sol * loss_pct / 100.0, 3)
        hrs = round(loss_pct / fee_1h_pct_tvl, 1) if fee_1h_pct_tvl and fee_1h_pct_tvl > 0 else None
        scenarios.append({"dropPct": -d, "lossPct": -loss_pct, "lossSol": -loss_sol, "recoverHours": hrs})
    return {"fee1hPct": round(fee_1h_pct_tvl, 3) if fee_1h_pct_tvl is not None else None, "scenarios": scenarios}


def market_regime(rows: list[dict], sol_chg_1h: float | None = None, sol_chg_24h: float | None = None) -> dict:
    """Assess short-term market breadth across scanned SOL DLMM pools + SOL move."""
    chgs = [r["priceChg1h"] for r in rows if r.get("priceChg1h") is not None]
    if not chgs:
        return {"regime": "unknown", "redPct": None, "median1h": None, "solChg1h": sol_chg_1h, "solChg24h": sol_chg_24h}
    red = sum(1 for x in chgs if x < 0)
    red_pct = round(red / len(chgs) * 100.0, 1)
    s = sorted(chgs)
    med = round(s[len(s) // 2], 2)
    if (sol_chg_1h is not None and sol_chg_1h <= -3.0) or (red_pct >= 75 and med <= -5.0):
        regime = "risk-off"
    elif (sol_chg_1h is not None and sol_chg_1h <= -1.5) or red_pct >= 65:
        regime = "caution"
    else:
        regime = "normal"
    return {
        "regime": regime,
        "redPct": red_pct,
        "median1h": med,
        "sample": len(chgs),
        "solChg1h": sol_chg_1h,
        "solChg24h": sol_chg_24h,
    }
