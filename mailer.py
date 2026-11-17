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
import os
import re
import smtplib
import threading
import time
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

import config
import forksafe
import storage

INVITE_HEADER = "X-Screener-Invite"
_send_lock = threading.Lock()
_state = {"running": False, "kind": "invites", "total": 0, "done": 0, "sent": 0, "skipped": 0, "failed": 0, "error": None}


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _send_lock
    _send_lock = threading.Lock()
    _state["running"] = False


_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class MailError(Exception):
    pass


def status() -> dict:
    return dict(_state)


def outbox_mode() -> bool:
    """True where SMTP is blocked (Render's free plan): mails are queued and
    fetch_to_site.py sends them from a computer. MAIL_VIA=smtp|outbox overrides
    (set MAIL_VIA=smtp after moving to a paid Render instance)."""
    via = os.getenv("MAIL_VIA", "").strip().lower()
    if via in ("smtp", "outbox"):
        return via == "outbox"
    return bool(os.getenv("RENDER"))


OUTBOX_HINT = "They go out from Gmail the next time the helper runs on the Mac (python fetch_to_site.py)."


# ---------------------------------------------------------------- sender (Settings page)

def sender() -> dict:
    """Who the invites come from. Set on the Settings page; until then the
    env account (EMAIL_ADDRESS / EMAIL_APP_PASSWORD / EMAIL_FROM_NAME)."""
    address = (storage.get_setting("sender_email") or "").strip()
    custom = bool(address)
    return {
        "address": address if custom else config.EMAIL_ADDRESS,
        "password": (storage.get_setting("sender_app_password") or "") if custom else config.EMAIL_APP_PASSWORD,
        "name": (storage.get_setting("sender_name") or "").strip() or config.EMAIL_FROM_NAME,
        "reply_to": (storage.get_setting("reply_to") or "").strip(),
        "custom": custom,
    }


def sender_label() -> str:
    s = sender()
    return formataddr((s["name"], s["address"]))


def check_login(address: str, password: str) -> None:
    """Logs in to Gmail SMTP once; raises MailError with a clear reason."""
    try:
        s = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        try:
            s.login(address, password)
        finally:
            try:
                s.quit()
            except Exception:
                pass
    except smtplib.SMTPAuthenticationError:
        raise MailError(f"Gmail refused the login for {address}. Use a 16-letter App Password for that account "
                        "(Google Account → Security → 2-Step Verification → App passwords), not the normal password.")
    except (smtplib.SMTPException, OSError) as e:
        raise MailError(f"Could not reach Gmail to check {address}: {e}")


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


def build(to: str, subject: str, body: str, role_folder_id: str | None) -> EmailMessage:
    s = sender()
    msg = EmailMessage()
    msg["From"] = formataddr((s["name"], s["address"]))
    msg["To"] = to
    if s["reply_to"]:
        msg["Reply-To"] = s["reply_to"]
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=s["address"].split("@")[-1])
    if role_folder_id:   # only Google Form invites carry it (the Sent-folder dedupe looks for it)
        msg[INVITE_HEADER] = role_folder_id
    msg.set_content(body)
    return msg


# ---------------------------------------------------------------- connections

