"""
Handles Zoho OAuth access tokens.

Zoho access tokens expire every ~1 hour. We use the long-lived refresh_token
(generated once via generate_refresh_token.py) to mint a fresh access token
whenever needed, and cache it in memory until it's close to expiring.test
"""
import threading
import time
import requests

import forksafe
from http_client import SESSION
import config

_cached_token = {"value": None, "expires_at": 0, "scope": ""}
# Screening runs 3 resumes in parallel and the web server has 8 threads. Without
# this, a cold start has every one of them minting its own token at the same
# moment - wasted round trips, and Zoho rate-limits refresh calls.
_refresh_lock = threading.Lock()

# A failed refresh is remembered for this long and re-raised at once. Without
# it, every caller queued on _refresh_lock retried Zoho one after another: a
# single page load (dozens of folder listings + the warm-up) then waited
# minutes behind the queue, and the burst of retries tripped Zoho's
# refresh-token rate limit, which kept the failure going indefinitely.
_FAILURE_COOLDOWN = 60
_last_failure = {"error": None, "at": 0.0}
# Longest a caller waits for another thread's refresh. A refresh is bounded
# (~35 s worst case), so hitting this means the lock is stuck, not busy.
_LOCK_WAIT = 45


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _refresh_lock
    _refresh_lock = threading.Lock()


class ZohoAuthError(Exception):
    pass


def _fresh(now: float) -> bool:
    return bool(_cached_token["value"]) and now < _cached_token["expires_at"] - 60


def _recent_failure(now: float) -> str | None:
    if _last_failure["error"] and now - _last_failure["at"] < _FAILURE_COOLDOWN:
        return _last_failure["error"]
    return None


def get_access_token() -> str:
    """Return a valid Zoho access token, refreshing it if needed."""
    now = time.time()
    if _fresh(now):
        return _cached_token["value"]
    if (err := _recent_failure(now)):
        raise ZohoAuthError(err)

    lock = _refresh_lock
    if not lock.acquire(timeout=_LOCK_WAIT):
        raise ZohoAuthError(f"Timed out after {_LOCK_WAIT}s waiting for the Zoho token refresh. "
                            "Try again; if it keeps happening, restart the service.")
    try:
        # Another thread may have refreshed (or failed) while we waited for the lock.
        now = time.time()
        if _fresh(now):
            return _cached_token["value"]
        if (err := _recent_failure(now)):
            raise ZohoAuthError(err)
        try:
            token = _refresh(now)
        except ZohoAuthError as e:
            _last_failure.update(error=str(e), at=time.time())
            raise
        _last_failure.update(error=None, at=0.0)
        return token
    finally:
        lock.release()


def _refresh(now: float) -> str:
    """Mints a new access token. Only ever called holding _refresh_lock."""
    if not (config.ZOHO_CLIENT_ID and config.ZOHO_CLIENT_SECRET and config.ZOHO_REFRESH_TOKEN):
        raise ZohoAuthError(
            "Zoho credentials missing. Check ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / "
            "ZOHO_REFRESH_TOKEN in your .env file (see README for how to generate them)."
        )

    try:
        resp = SESSION.post(
            config.TOKEN_URL,
            params={
                "refresh_token": config.ZOHO_REFRESH_TOKEN,
                "client_id": config.ZOHO_CLIENT_ID,
                "client_secret": config.ZOHO_CLIENT_SECRET,
                "grant_type": "refresh_token",
            },
            timeout=(10, 20),   # connect, read: fail fast instead of tying up a web thread
        )
    except requests.exceptions.RequestException as e:
        raise ZohoAuthError(f"Could not reach Zoho accounts server ({config.TOKEN_URL}): {e}")

    try:
        data = resp.json()
    except ValueError:
        raise ZohoAuthError(
            f"Zoho accounts server returned a non-JSON response (HTTP {resp.status_code}). "
            "Check ZOHO_DOMAIN in your .env matches your account's region."
        )

    if "access_token" not in data:
        raise ZohoAuthError(f"Failed to refresh Zoho access token: {data}")

    _cached_token["value"] = data["access_token"]
    _cached_token["expires_at"] = now + int(data.get("expires_in", 3600))
    _cached_token["scope"] = data.get("scope", "")
    return _cached_token["value"]


def auth_header() -> dict:
    return {"Authorization": f"Zoho-oauthtoken {get_access_token()}"}


def granted_scopes() -> set[str]:
    """Scopes on the current refresh token, as reported by Zoho on refresh."""
    get_access_token()
    return {x.strip() for x in _cached_token["scope"].replace(",", " ").split() if x.strip()}
