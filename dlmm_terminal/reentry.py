"""Auto re-entry per ladder: when the price has run up out of a SOL-only ladder (every slice is SOL again) and
sits at least `abovePct` % over the ladder's top, close it and open the same ladder again at the current price.

Armed per pool in Portfolio (off / on), checked by the web server on the auto-exit clock from Meteora's data API
(no RPC). Like the flip it waits for the move to hold (`confirmChecks` checks in a row), and by default it also
waits for the pool to pass the entry check (the pump gate: re-opening right after a +5% hour was the worst entry
in the owner's Nov 2026 review). It stays armed after a re-entry, so it can follow the price up again, at most
`maxPer24h` times per pool and never sooner than `cooldownMin` after the last one.
"""
from __future__ import annotations

from dataclasses import dataclass

DEFAULTS = {"abovePct": 5.0, "confirmChecks": 2, "respectEntryCheck": True, "cooldownMin": 30, "maxPer24h": 6}


@dataclass
class Decision:
    kind: str              # "wait" | "fire"
    msg: str
    checks: int = 0


def plan(slices: list[dict]) -> dict:
    """The ladder to open again: as many slices as it has, from the price down to the same depth.
    slices: [{"rangeMin", "rangeMax"}] of the ladder's positions."""
    top = max(s["rangeMax"] for s in slices)
    low = min(s["rangeMin"] for s in slices)
    bottom = (1 - low / top) * 100 if top else 70.0
    return {"slices": len(slices), "bottom": round(min(max(bottom, 5.0), 95.0), 1)}


def evaluate(now: float, slices: list[dict], price: float, st: dict, cfg: dict, fired_24h: int,
             entry_failed: list[str] | None) -> Decision:
    """slices: [{"rangeMin", "rangeMax", "solOnly"}]; st: this pool's saved state (checks, lastAt).
    entry_failed: the pool's failed gates right now (None = not checked)."""
    c = {**DEFAULTS, **(cfg or {})}
    if not slices:
        return Decision("wait", "nggak ada posisi")
    if not all(s.get("solOnly") for s in slices):
        return Decision("wait", "ladder ini pegang token (bukan SOL-only): re-entry otomatis cuma buat ladder SOL")
    top = max(s["rangeMax"] for s in slices)
    trigger = top * (1 + c["abovePct"] / 100)
    over = (price / top - 1) * 100 if top else 0.0
    if price < trigger:
        return Decision("wait", f"harga {over:+.1f}% vs atas range · nembak di +{c['abovePct']:g}%", 0)
    checks = int(st.get("checks") or 0) + 1
    if checks < c["confirmChecks"]:
        return Decision("wait", f"harga +{over:.1f}% di atas range, konfirmasi {checks}/{c['confirmChecks']}", checks)
    last = float(st.get("lastAt") or 0)
    if last and now - last < c["cooldownMin"] * 60:
        return Decision("wait", f"cooldown: re-entry terakhir {int((now - last) / 60)} menit lalu (min {c['cooldownMin']:g})", checks)
    if fired_24h >= c["maxPer24h"]:
        return Decision("wait", f"udah {fired_24h}x re-entry 24 jam terakhir (maks {c['maxPer24h']})", checks)
    if c["respectEntryCheck"] and entry_failed:
        return Decision("wait", "nunggu entry check lolos: " + "; ".join(entry_failed), checks)
    return Decision("fire", f"harga +{over:.1f}% di atas range → re-entry", checks)
