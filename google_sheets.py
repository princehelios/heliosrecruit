"""
Reads a role's Google Form response sheet and finds a candidate's response.

The sheet must be shared as "Anyone with the link can view": it is downloaded
as CSV from the public export URL, so no Google login or API key is needed.

  https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>
    -> https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>

A response is matched to a resume by email first, then by phone (last 10
digits), using every email/phone found on the resume. If a candidate filled
the form more than once, the newest row wins.
"""
import csv
import io
import re
import threading
import time

import requests

from http_client import SESSION

import config
from resume_parser import normalise_phone


class SheetError(Exception):
    pass


_SHEET_URL = re.compile(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]{20,})")
_GID = re.compile(r"[#?&]gid=(\d+)")
_EMAIL_HEADER = re.compile(r"e-?mail|mail id", re.I)
_PHONE_HEADER = re.compile(r"phone|mobile|contact|whats\s?app|number|\bno\b", re.I)
_TIMESTAMP_HEADER = re.compile(r"^time ?stamp$", re.I)

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def parse_url(url: str) -> tuple[str, str]:
    """(sheet_id, gid) from a Google Sheets link. gid "" = first tab."""
    url = (url or "").strip()
    m = _SHEET_URL.search(url)
    if not m:
        raise SheetError("That isn't a Google Sheets link. Open the form's response sheet and copy its URL "
                         "(it starts with https://docs.google.com/spreadsheets/d/...).")
    gid = _GID.search(url)
    return m.group(1), gid.group(1) if gid else ""


def _download(url: str) -> list[list[str]]:
    sheet_id, gid = parse_url(url)
    export = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv" + (f"&gid={gid}" if gid else "")
    try:
        resp = SESSION.get(export, timeout=30)
    except requests.exceptions.RequestException as e:
        raise SheetError(f"Could not reach Google Sheets: {e}")
    ctype = resp.headers.get("Content-Type", "")
    # A private sheet answers with a Google sign-in page (HTML), sometimes with 200.
    if resp.status_code in (401, 403) or "text/html" in ctype:
        raise SheetError("The response sheet isn't public. In Google Sheets click Share -> General access -> "
                         "'Anyone with the link' (Viewer), then try again.")
    if resp.status_code == 404:
        raise SheetError("Google says this sheet doesn't exist. Check the link.")
    if resp.status_code != 200:
        raise SheetError(f"Google Sheets returned HTTP {resp.status_code}.")
    text = resp.content.decode("utf-8-sig", errors="replace")
    return [row for row in csv.reader(io.StringIO(text))]


def _pick_column(headers: list[str], rows: list[list[str]], header_re, looks_right) -> int | None:
    """Best column for emails/phones: header must match, and the column whose
    values most often look right wins (forms sometimes ask for a reference's
    phone too - the candidate's own is the one filled in most)."""
    best, best_hits = None, 0
    for i, h in enumerate(headers):
        if not header_re.search(h or ""):
            continue
        hits = sum(1 for r in rows if i < len(r) and looks_right(r[i]))
        if hits > best_hits or best is None:
            best, best_hits = i, hits
    return best


def load(url: str, *, fresh: bool = False) -> dict:
    """{"headers", "rows", "email_col", "phone_col", "fetched_at"} - cached
    for config.SHEET_CACHE_SECONDS so one run downloads each sheet once."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and not fresh and now - hit[0] < config.SHEET_CACHE_SECONDS:
            return hit[1]
    table = _download(url)
    if not table:
        raise SheetError("The response sheet is empty - it has no header row yet.")
    headers = [h.strip() for h in table[0]]
    rows = [r for r in table[1:] if any(c.strip() for c in r)]
    email_col = _pick_column(headers, rows, _EMAIL_HEADER, lambda v: "@" in v)
    phone_col = _pick_column(headers, rows, _PHONE_HEADER, lambda v: bool(normalise_phone(v)))
    if email_col is None and phone_col is None:
        raise SheetError("Couldn't find an email or phone column in the sheet. The form needs a question "
                         "with 'email' or 'phone' / 'mobile' in its title.")
    sheet = {"headers": headers, "rows": rows, "email_col": email_col, "phone_col": phone_col, "fetched_at": now}
    with _cache_lock:
        _cache[url] = (now, sheet)
    return sheet


def describe(sheet: dict) -> dict:
    """Short summary shown in the UI after the link is saved."""
    h = sheet["headers"]
    return {
        "responses": len(sheet["rows"]),
        "questions": len(h),
        "email_column": h[sheet["email_col"]] if sheet["email_col"] is not None else None,
        "phone_column": h[sheet["phone_col"]] if sheet["phone_col"] is not None else None,
    }


def _cell(row: list[str], i) -> str:
    return row[i].strip() if i is not None and i < len(row) else ""


def find_response(sheet: dict, emails: list[str], phones: list[str]) -> dict | None:
    """The newest row whose email or phone matches. Returns
    {"answers": [[question, answer], ...], "matched_by": "email"|"phone", "submitted_at": str}."""
    emails = {e.strip().lower() for e in emails if e}
    phones = {p for p in (normalise_phone(x) for x in phones) if p}
    by_email = by_phone = None
    for row in sheet["rows"]:  # later rows are newer submissions
        if emails and _cell(row, sheet["email_col"]).lower() in emails:
            by_email = row
        elif phones and normalise_phone(_cell(row, sheet["phone_col"])) in phones:
            by_phone = row
    row, how = (by_email, "email") if by_email else (by_phone, "phone")
    if not row:
        return None
    answers, submitted = [], ""
    for i, q in enumerate(sheet["headers"]):
        a = _cell(row, i)
        if _TIMESTAMP_HEADER.match(q or ""):
            submitted = a
            continue
        if q and a:
            answers.append([q, a])
    return {"answers": answers, "matched_by": how, "submitted_at": submitted}


def answers_text(response: dict) -> str:
    """Form answers as plain text for the AI prompt."""
    return "\n".join(f"Q: {q}\nA: {a}" for q, a in response.get("answers") or [])[:6000]
