"""
One shared, pooled HTTP session for every outbound API call.

Why this exists: the app used module-level `requests.get/post`, which opens a
brand-new TCP + TLS connection for every single call. Screening 200 resumes
means hundreds of calls to the same three hosts (accounts.zoho / zohoapis /
recruit.zoho), so the handshakes alone cost more than the real work.

A Session with a connection pool keeps those sockets alive and reuses them, so
only the first call to each host pays the handshake.

Retries are deliberately limited to GET/HEAD/OPTIONS. A retried POST or PATCH
could create a duplicate candidate in Recruit or re-delete a file in WorkDrive,
so those always fail fast and are handled by the caller instead.
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Enough sockets for the 3 pipeline workers, 8 gunicorn threads and the
# WorkDrive listing cache (up to 16 refreshers + 16 folder counters) to share
# without ever queueing on the pool.
_POOL_SIZE = 32

_retry = Retry(
    total=2,
    connect=2,
    # One retry after a read timeout, not two: each wait is the full read
    # timeout (30 s), so two retries turned one slow call into a 90 s hang.
    read=1,
    backoff_factor=0.6,                       # 0s, 0.6s, 1.2s
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=frozenset({"GET", "HEAD", "OPTIONS"}),
    raise_on_status=False,
    # Zoho answers a burst with 429 + Retry-After (often a minute or more).
    # Honouring it put every request thread to sleep with no limit, so pages
    # hung instead of failing. Retry on our short backoff only; if Zoho is
    # still throttling, the caller gets the 429 and shows it.
    respect_retry_after_header=False,
)


def _build() -> requests.Session:
    s = requests.Session()
    adapter = HTTPAdapter(
        pool_connections=_POOL_SIZE,
        pool_maxsize=_POOL_SIZE,
        max_retries=_retry,
        pool_block=False,
    )
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


# Shared by zoho_auth, zoho_workdrive, zoho_recruit and google_sheets.
# requests.Session is safe to send from several threads at once; nothing here
# mutates session-level headers or cookies after start-up.
SESSION = _build()
