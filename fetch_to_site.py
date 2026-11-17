"""
The website's helper on an office computer: fetches Indeed resumes from Gmail
and sends the website's queued emails through Gmail.

Why it is needed (Render's free plan, not a bug in the app):
  * Indeed shows the Render server a "Just a moment..." bot check, so the
    website can't download Indeed resumes. From a normal computer it can.
  * Render's free plan blocks outgoing email (SMTP ports 465/587), so the
    website can't send the Google Form or bulk emails itself. It queues them,
    and this script sends them from Gmail with the App Password in .env -
    they show up in Gmail's Sent folder as usual.

Each resume is handed to the website, which files it in WorkDrive
(ROOT / <position> / <date>) and lists it under Applicants. Its mail is then
marked as read in Gmail, so unread = not on the website yet.

Setup once (in this folder):
    pip install -r requirements.txt
    playwright install chromium
    .env must have EMAIL_APP_PASSWORD (and EMAIL_ADDRESS if not the default)

Run:
    python fetch_to_site.py                 # fetch new resumes, then send queued emails
    python fetch_to_site.py --days 30       # look further back for application mails
    python fetch_to_site.py --limit 5       # only the first 5 resumes (a quick test)
    python fetch_to_site.py --send-only     # only send the queued emails
    python fetch_to_site.py --no-send       # only fetch resumes

Safe to run again any time: resumes already on the website are skipped, and an
invite already in Gmail's Sent folder is never sent twice.
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
os.environ["MAIL_VIA"] = "smtp"                  # this computer can reach Gmail
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import asyncio  # noqa: E402
import smtplib  # noqa: E402
from email.message import EmailMessage  # noqa: E402
from email.utils import formataddr, make_msgid  # noqa: E402

import requests  # noqa: E402

import config  # noqa: E402
import email_fetcher as ef  # noqa: E402
import mailer  # noqa: E402
import storage  # noqa: E402

DEFAULT_SITE = os.getenv("SITE_URL", "https://resume-screener-h4ce.onrender.com")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default=DEFAULT_SITE, help=f"website address (default {DEFAULT_SITE})")
    ap.add_argument("--days", type=int, default=config.EMAIL_LOOKBACK_DAYS, help="how many days of mail to look at")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many resumes (0 = all)")
    ap.add_argument("--send-only", action="store_true", help="only send the website's queued emails")
    ap.add_argument("--no-send", action="store_true", help="only fetch resumes, don't send queued emails")
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

    if not args.send_only:
        fetch_resumes(http, site, args)
    if not args.no_send:
        send_outbox(http, site)
    return 0


# ---------------------------------------------------------------- resumes

def fetch_resumes(http: requests.Session, site: str, args) -> None:
    def known(ids):
        r = http.post(f"{site}/api/import/known", json={"message_ids": ids}, timeout=120)
        r.raise_for_status()
        return r.json()["known"]

    print(f"Reading Gmail ({config.EMAIL_ADDRESS}, last {args.days} days) ...")
    jobs = ef._scan(known=known)
    if args.limit:
        jobs = jobs[:args.limit]
    if not jobs:
        print("No new resumes: every application mail is already on the website.")
        return
    print(f"{len(jobs)} new resume(s) to fetch.\n")

    counts = {"saved": 0, "skipped": 0, "failed": 0}
    done_mids: list[str] = []
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
                if r.ok:
                    done_mids.append(job["mid"])
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
    marked = ef.mark_read(done_mids)   # unread in Gmail = not on the website yet
    if marked:
        print(f"Marked {marked} application mail(s) as read in Gmail.")
    mins = (time.time() - started) / 60
    print(f"\nResumes done in {mins:.0f} min: {counts['saved']} saved, {counts['skipped']} already there, "
          f"{counts['failed']} failed.")
    if counts["failed"]:
        print("Failed ones stay unread and are retried next time.")


# ---------------------------------------------------------------- queued emails

def send_outbox(http: requests.Session, site: str) -> None:
    """Sends what the website queued (Google Form invites, bulk emails, tests)."""
    r = http.post(f"{site}/api/outbox/claim", timeout=120)
    r.raise_for_status()
    data = r.json()
    mails, snd = data["mails"], data["sender"]
    if not mails:
        print("\nNo emails waiting to be sent.")
        return
    address = config.EMAIL_ADDRESS
    if snd["address"].lower() != address.lower():
        print(f"\nNote: the website's sender is {snd['address']}, but this computer has the App Password for "
              f"{address}, so the emails go out from {address}.")
    print(f"\nSending {len(mails)} queued email(s) from {address} ...")

    def report(mail, status, error=None):
        for attempt in range(3):
            try:
                http.post(f"{site}/api/outbox/{mail['id']}/result", json={"status": status, "error": error},
                          timeout=60).raise_for_status()
                return
            except requests.RequestException:
                time.sleep(3 * (attempt + 1))
        print(f"   (could not tell the website about mail #{mail['id']}; it will be offered again later)")

    def connect():
        s = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        s.login(address, config.EMAIL_APP_PASSWORD)
        return s

    try:
        smtp = connect()
        index = mailer.SentIndex() if any(m["kind"] == "invite" for m in mails) else None
    except (smtplib.SMTPException, OSError, mailer.MailError) as e:
        print(f"Could not log in to Gmail as {address}: {e}")
        print("Nothing was sent; the emails stay queued. Check EMAIL_APP_PASSWORD in .env.")
        return

    sent = skipped = failed = 0
    try:
        for i, m in enumerate(mails, 1):
            label = f"[{i}/{len(mails)}] {m['to_name'] or ''} <{m['to_email']}>"
            try:
                if m["invite_header"] and index and index.already_invited(m["to_email"], m["invite_header"]):
                    report(m, "already_sent")
                    skipped += 1
                    print(f"{label}: already got this form earlier - not sent again")
                    continue
                msg = EmailMessage()
                msg["From"] = formataddr((snd["name"], address))
                msg["To"] = m["to_email"]
                if snd.get("reply_to"):
                    msg["Reply-To"] = snd["reply_to"]
                msg["Subject"] = m["subject"]
                msg["Message-ID"] = make_msgid(domain=address.split("@")[-1])
                if m["invite_header"]:
                    msg[mailer.INVITE_HEADER] = m["invite_header"]
                msg.set_content(m["body"])
                try:
                    smtp.send_message(msg)
                except (smtplib.SMTPServerDisconnected, smtplib.SMTPSenderRefused):
                    smtp = connect()          # Gmail drops idle connections; log in again once
                    smtp.send_message(msg)
                report(m, "sent")
                sent += 1
                print(f"{label}: sent - {m['subject']}")
            except (smtplib.SMTPException, OSError) as e:
                report(m, "failed", str(e))
                failed += 1
                print(f"{label}: FAILED - {e}")
            time.sleep(1)   # stay well clear of Gmail's sending limits
    finally:
        try:
            smtp.quit()
        except Exception:
            pass
        if index:
            index.close()
    print(f"\nEmails: {sent} sent, {skipped} already sent before, {failed} failed.")


if __name__ == "__main__":
    sys.exit(main())
