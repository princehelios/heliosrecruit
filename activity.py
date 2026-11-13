"""
Applications per day, for the dashboard's "Applications by date" chart.

Two counts per (day, position):

  resumes    resumes received. A resume's day is the date in its folder name
             ("13 Nov" - the email fetcher files each resume under the date the
             email arrived, and HR uses the same convention). Resumes outside a
             date folder (dropped straight into the position, Form Pending,
             Walk-in) use their WorkDrive upload time instead. Resumes already
             deleted from WorkDrive after reaching Zoho Recruit are still
             counted, from the screening history.
  responses  Google Form submissions, from the Timestamp column of each
             position's linked response sheet.

Resumes are also split by source: email (fetched by the app), walk-in (added
by HR) or upload (everything else).
"""
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import config
import google_sheets
import storage
import zoho_workdrive
from google_sheets import SheetError
from zoho_workdrive import WorkDriveError

_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_FOLDER_DATE = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?(?:[\s-]+(\d{4}))?$", re.I)


def folder_date(name: str, today: date | None = None) -> date | None:
    """'13 Nov', '7 oct 2026', '17 september' -> a date; None if the name isn't one.
    Without a year, a date more than a month ahead is taken as last year's
    (a '28 Dec' folder seen in January). Mirrors folderDate() in app.js."""
    m = _FOLDER_DATE.match((name or "").strip())
    if not m:
        return None
    day, mon = int(m.group(1)), m.group(2)[:3].lower()
    if mon not in _MONTHS:
        return None
    today = today or date.today()
    year = int(m.group(3)) if m.group(3) else today.year
    try:
        d = date(year, _MONTHS.index(mon) + 1, day)
    except ValueError:
        return None
    if not m.group(3) and (d - today).days > 31:
        try:
            d = d.replace(year=year - 1)
        except ValueError:  # 29 Feb
            return None
    return d


def _ms_date(ms) -> date | None:
    try:
        return datetime.fromtimestamp(int(ms) / 1000).date() if ms else None
    except (TypeError, ValueError, OSError):
        return None


def _iso_date(value: str | None) -> date | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().date() if value else None
    except (ValueError, AttributeError):
        return None


# ---------------------------------------------------------------- Google Form timestamps

_TS = re.compile(r"^\s*(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})")


def _timestamp_dates(values: list[str]) -> list[date]:
    """Google Forms writes timestamps in the sheet's locale: M/D/YYYY (US) or
    D/M/YYYY (India, UK...). The whole column shares one order, so it is
    decided once: a first part above 12 means day-first, a second part above
    12 means month-first; if neither ever happens, day-first is assumed."""
    parts = [m.groups() for m in (_TS.match(v or "") for v in values) if m]
    if not parts:
        return []
    if any(len(a) == 4 for a, _, _ in parts):
        order = "ymd"
    elif any(int(a) > 12 for a, _, _ in parts):
        order = "dmy"
    elif any(int(b) > 12 for _, b, _ in parts):
        order = "mdy"
    else:
        order = "dmy"
    out = []
    for a, b, c in parts:
        a, b, c = int(a), int(b), int(c)
        y, mo, d = (a, b, c) if order == "ymd" else (c, b, a) if order == "dmy" else (c, a, b)
        if y < 100:
            y += 2000
        try:
            out.append(date(y, mo, d))
        except ValueError:
            pass
    return out


# Downloading a response sheet takes 1-3 s, so the dashboard reuses the last
# parse: fresh for _SHEET_FRESH seconds, then served while a background
# refresh runs (same idea as the WorkDrive listing cache).
_SHEET_FRESH = 120
_sheet_cache: dict[str, tuple[float, tuple]] = {}
_sheet_refreshing: set[str] = set()
_sheet_lock = threading.Lock()
_sheet_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sheet-refresh")


def _form_responses(role_id: str, url: str) -> tuple[str, list[date], str | None]:
    with _sheet_lock:
        hit = _sheet_cache.get(url)
        if hit and time.time() - hit[0] < _SHEET_FRESH:
            return (role_id, *hit[1])
        if hit:
            if url not in _sheet_refreshing:
                _sheet_refreshing.add(url)
                _sheet_pool.submit(_refresh_sheet, url)
            return (role_id, *hit[1])
    return (role_id, *_refresh_sheet(url))


def _refresh_sheet(url: str) -> tuple[list[date], str | None]:
    try:
        result = _parse_sheet(url)
        with _sheet_lock:
            _sheet_cache[url] = (time.time(), result)
        return result
    finally:
        with _sheet_lock:
            _sheet_refreshing.discard(url)


def _parse_sheet(url: str) -> tuple[list[date], str | None]:
    try:
        sheet = google_sheets.load(url)
    except SheetError as e:
        return [], str(e)
    col = next((i for i, h in enumerate(sheet["headers"]) if google_sheets._TIMESTAMP_HEADER.match(h or "")), None)
    if col is None:
        return [], "The response sheet has no Timestamp column."
    return _timestamp_dates([r[col] if col < len(r) else "" for r in sheet["rows"]]), None


# ---------------------------------------------------------------- WorkDrive resumes

