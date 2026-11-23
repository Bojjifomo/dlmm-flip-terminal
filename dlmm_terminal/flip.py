"""Bid-ask flip: when the price runs all the way through a position, flip it to the other side of the price.

Mechanism from flip-bot/ (src/decision/engine.ts), cut down to what the DLMM terminal can see without RPC
(Meteora's data API, the same feed as the exit rules):

  bid  = SOL-only range below the price (what the ladder opens). The price falls through it -> it is all token.
         Flip: close, open that token as a token-only BidAsk range ABOVE the price, same width (sell it back higher).
  ask  = token-only range above the price. The price runs up through it -> it is all SOL again.
         Flip: close, open that SOL as a SOL-only BidAsk range BELOW the price, same width (buy lower again).

A flip only fires after the price has stayed past the range for `confirmMinutes` AND `confirmChecks` checks in a row
(a wick through the range does not count), at most `maxFlipsPer24h` times per pool. The executor checks the position
on chain again before it sends anything.

Pure: one tick + the state from the last check in, a decision out. Prices are the token priced in SOL, so a bid sits
below the price and an ask above it, whichever mint SOL is.
"""
from __future__ import annotations

from dataclasses import dataclass, field

DEFAULTS = {"confirmMinutes": 4, "confirmChecks": 2, "maxFlipsPer24h": 8, "gapBins": 1, "slippagePct": 1,
            "minSolReserve": 0.05, "wholeLadder": True}
MODES = ("off", "alert", "auto")


@dataclass
class FlipState:
    side: str | None = None          # "bid" | "ask", fixed when first seen (or set by the flip that opened it)
    crossed_since: float | None = None
    checks: int = 0
    notified: bool = False

    def to_dict(self) -> dict:
        return {"side": self.side, "crossed_since": self.crossed_since, "checks": self.checks, "notified": self.notified}

    @classmethod
    def from_dict(cls, d: dict | None) -> "FlipState":
        d = d or {}
        return cls(d.get("side"), d.get("crossed_since"), int(d.get("checks") or 0), bool(d.get("notified")))


def side_of(price: float, range_min: float, range_max: float, sol_only: bool) -> str | None:
    """Which side a position is on. Deposited SOL only = a bid, wherever the price is now (a bid first seen after the
    price fell through it is still a bid: the one to flip). Otherwise from where it sits against the price."""
    if sol_only:
        return "bid"
    if price >= range_max:
        return "bid"
    if price <= range_min:
        return "ask"
    return "bid" if sol_only else None


def is_crossed(side: str | None, price: float, range_min: float, range_max: float) -> bool:
    """bid: the price fell below the bottom (all token). ask: the price rose above the top (all SOL)."""
    if side == "bid":
        return price < range_min
    if side == "ask":
        return price > range_max
    return False


@dataclass
class Decision:
    kind: str                         # "wait" | "confirming" | "flip" | "limit"
    to: str | None = None
    msg: str = ""
    extra: dict = field(default_factory=dict)


def evaluate(now: float, price: float, range_min: float, range_max: float, sol_only: bool, state: FlipState,
             cfg: dict, flips_24h: int) -> Decision:
    c = {**DEFAULTS, **(cfg or {})}
    if state.side is None:
        state.side = side_of(price, range_min, range_max, sol_only)
    if not is_crossed(state.side, price, range_min, range_max):
        state.crossed_since, state.checks, state.notified = None, 0, False
        where = "nunggu harga turun nembus" if state.side == "bid" else "nunggu harga naik nembus" if state.side == "ask" else "in range"
        return Decision("wait", msg=f"{state.side or '?'} · {where}")
    to = "ask" if state.side == "bid" else "bid"
    if state.crossed_since is None:
        state.crossed_since = now
    state.checks += 1
    held = (now - state.crossed_since) / 60
    need_min, need_checks = float(c["confirmMinutes"]), int(c["confirmChecks"])
    if held < need_min or state.checks < need_checks:
        return Decision("confirming", to, f"{state.side} ketembus: konfirmasi {state.checks}/{need_checks} cek, "
                                          f"{held:.1f}/{need_min:g} menit → {to}")
    if flips_24h >= int(c["maxFlipsPer24h"]):
        return Decision("limit", to, f"udah {flips_24h} flip di pool ini 24 jam terakhir (max {c['maxFlipsPer24h']})")
    return Decision("flip", to, f"{state.side} ketembus {held:.0f} menit → flip ke {to}")


def ladder_gate(decisions: list[tuple[str | None, "Decision"]], price: float, bid_bottom: float | None,
                cfg: dict) -> list["Decision"]:
    """bid → ask waits for the whole ladder (wholeLadder): a crossed bid slice is only flipped once every bid slice
    of the pool is crossed and confirmed (the price is under the bottom of the last slice), and then they all flip
    together. decisions: [(side, Decision)] of one pool's positions, in any order. Returns the decisions to act on."""
    c = {**DEFAULTS, **(cfg or {})}
    if not c.get("wholeLadder"):
        return [d for _, d in decisions]
    bids = [d for side, d in decisions if side == "bid"]
    all_ready = bool(bids) and all(d.kind == "flip" and d.to == "ask" for d in bids)
    if all_ready:
        return [d for _, d in decisions]
    left = ""
    if bid_bottom and price > 0:
        left = f" (harga {(bid_bottom / price - 1) * 100:+.1f}% dari bawah ladder)"
    out = []
    for side, d in decisions:
        if side == "bid" and d.kind in ("flip", "confirming", "limit"):
            out.append(Decision("wait", None, f"bid ketembus, nunggu seluruh ladder ketembus dulu{left}"))
        else:
            out.append(d)
    return out


# ---------- shared by the web server and `monitor` ----------
RANGE_CLOSE_RULES = ("closeBelowRangeAfterMin", "priceStopBelowEntryPct")


def exits_for(ex: dict, flip_armed: bool) -> dict:
    """The exit rules for a position: with the flip armed, a bid the price ran through is flipped, not closed."""
    return {**ex, **{k: None for k in RANGE_CLOSE_RULES}} if flip_armed else ex


def load(path) -> dict:
    import json
    try:
        d = json.loads(path.read_text())
    except (OSError, ValueError):
        d = {}
    d.setdefault("pools", {})
    d.setdefault("positions", {})
    d.setdefault("history", [])
    return d


def flips_24h(d: dict, pool: str, now: float) -> int:
    return sum(1 for h in d.get("history") or [] if h.get("pool") == pool and h.get("ok") and now - (h.get("at") or 0) < 86400)
