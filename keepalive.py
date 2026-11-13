"""
Keeps the Render free instance awake so nobody ever waits on a cold start.

Render's free plan spins a web service down after 15 minutes with no inbound
request. The next visitor then waits ~30-60 seconds staring at a loading
screen while the container boots. This pings our own /healthz every few
minutes, which counts as inbound traffic, so the idle timer never runs out.

Honest limitation: this thread lives *inside* the instance, so it can only
keep a running service awake - it can never wake a service that has already
gone to sleep (a sleeping instance runs no threads). It covers the normal
case; the GitHub Actions workflow in .github/workflows/keepalive.yml is the
external backup that handles the rest, and the two are independent on purpose.

Off by default locally: it only starts when KEEPALIVE_URL or Render's own
RENDER_EXTERNAL_URL is present in the environment.
"""
import os
import threading
import time

from http_client import SESSION

# Comfortably inside Render's 15-minute idle window, with room for one missed
# ping before the service is at risk.
INTERVAL_SECONDS = int(os.getenv("KEEPALIVE_MINUTES", "10")) * 60

_started = False
_state = {"last_ping": None, "last_status": None, "ok": 0, "failed": 0, "url": None}


def target_url() -> str | None:
    """The public health URL to ping, or None when keep-alive is off.

    RENDER_EXTERNAL_URL is injected by Render automatically (e.g.
    https://resume-screener.onrender.com), so nothing needs configuring there.
    """
    if os.getenv("KEEPALIVE_ENABLED", "true").strip().lower() in ("0", "false", "no", "off"):
        return None
    base = (os.getenv("KEEPALIVE_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").strip()
    if not base:
        return None
    return base.rstrip("/") + "/healthz"


def status() -> dict:
    return {**_state, "interval_minutes": INTERVAL_SECONDS // 60, "running": _started}


def start() -> None:
    """Starts the pinger once per process. Safe to call when it isn't wanted."""
    global _started
    url = target_url()
    if _started or not url or INTERVAL_SECONDS <= 0:
        return
    _started = True
    _state["url"] = url
    threading.Thread(target=_loop, args=(url,), daemon=True, name="keepalive").start()
    print(f"Keep-alive: pinging {url} every {INTERVAL_SECONDS // 60} min to prevent cold starts.")


def _loop(url: str) -> None:
    time.sleep(60)  # let the first boot settle before adding traffic
    while True:
        try:
            # Short timeout: /healthz returns a static string, so anything slow
            # means the instance is busy, and a busy instance isn't idle anyway.
            resp = SESSION.get(url, timeout=15)
            _state["last_status"] = resp.status_code
            _state["ok" if resp.ok else "failed"] += 1
        except Exception as e:                      # never let this kill the thread
            _state["last_status"] = f"error: {e}"
            _state["failed"] += 1
        _state["last_ping"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        time.sleep(INTERVAL_SECONDS)
