"""
Background watcher for resumes waiting on the Google Form.

Every config.FORM_CHECK_MINUTES it re-reads each role's response sheet and
marks pending resumes whose candidate has now filled the form. Those show up
as notifications (sidebar bell); the hiring team then clicks Screen.

It also reconciles each role's Form Pending folder with the database, so the
list rebuilds itself if the database was reset (e.g. a redeploy without a
persistent disk): files found in the folder but not in the table are read
(regex only, no AI) and added; rows whose file left the folder are dropped.
"""
import threading
import time
import traceback

import config
import forksafe
import google_sheets
import resume_parser
import storage
import zoho_workdrive
from google_sheets import SheetError
from zoho_workdrive import WorkDriveError

_lock = threading.Lock()          # one check at a time
_started = False
_state = {"last_check": None, "running": False, "errors": {}, "newly_filled": 0}


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _lock, _started
    _lock = threading.Lock()
    _started = False                 # the watcher thread did not survive the fork; app.py restarts it
    _state["running"] = False


def status() -> dict:
    return {**_state, "errors": dict(_state["errors"]), "interval_minutes": config.FORM_CHECK_MINUTES}


def start() -> None:
    """Starts the periodic watcher once per process."""
    global _started
    if _started or config.FORM_CHECK_MINUTES <= 0:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="form-watch").start()


def _loop() -> None:
    time.sleep(30)  # let the server finish starting
    while True:
        try:
            check_all()
        except Exception:
            traceback.print_exc()
        time.sleep(config.FORM_CHECK_MINUTES * 60)


def check_all() -> dict:
    """Checks every role that has a response sheet. Returns
    {"checked_roles", "newly_filled", "errors"}; skips if a check is running."""
    if not _lock.acquire(blocking=False):
        return {"checked_roles": 0, "newly_filled": 0, "errors": {}, "busy": True}
    _state["running"] = True
    newly, errors, roles = 0, {}, storage.roles_with_form_sheet()
    try:
        for jd in roles:
            try:
                newly += _check_role(jd)
            except (SheetError, WorkDriveError) as e:
                errors[jd["role_name"]] = str(e)
            except Exception as e:
                traceback.print_exc()
                errors[jd["role_name"]] = f"Unexpected error: {e}"
    finally:
        _state.update(last_check=storage.now(), running=False, errors=errors, newly_filled=newly)
        _lock.release()
    return {"checked_roles": len(roles), "newly_filled": newly, "errors": errors}


def _find_pending_folder(role_id: str) -> str | None:
    for f in zoho_workdrive.list_children(role_id)["folders"]:
        if f["name"].strip().lower() == config.FORM_PENDING_FOLDER.lower():
            return f["id"]
    return None


def _reconcile(jd: dict) -> None:
    role_id = jd["role_folder_id"]
    folder_id = _find_pending_folder(role_id)
    rows = {r["file_id"]: r for r in storage.list_form_pending(role_id)}
    files = zoho_workdrive.list_children(folder_id)["files"] if folder_id else []
    in_folder = {f["id"] for f in files}

    busy = storage.latest_screening_by_file([f["id"] for f in files])
    for f in files:
        if f["id"] in rows or (busy.get(f["id"]) or {}).get("stage", "done") != "done":
            continue
        try:
            parsed = resume_parser.extract(zoho_workdrive.download_file(f["id"]), f["name"])
        except Exception as e:
            storage.log("warn", f"Form Pending: couldn't read '{f['name']}' in {jd['role_name']}: {e}")
            continue
        contacts = resume_parser.find_contacts(parsed)
        storage.add_form_pending(
            file_id=f["id"], filename=f["name"], role_folder_id=role_id, role_name=jd["role_name"],
            pending_folder_id=folder_id, from_folder_id=folder_id,
            from_folder_path=f"{jd['role_name']} / {config.FORM_PENDING_FOLDER}",
            emails=contacts["emails"], phones=contacts["phones"])

    # Rows whose file was moved or deleted outside the app. Only rows that
    # point at this folder - a resume that couldn't be moved stays tracked.
    for file_id, r in rows.items():
        if folder_id and r["pending_folder_id"] == folder_id and file_id not in in_folder:
            storage.remove_form_pending(file_id)


def _check_role(jd: dict) -> int:
    _reconcile(jd)
    waiting = [r for r in storage.list_form_pending(jd["role_folder_id"]) if not r["filled_at"]]
    invited = storage.invites_awaiting_form(jd["role_folder_id"])
    if not waiting and not invited:
        return 0
    sheet = google_sheets.load(jd["form_sheet_url"], fresh=True)
    newly = 0
    # Applicants who were sent the form: mark them ready to screen once they answer.
    for inv in invited:
        emails = [e for e in [inv["email"], *inv["other_emails"]] if e]
        response = google_sheets.find_response(sheet, emails, inv["phones"])
        if response and storage.mark_invite_filled(inv["id"], response):
            newly += 1
            storage.log("info", f"Google Form filled: {inv['candidate']} ({jd['role_name']}) - matched by "
                                f"{response['matched_by']}. Ready to screen.")
    for r in waiting:
        response = google_sheets.find_response(sheet, r["emails"], r["phones"])
        if response and storage.mark_form_filled(r["file_id"]):
            newly += 1
            storage.log("info", f"Google Form filled: '{r['filename']}' ({jd['role_name']}) - matched by "
                                f"{response['matched_by']}. Ready to screen in {config.FORM_PENDING_FOLDER}.")
    return newly