def _smtp() -> smtplib.SMTP_SSL:
    snd = sender()
    if not snd["password"]:
        raise MailError(f"No app password saved for {snd['address']}, so mail can't be sent. Add it on the Settings page.")
    try:
        s = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
        s.login(snd["address"], snd["password"])
        return s
    except smtplib.SMTPAuthenticationError as e:
        raise MailError(f"Gmail refused the login for {snd['address']}: {e}")
    except (smtplib.SMTPException, OSError) as e:
        if os.getenv("RENDER") and isinstance(e, OSError):
            raise MailError("Email can't be sent from the website: Render's free plan blocks outgoing email "
                            f"(SMTP) since Sept 2025. ({e})")
        raise MailError(f"Could not log in to Gmail to send as {snd['address']}: {e}")


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
        snd = sender()   # the Sent folder of the account the invites go out from
        try:
            self.imap = imaplib.IMAP4_SSL(config.EMAIL_IMAP_HOST, timeout=30)
            self.imap.login(snd["address"], snd["password"])
            typ, _ = self.imap.select(f'"{_sent_folder(self.imap)}"', readonly=True)
            if typ != "OK":
                raise MailError("Could not open Gmail's Sent folder.")
        except (imaplib.IMAP4.error, OSError) as e:
            raise MailError(f"Could not read the Sent folder of {snd['address']} (checked so nobody is "
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
        raise MailError("Pick a Google Form for this position first (Positions page), or add its link on the Forms page.")
    subject, body = template_for(jd)
    to = sender()["address"]
    msg = build(to, "[TEST] " + render(subject, name="Sample Applicant", position=role_name,
                                       form_link=form_url),
                render(body, name="Sample Applicant", position=role_name, form_link=form_url), "test")
    if outbox_mode():
        storage.queue_mail(kind="email", to_email=to, to_name="", subject=msg["Subject"], body=msg.get_content())
        return to
    s = _smtp()
    try:
        s.send_message(msg)
    finally:
        s.quit()
    return to


def send_invites(ids: list[int]) -> dict:
    """Claims the rows and sends them in the background. Poll status()."""
    with _send_lock:
        if _state["running"]:
            raise MailError("Invites are already being sent - wait for that batch to finish.")
        rows = storage.claim_invites(ids)
        if not rows:
            raise MailError("Nothing to send: the selected applicants are already sent, dismissed or have no email.")
        if outbox_mode():
            return _queue_invites(rows)
        _state.update(running=True, kind="invites", total=len(rows), done=0, sent=0, skipped=0, failed=0, error=None)
    threading.Thread(target=_run, args=(rows,), daemon=True, name="invite-sender").start()
    return status()


def _queue_invites(rows: list[dict]) -> dict:
    jds = storage.list_jds()
    queued = failed = 0
    for r in rows:
        jd = jds.get(r["role_folder_id"])
        form_url = ((jd or {}).get("form_url") or "").strip()
        if not form_url or not valid_email(r["email"]):
            err = (f"'{r['role_name']}' has no Google Form - pick one on the Positions page." if not form_url
                   else f"'{r['email']}' is not a valid email address.")
            storage.update_invite(r["id"], status="failed", error=err)
            failed += 1
            continue
        subject, body = template_for(jd)
        values = {"name": r["candidate"], "position": r["role_name"], "form_link": form_url}
        storage.queue_mail(kind="invite", invite_id=r["id"], to_email=r["email"], to_name=r["candidate"],
                           subject=render(subject, **values), body=render(body, **values),
                           invite_header=r["role_folder_id"])
        storage.update_invite(r["id"], status="queued", error=None)
        queued += 1
    storage.log("info", f"Google Form queued for {queued} applicant(s)" + (f", {failed} failed" if failed else "")
                        + f". {OUTBOX_HINT}")
    return {**status(), "queued": queued, "failed": failed, "outbox": True}


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
            raise MailError(f"'{r['role_name']}' has no Google Form - pick one on the Positions page.")
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


# ---------------------------------------------------------------- bulk email (any message, chosen applicants)

def send_bulk(recipients: list[dict], subject: str, body: str) -> dict:
    """Sends one message, personalised per applicant, in the background.
    recipients: [{"email", "name", "position", "form_link"}]. Poll status()."""
    subject, body = (subject or "").strip(), (body or "").strip()
    if not subject or not body:
        raise MailError("Write a subject and a message.")
    good = [r for r in recipients if valid_email(r.get("email"))]
    if not good:
        raise MailError("None of the selected applicants has a valid email address.")
    if outbox_mode():
        for r in good:
            values = {"name": r.get("name") or "", "position": r.get("position") or "", "form_link": r.get("form_link") or ""}
            storage.queue_mail(kind="email", to_email=r["email"], to_name=r.get("name") or "",
                               subject=render(subject, **values), body=render(body, **values))
        return {**status(), "total": len(good), "queued": len(good), "outbox": True,
                "without_email": len(recipients) - len(good)}
    with _send_lock:
        if _state["running"]:
            raise MailError("Emails are already being sent - wait for that batch to finish.")
        _state.update(running=True, kind="email", total=len(good), done=0, sent=0, skipped=0, failed=0, error=None)
    threading.Thread(target=_run_bulk, args=(good, subject, body), daemon=True, name="bulk-sender").start()
    return {**status(), "without_email": len(recipients) - len(good)}


def _run_bulk(rows: list[dict], subject: str, body: str) -> None:
    smtp = None
    try:
        try:
            smtp = _smtp()
        except MailError as e:
            _state.update(error=str(e), failed=len(rows))
            storage.log("error", f"Email '{subject}' not sent: {e}")
            return
        for r in rows:
            values = {"name": r.get("name") or "", "position": r.get("position") or "", "form_link": r.get("form_link") or ""}
            try:
                smtp.send_message(build(r["email"], render(subject, **values), render(body, **values), None))
                _state["sent"] += 1
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPException, OSError) as e:
                # Gmail drops long connections: log in again once and retry this one.
                try:
                    try:
                        smtp.quit()
                    except Exception:
                        pass
                    smtp = _smtp()
                    smtp.send_message(build(r["email"], render(subject, **values), render(body, **values), None))
                    _state["sent"] += 1
                except (MailError, smtplib.SMTPException, OSError) as e2:
                    _state["failed"] += 1
                    storage.log("warn", f"Email '{subject}' to {r.get('name')} <{r['email']}> failed: {e2 or e}")
            _state["done"] += 1
            time.sleep(1)  # stay well clear of Gmail's sending rate limit
    finally:
        if smtp:
            try:
                smtp.quit()
            except Exception:
                pass
        storage.log("info", f"Email '{subject}': {_state['sent']} sent, {_state['failed']} failed.")
        _state["running"] = False
