"""
Fetch Indeed resumes from Gmail on THIS computer and send them to the website.

Why: Indeed shows the Render server a "Just a moment..." bot check, so the
website's own "Fetch new from Gmail" can't download resumes. From a normal
computer the same links work. This script does the downloading here and hands
each resume to the website, which files it in WorkDrive (ROOT / <position> /
<date>) and lists it under Applicants, exactly like its own fetch.

Setup once (in this folder):
    pip install -r requirements.txt
    playwright install chromium
    .env must have EMAIL_APP_PASSWORD (and EMAIL_ADDRESS if not the default)

Run:
    python fetch_to_site.py                 # every new application mail of the last 7 days
    python fetch_to_site.py --days 30       # look further back
    python fetch_to_site.py --limit 5       # only the first 5 (a quick test)

Safe to run again any time: mails the website already has are skipped, and
nothing is sent to applicants (sending the Google Form stays a button on the site).
"""
import argparse
import os
import sys
import tempfile
import time

# This script never touches the website's database or the MongoDB backup:
# its own scratch database only holds log lines.
os.environ["MONGODB_URI"] = ""
os.environ["DATABASE_PATH"] = os.path.join(tempfile.gettempdir(), "fetch_to_site.db")
os.environ.setdefault("UPLOAD_WORKERS", "2")     # parallel sends to the website
os.environ.setdefault("FETCH_TABS", "2")         # parallel Indeed tabs (more can trigger Indeed's rate limit)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import asyncio  # noqa: E402

import requests  # noqa: E402

import config  # noqa: E402
import email_fetcher as ef  # noqa: E402
import storage  # noqa: E402

DEFAULT_SITE = os.getenv("SITE_URL", "https://resume-screener-h4ce.onrender.com")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default=DEFAULT_SITE, help=f"website address (default {DEFAULT_SITE})")
    ap.add_argument("--days", type=int, default=config.EMAIL_LOOKBACK_DAYS, help="how many days of mail to look at")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many resumes (0 = all)")
    args = ap.parse_args()
    site = args.site.rstrip("/")
    config.EMAIL_LOOKBACK_DAYS = args.days
    storage.init_db()
    ef._reset_state()
    http = requests.Session()

    print(f"Waking up {site} ...")
    for attempt in range(6):        # a sleeping free Render instance takes ~1 minute to start
        try:
            if http.get(f"{site}/healthz", timeout=90).ok:
                break
        except requests.RequestException:
            pass
        time.sleep(10)
    else:
        print("The website did not answer. Check the address and try again.")
        return 1

    def known(ids):
        r = http.post(f"{site}/api/import/known", json={"message_ids": ids}, timeout=120)
        r.raise_for_status()
        return r.json()["known"]

    print(f"Reading Gmail ({config.EMAIL_ADDRESS}, last {args.days} days) ...")
    jobs = ef._scan(known=known)
    if args.limit:
        jobs = jobs[:args.limit]
    if not jobs:
        print("Nothing new: every application mail is already on the website.")
        return 0
    print(f"{len(jobs)} new resume(s) to fetch.\n")

    counts = {"saved": 0, "skipped": 0, "failed": 0}
    started = time.time()

    def finish(job, out):
        n = sum(counts.values()) + 1
        label = f"[{n}/{len(jobs)}] {job['name']} - {job['position']}"
        if isinstance(out, Exception):
            counts["failed"] += 1
            print(f"{label}: FAILED - {out}")
            return
        content, ext = out
        data = {"message_id": job["mid"], "position": job["position"], "candidate": job["name"],
                "applied_at": job["when"].isoformat(), "subject": job["subject"], "reply_to": job.get("reply_to") or ""}
        for attempt in range(3):
            try:
                r = http.post(f"{site}/api/import/resume", data=data,
                              files={"file": (f"{job['name']}{ext}", content)}, timeout=180)
                body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                if r.ok and body.get("skipped"):
                    counts["skipped"] += 1
                    print(f"{label}: already on the website")
                elif r.ok:
                    counts["saved"] += 1
                    print(f"{label}: saved to {body['folder']}" + (f" ({body['email']})" if body.get("email") else " (no email found)"))
                else:
                    counts["failed"] += 1
                    print(f"{label}: FAILED - {body.get('error') or r.status_code}")
                return
            except requests.RequestException as e:
                if attempt == 2:
                    counts["failed"] += 1
                    print(f"{label}: FAILED - could not reach the website: {e}")
                time.sleep(5 * (attempt + 1))

    asyncio.run(ef._pipeline(jobs, finish))
    mins = (time.time() - started) / 60
    print(f"\nDone in {mins:.0f} min: {counts['saved']} saved, {counts['skipped']} already there, "
          f"{counts['failed']} failed.")
    if counts["failed"]:
        print("Failed ones were not marked as done - run the script again to retry them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
