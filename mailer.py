"""
Sends the Google Form invite to applicants, from EMAIL_ADDRESS via Gmail.

Nothing here runs on its own: the hiring team reviews the list on the Form
invites page and clicks Send. send_invites() then works through the chosen
rows in a background thread, one SMTP and one IMAP login for the whole batch.

No double sends. Every invite carries an X-Screener-Invite header naming the
position folder. Before sending, Gmail's Sent folder is searched for mail to
the same address, and if one of those carries the same header the row is
marked already_sent instead. The Sent folder survives redeploys, so this
holds even when the database has been wiped.
"""
import imaplib
import re
import smtplib
import threading
import time
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

import config
import storage

INVITE_HEADER = "X-Screener-Invite"
_send_lock = threading.Lock()
_state = {"running": False, "total": 0, "done": 0, "sent": 0, "skipped": 0, "failed": 0, "error": None}
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class MailError(Exception):
    pass


def status() -> dict:
    return dict(_state)


def valid_email(value: str) -> bool:
    return bool(_EMAIL_RE.match((value or "").strip()))


# ---------------------------------------------------------------- template

def render(template: str, *, name: str, position: str, form_link: str) -> str:
    """Plain placeholder replacement - braces in the text are left alone, so a
    template can never crash a send the way str.format would."""
    first = (name or "").split()[0] if (name or "").split() else "there"
    for key, value in {"{name}": name or "there", "{first_name}": first,
                       "{position}": position, "{form_link}": form_link}.items():
        template = template.replace(key, value)
    return template


def template_for(jd: dict | None) -> tuple[str, str]:
    jd = jd or {}
    return ((jd.get("invite_subject") or "").strip() or config.DEFAULT_INVITE_SUBJECT,
            (jd.get("invite_body") or "").strip() or config.DEFAULT_INVITE_BODY)


def build(to: str, subject: str, body: str, role_folder_id: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((config.EMAIL_FROM_NAME, config.EMAIL_ADDRESS))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=config.EMAIL_ADDRESS.split("@")[-1])
    msg[INVITE_HEADER] = role_folder_id
    msg.set_content(body)
    return msg


# ---------------------------------------------------------------- connections

def _smtp() -> smtplib.SMTP_SSL:
    if not config.EMAIL_APP_PASSWORD:
        raise MailError(f"EMAIL_APP_PASSWORD is not set, so mail can't be sent from {config.EMAIL_ADDRESS}.")
    try:
        s = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        s.login(config.EMAIL_ADDRESS, config.EMAIL_APP_PASSWORD)
        return s
    except (smtplib.SMTPException, OSError) as e:
        raise MailError(f"Could not log in to Gmail to send as {config.EMAIL_ADDRESS}: {e}")


def _sent_folder(imap) -> str:
    """Gmail's Sent folder name depends on the account language; it is the one
    flagged \\Sent."""
    typ, rows = imap.list()
    for raw in rows or []:
        line = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        if "\\Sent" in line:
            m = re.search(r'"([^"]+)"\s*$', line) or re.search(r"(\S+)\s*$", line)
            if m:
                return m.group(1)
    return "[Gmail]/Sent Mail"


class SentIndex:
    """Read-only look-ups in the Sent folder, one IMAP login per batch."""

    def __init__(self):
        try:
            self.imap = imaplib.IMAP4_SSL(config.EMAIL_IMAP_HOST, timeout=30)
            self.imap.login(config.EMAIL_ADDRESS, config.EMAIL_APP_PASSWORD)
            typ, _ = self.imap.select(f'"{_sent_folder(self.imap)}"', readonly=True)
            if typ != "OK":
                raise MailError("Could not open Gmail's Sent folder.")
        except (imaplib.IMAP4.error, OSError) as e:
            raise MailError(f"Could not read the Sent folder of {config.EMAIL_ADDRESS} (checked so nobody is "
                            f"emailed twice): {e}")
        self.since = (datetime.now() - timedelta(days=config.INVITE_DEDUPE_DAYS)).strftime("%d-%b-%Y")

    def already_invited(self, to: str, role_folder_id: str) -> bool:
        typ, data = self.imap.search(None, "SINCE", self.since, "TO", f'"{to}"')
        ids = data[0].split() if typ == "OK" and data and data[0] else []
        if not ids:
            return False
        typ, rows = self.imap.fetch(b",".join(ids[-50:]).decode(), f"(BODY.PEEK[HEADER.FIELDS ({INVITE_HEADER})])")
        for part in rows if typ == "OK" else []:
            if isinstance(part, tuple) and role_folder_id.encode() in part[1]:
                return True
        return False

    def close(self):
        try:
            self.imap.logout()
        except Exception:
            pass


