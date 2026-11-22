"""Bridge to the Node executor (Meteora SDK) and a raw-transaction relay.

The executor builds, simulates and sends with the key in .env (DLMM_PRIVATE_KEY or
DLMM_KEYPAIR). The key is read by the Node process only; Python and the browser only
ever see the wallet's address.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
import urllib.request
from pathlib import Path

EXECUTOR = Path(__file__).resolve().parent / "executor"
PUBLIC_RPC = "https://api.mainnet-beta.solana.com"


def rpc_url() -> str:
    return os.environ.get("SOLANA_RPC_URL") or PUBLIC_RPC


def ready() -> str | None:
    """None when the executor can run, else what is missing."""
    if not shutil.which("node"):
        return "Node.js belum ada (brew install node)"
    if not (EXECUTOR / "node_modules" / "@meteora-ag" / "dlmm").exists():
        import shlex
        return f"jalanin sekali: cd {shlex.quote(str(EXECUTOR))} && npm install"
    return None


USAGE_LOG = Path(__file__).resolve().parent / "data" / "rpc_usage.jsonl"


def _meter_executor(bot: str, by_host: dict, urls: list[str]) -> None:
    """Hand the executor's request counts ({label: n}) to the RPC Monitor (../rpc_monitor/meter.py).
    A label is "helius" / "alchemy" / "public" or a hostname; it is matched back to the link it came from."""
    try:
        import importlib.util
        import sys
        from urllib.parse import urlsplit
        mod = sys.modules.get("rpc_meter")
        if mod is None:
            path = Path(__file__).resolve().parents[1] / "rpc_monitor" / "meter.py"
            spec = importlib.util.spec_from_file_location("rpc_meter", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            sys.modules["rpc_meter"] = mod
        for label, n in (by_host or {}).items():
            url = next((u for u in urls if u and (label in (urlsplit(u).hostname or "") or
                        (label == "public" and u == urls[-1]))), None)
            if url:
                mod.hit(bot, url, "ok", int(n))
    except Exception:
        pass


def log_rpc(script: str, args: list[str], result: dict) -> None:
    """Every executor run reports its RPC requests ({"rpc": {calls, byHost, byMethod}}): keep them,
    so `python -m dlmm_terminal rpc` can show what the Helius free tier is spent on."""
    st = (result or {}).get("rpc")
    if not st:
        return
    _meter_executor("dlmm_terminal", st.get("byHost"), [os.environ.get("SOLANA_RPC_URL") or "", PUBLIC_RPC])
    mode = next((a[2:] for a in args if a in ("--plan", "--dry-run", "--build")), "send")
    row = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "script": script, "mode": mode,
           "ok": result.get("ok"), **st}
    try:
        USAGE_LOG.parent.mkdir(exist_ok=True)
        with open(USAGE_LOG, "a") as f:
            f.write(json.dumps(row) + "\n")
    except OSError:
        pass


def last_json(stdout: str) -> dict | None:
    line = next((l for l in reversed(stdout.strip().splitlines()) if l.startswith("{")), None)
    try:
        return json.loads(line) if line else None
    except json.JSONDecodeError:
        return None


# ---------- live activity: jobs whose steps the executor reports while it runs ----------
# The executor writes "@@{json}" lines on stderr (executor/progress.mjs). run() reads them as they come and adds them
# to the job of the calling thread (job_context), which the web shows in its 📡 activity panel.
JOBS: dict = {}
_jobs_lock = threading.Lock()
_tls = threading.local()


def job_start(title: str, kind: str = "manual") -> dict:
    job = {"id": uuid.uuid4().hex[:10], "title": title, "kind": kind, "t0": time.time(), "steps": [], "done": False,
           "ok": None, "result": None}
    with _jobs_lock:
        JOBS[job["id"]] = job
        for jid in sorted(JOBS, key=lambda k: JOBS[k]["t0"])[:-40]:      # keep the last 40
            JOBS.pop(jid, None)
    return job


def job_step(msg: str, ok: bool | None = None, job: dict | None = None) -> None:
    job = job or getattr(_tls, "job", None)
    if job is None:
        return
    with _jobs_lock:
        job["steps"].append({"t": time.time(), "msg": str(msg)[:300], "ok": ok})
        del job["steps"][:-120]


def job_finish(job: dict, res: dict) -> None:
    with _jobs_lock:
        job["done"], job["ok"], job["result"], job["t1"] = True, bool(res.get("ok")), res, time.time()


@contextmanager
def job_context(job: dict):
    prev = getattr(_tls, "job", None)
    _tls.job = job
    try:
        yield job
    finally:
        _tls.job = prev


def jobs_view(limit: int = 12) -> list[dict]:
    with _jobs_lock:
        rows = sorted(JOBS.values(), key=lambda j: -j["t0"])[:limit]
        return [{k: (v if k != "result" else None) for k, v in j.items()} | {"error": (j.get("result") or {}).get("error")} for j in rows]


def run(script: str, args: list[str], timeout: int = 240) -> dict:
    missing = ready()
    if missing:
        return {"ok": False, "error": missing}
    env = {**os.environ, "SOLANA_RPC_URL": rpc_url()}
    job = getattr(_tls, "job", None)
    proc = subprocess.Popen(["node", str(EXECUTOR / script), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env, bufsize=1)
    err: list[str] = []

    def read_err():
        for line in proc.stderr:
            if line.startswith("@@"):
                try:
                    p = json.loads(line[2:])
                    job_step(p.get("msg", ""), p.get("ok"), job)
                    continue
                except ValueError:
                    pass
            err.append(line)

    reader = threading.Thread(target=read_err, daemon=True)
    reader.start()
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        out = proc.stdout.read()
        proc.wait()
    finally:
        timer.cancel()
    reader.join(timeout=5)
    stderr = "".join(err)
    if proc.returncode is not None and proc.returncode < 0 and not timer.is_alive() and not out.strip().endswith("}"):
        job_step(f"✗ {script} dihentikan setelah {timeout} detik", False, job)
        return {"ok": False, "error": f"{script} masih jalan setelah {timeout} detik dan dihentikan; cek Portfolio / Solscan "
                "sebelum coba lagi (sebagian langkah mungkin udah terkirim).", "stdout": out[-2000:]}
    res = last_json(out)
    if res is not None:
        log_rpc(script, args, res)
        return res
    return {"ok": proc.returncode == 0, "error": short_error(stderr or out), "stdout": out[-2000:]}


def short_error(text: str) -> str:
    """A crash dump ("/Users/.../index.js:18350 throw new Error( ^ Error: Position account ... not found") -> the
    one line that says what went wrong."""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    for l in reversed(lines):
        if l.startswith(("Error:", "TypeError:", "RangeError:", "SyntaxError:")) or "Error:" in l[:40]:
            return l.split("Error:", 1)[1].strip()[:300] or l[:300]
    return (lines[-1] if lines else "executor gagal tanpa pesan")[:300]


_wallet_cache: dict = {}


def key_configured() -> bool:
    return bool(os.environ.get("DLMM_PRIVATE_KEY") or os.environ.get("DLMM_KEYPAIR"))


def trade_wallet(force: bool = False) -> dict:
    """{"ok", "pubkey"} for the key in .env, worked out by the executor. The key itself never
    leaves the Node process; only its public address comes back. Worked out again when the key
    in the environment changes (the web re-reads .env), and a failure is retried after 20 s."""
    import hashlib
    import time
    fp = hashlib.sha256((os.environ.get("DLMM_PRIVATE_KEY", "") + "|" + os.environ.get("DLMM_KEYPAIR", "")).encode()).hexdigest()
    hit = _wallet_cache.get("v")
    stale = not hit or hit["fp"] != fp or (not hit["res"].get("ok") and time.time() - hit["t"] > 20)
    if force or stale:
        res = run("wallet.mjs", [], timeout=60) if key_configured() else {"ok": False, "error": "no key"}
        _wallet_cache["v"] = {"fp": fp, "t": time.time(), "res": res}
    return _wallet_cache["v"]["res"]


def ladder_args(pool: str, sol: float, slices: int, bottom: float, top: float = 0, strategy: str = "spot") -> list[str]:
    return ["--pool", pool, "--sol", str(sol), "--slices", str(int(slices)), "--bottom", str(bottom),
            "--top", str(top), "--strategy", strategy]