def _live_resumes(today: date) -> tuple[list[dict], dict, list[str]]:
    """Every resume currently in WorkDrive: [{file_id, role_id, date, walkin}],
    the position names, and any folders that couldn't be read."""
    errors: list[str] = []
    roles = zoho_workdrive.list_children(config.WORKDRIVE_ROOT_FOLDER_ID, cached=True)["folders"]
    names = {r["id"]: r["name"] for r in roles}
    walkin_name = config.WALKIN_FOLDER.strip().lower()

    def role_listing(role):
        try:
            return role, zoho_workdrive.list_children(role["id"], cached=True)
        except WorkDriveError as e:
            errors.append(f"{role['name']}: {e}")
            return role, {"folders": [], "files": []}

    def sub_listing(job):
        role, sub = job
        try:
            return role, sub, zoho_workdrive.list_children(sub["id"], cached=True)["files"]
        except WorkDriveError as e:
            errors.append(f"{role['name']} / {sub['name']}: {e}")
            return role, sub, []

    out = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        listings = list(pool.map(role_listing, roles))
        for role, c in listings:
            for f in c["files"]:
                out.append({"file_id": f["id"], "role_id": role["id"],
                            "date": _ms_date(f.get("added") or f.get("modified")), "walkin": False})
        jobs = [(role, sub) for role, c in listings for sub in c["folders"]]
        for role, sub, files in pool.map(sub_listing, jobs):
            day = folder_date(sub["name"], today)
            walkin = sub["name"].strip().lower() == walkin_name
            for f in files:
                out.append({"file_id": f["id"], "role_id": role["id"], "walkin": walkin,
                            "date": day or _ms_date(f.get("added") or f.get("modified"))})
    return out, names, errors


def _history(today: date) -> list[dict]:
    """Screened resumes, with where they were and when they arrived - covers the
    ones the pipeline has since deleted from WorkDrive."""
    with storage._conn() as c:
        try:
            rows = c.execute(
                """SELECT s.file_id, s.created_at, s.file_added_ms, r.role_folder_id, r.role_name, r.folder_path
                   FROM screenings s JOIN runs r ON r.id = s.run_id
                   WHERE s.id IN (SELECT MAX(id) FROM screenings GROUP BY file_id)""").fetchall()
        except sqlite3.OperationalError:
            return []
    out = []
    for r in rows:
        last = (r["folder_path"] or "").split(" / ")[-1]
        day = folder_date(last, today) if (r["folder_path"] or "").count(" / ") >= 2 else None
        out.append({"file_id": r["file_id"], "role_id": r["role_folder_id"], "role_name": r["role_name"],
                    "date": day or _ms_date(r["file_added_ms"]) or _iso_date(r["created_at"]), "walkin": False})
    return out


def daily_activity() -> dict:
    today = date.today()
    with storage._conn() as c:
        emailed = {r[0] for r in c.execute("SELECT file_id FROM fetched_emails WHERE file_id IS NOT NULL")}
        walkins = {r[0] for r in c.execute("SELECT file_id FROM walkins")}
        sheets = {r["role_folder_id"]: r["form_sheet_url"] for r in c.execute(
            "SELECT role_folder_id, form_sheet_url FROM job_descriptions "
            "WHERE form_sheet_url IS NOT NULL AND form_sheet_url != ''")}

    with ThreadPoolExecutor(max_workers=8) as pool:
        sheet_jobs = [pool.submit(_form_responses, rid, url) for rid, url in sheets.items()]
        live, names, errors = _live_resumes(today)
        history = _history(today)
        sheet_results = [f.result() for f in sheet_jobs]

    seen = {r["file_id"] for r in live}
    resumes = live + [h for h in history if h["file_id"] not in seen]
    for h in history:
        names.setdefault(h["role_id"], h["role_name"])

    counts: dict[tuple[str, str], dict] = {}

    def bucket(day: date, role_id: str) -> dict:
        key = (day.isoformat(), role_id)
        if key not in counts:
            counts[key] = {"date": key[0], "role_id": role_id, "resumes": 0, "responses": 0,
                           "email": 0, "walkin": 0, "upload": 0}
        return counts[key]

    undated = 0
    for r in resumes:
        if not r["date"]:
            undated += 1
            continue
        b = bucket(r["date"], r["role_id"])
        b["resumes"] += 1
        source = "email" if r["file_id"] in emailed else "walkin" if (r["walkin"] or r["file_id"] in walkins) else "upload"
        b[source] += 1

    sheet_errors = []
    for role_id, days, err in sheet_results:
        if err:
            sheet_errors.append({"role_id": role_id, "role_name": names.get(role_id, role_id), "error": err})
        for d in days:
            bucket(d, role_id)["responses"] += 1

    used = {k[1] for k in counts}
    return {
        "today": today.isoformat(),
        "rows": sorted(counts.values(), key=lambda b: (b["date"], b["role_id"])),
        "roles": sorted(({"id": i, "name": names.get(i, "(deleted position)")} for i in used),
                        key=lambda r: r["name"].lower()),
        "sheet_errors": sheet_errors,
        "folder_errors": errors,
        "undated": undated,
    }