# ---------------------------------------------------------------- sending

def send_test(role_folder_id: str, role_name: str, jd: dict | None) -> str:
    """Sends the position's invite, filled in with sample values, to our own
    address so the team can see exactly what applicants will get."""
    form_url = ((jd or {}).get("form_url") or "").strip()
    if not form_url:
        raise MailError("Add the Google Form link first.")
    subject, body = template_for(jd)
    msg = build(config.EMAIL_ADDRESS, "[TEST] " + render(subject, name="Sample Applicant", position=role_name,
                                                        form_link=form_url),
                render(body, name="Sample Applicant", position=role_name, form_link=form_url), "test")
    s = _smtp()
    try:
        s.send_message(msg)
    finally:
        s.quit()
    return config.EMAIL_ADDRESS


def send_invites(ids: list[int]) -> dict:
    """Claims the rows and sends them in the background. Poll status()."""
    with _send_lock:
        if _state["running"]:
            raise MailError("Invites are already being sent - wait for that batch to finish.")
        rows = storage.claim_invites(ids)
        if not rows:
            raise MailError("Nothing to send: the selected applicants are already sent, dismissed or have no email.")
        _state.update(running=True, total=len(rows), done=0, sent=0, skipped=0, failed=0, error=None)
    threading.Thread(target=_run, args=(rows,), daemon=True, name="invite-sender").start()
    return status()


def _run(rows: list[dict]) -> None:
    jds = storage.list_jds()
    smtp = index = None
    try:
        try:
            smtp, index = _smtp(), SentIndex()
        except MailError as e:
            _state["error"] = str(e)
            for r in rows:
                storage.update_invite(r["id"], status="failed", error=str(e))
            storage.log("error", f"Form invites not sent: {e}")
            return
        for r in rows:
            _one(r, jds.get(r["role_folder_id"]), smtp, index)
            _state["done"] += 1
            time.sleep(1)  # stay well clear of Gmail's sending rate limit
    finally:
        for c, close in ((smtp, "quit"), (index, "close")):
            if c:
                try:
                    getattr(c, close)()
                except Exception:
                    pass
        storage.log("info", f"Form invites: {_state['sent']} sent, {_state['skipped']} already sent before, "
                            f"{_state['failed']} failed.")
        _state["running"] = False


def _one(r: dict, jd: dict | None, smtp, index: SentIndex) -> None:
    form_url = ((jd or {}).get("form_url") or "").strip()
    try:
        if not form_url:
            raise MailError(f"No Google Form link set for '{r['role_name']}'.")
        if not valid_email(r["email"]):
            raise MailError(f"'{r['email']}' is not a valid email address.")
        if index.already_invited(r["email"], r["role_folder_id"]):
            storage.update_invite(r["id"], status="already_sent", error=None)
            _state["skipped"] += 1
            return
        subject, body = template_for(jd)
        msg = build(r["email"], render(subject, name=r["candidate"], position=r["role_name"], form_link=form_url),
                    render(body, name=r["candidate"], position=r["role_name"], form_link=form_url),
                    r["role_folder_id"])
        smtp.send_message(msg)
        storage.update_invite(r["id"], status="sent", sent_at=storage.now(), error=None)
        storage.log("info", f"Google Form invite sent to {r['candidate']} <{r['email']}> for '{r['role_name']}'.")
        _state["sent"] += 1
    except (MailError, smtplib.SMTPException, imaplib.IMAP4.error, OSError) as e:
        storage.update_invite(r["id"], status="failed", error=str(e))
        storage.log("warn", f"Google Form invite to {r['candidate']} <{r['email']}> failed: {e}")
        _state["failed"] += 1
