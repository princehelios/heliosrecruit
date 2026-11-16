"""
Resume Screener - Flask app.

Hiring team flow:
  1. Browse ROOT / role / date folders in WorkDrive.
  2. Each role has an editable job description + pass threshold.
  3. "Screen resumes" on a folder runs the pipeline in the background
     (see pipeline.py): score every resume, push passed candidates to
     Zoho Recruit, then delete them from WorkDrive after verification.
  4. Every run, result and deletion is kept in the audit log (screener.db).

Run:  PORT=5001 python3 app.py
"""
import gzip
import os
import re
import threading
import traceback

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

import activity
import ai_scorer
import applicants
import config
import db_backup
import email_fetcher
import forksafe
import form_watch
import google_sheets
import keepalive
import mailer
import pipeline
import role_settings
import storage
import zoho_auth
import zoho_recruit
import zoho_workdrive
from google_sheets import SheetError
from zoho_auth import ZohoAuthError
from zoho_workdrive import OutsideRootError, WorkDriveError

app = Flask(__name__)
app.secret_key = config.FLASK_SECRET_KEY
app.config["PROPAGATE_EXCEPTIONS"] = False
# 50 resumes x 10 MB each, plus multipart overhead.
app.config["MAX_CONTENT_LENGTH"] = 520 * 1024 * 1024
# app.js and style.css are cached for a year. Safe because every static URL
# carries a ?v=<mtime> stamp (see _static_cache_bust) that changes on deploy,
# so a new build is picked up immediately instead of serving stale JS.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 31536000



# ------------------------------------------------- static assets & transfer

_static_versions: dict[str, str] = {}


def _static_version(filename: str) -> str:
    """mtime stamp for a static file, read once per process."""
    if filename not in _static_versions:
        try:
            path = os.path.join(app.static_folder, filename)
            _static_versions[filename] = str(int(os.path.getmtime(path)))
        except OSError:
            _static_versions[filename] = "0"
    return _static_versions[filename]


@app.url_defaults
def _static_cache_bust(endpoint, values):
    if endpoint == "static" and "filename" in values:
        values["v"] = _static_version(values["filename"])


# Responses worth compressing: the UI bundle is ~130 KB of JS+CSS and the
# bigger API payloads (folder listings, activity log) are pure JSON, which
# gzips to roughly a fifth. Below this size the CPU cost isn't worth it.
_GZIP_MIN_BYTES = 1024
_GZIP_TYPES = ("text/", "application/json", "application/javascript", "image/svg+xml")


# Static files come back as a streamed file handle (direct_passthrough), which
# skips normal body handling. There are only two of them and they never change
# while the process runs, so each is compressed once and kept in memory.
_static_gzip: dict[str, bytes] = {}


@app.after_request
def _compress(response):
    if response.status_code < 200 or response.status_code >= 300:
        return response
    if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
        return response
    if response.direct_passthrough:
        if request.endpoint != "static":
            return response                   # never buffer an unknown stream
        key = request.path
        response.direct_passthrough = False   # must come first: get_data() needs it off
        if key not in _static_gzip:
            _static_gzip[key] = gzip.compress(response.get_data(), compresslevel=9)
        packed = _static_gzip[key]
        response.set_data(packed)
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(packed))
        response.headers.setdefault("Vary", "Accept-Encoding")
        return response
    if response.headers.get("Content-Encoding"):
        return response
    ctype = (response.headers.get("Content-Type") or "").split(";")[0].strip()
    if not ctype.startswith(_GZIP_TYPES):
        return response
    # Caches must not hand a gzipped body to a client that can't read it.
    response.headers.setdefault("Vary", "Accept-Encoding")
    if response.content_length is not None and response.content_length < _GZIP_MIN_BYTES:
        return response

    data = response.get_data()
    if len(data) < _GZIP_MIN_BYTES:
        return response
    packed = gzip.compress(data, compresslevel=6)
    if len(packed) >= len(data):      # already-compressed payload, leave it
        return response
    response.set_data(packed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(packed))
    return response


def _warm_cache():
    # Fill the WorkDrive listing cache in the background so the first visit
    # to the Positions page is instant instead of waiting on ~20 Zoho calls.
    try:
        zoho_workdrive.browse(None, live=True)
        activity.daily_activity()  # also lists every date folder for the dashboard chart
    except Exception as e:  # noqa: BLE001 - warming is best-effort
        print(f"WorkDrive cache warm-up skipped: {e}")


def _start_background() -> None:
    """Every background thread the app runs."""
    db_backup.start()
    form_watch.start()
    keepalive.start()
    role_settings.start()   # refills position settings from WorkDrive after a redeploy
    threading.Thread(target=_warm_cache, name="wd-warm", daemon=True).start()


# ------------------------------------------------- start-up (per serving process)
# Importing this module does NOTHING that touches the network, starts a thread
# or opens the database. On Render the module was imported in one process and
# the serving process was forked from it; anything running at that instant
# (a thread mid DNS lookup, mid token refresh) left a lock held forever in the
# copy, and every Zoho call hung. Now all start-up work runs in the process
# that serves requests: gunicorn.conf.py calls ensure_started() right after the
# worker boots, and the first request does it too if that hook didn't run.

_startup_lock = threading.Lock()
_started_pid: int | None = None


@forksafe.after_fork
def _reset_startup_after_fork() -> None:
    global _startup_lock
    _startup_lock = threading.Lock()


def ensure_started() -> None:
    """Restore the database copy, open the database and start the background
    threads - once per process."""
    global _started_pid
    if _started_pid == os.getpid():
        return
    with _startup_lock:
        if _started_pid == os.getpid():
            return
        db_backup.restore()   # before the database opens: brings back the copy from MongoDB after a redeploy
        storage.init_db()
        interrupted = storage.mark_interrupted_runs()
        if interrupted:
            print(f"Marked {interrupted} interrupted run(s) from a previous server session as failed.")
        stuck = storage.reset_stuck_invites()
        if stuck:
            print(f"Put {stuck} form invite(s) interrupted mid-send back to 'ready'.")
        _start_background()
        _started_pid = os.getpid()
        print(f"Start-up done in process {_started_pid}.")


@app.before_request
def _boot_if_needed():
    if _started_pid == os.getpid():
        return None
    if request.path == "/healthz":
        # Never make the health check wait on start-up (Mongo restore etc.).
        threading.Thread(target=ensure_started, name="startup", daemon=True).start()
        return None
    ensure_started()
    return None

REQUIRED_SCOPES = {
    "WorkDrive.files.READ": "Browse folders and download resumes",
    "WorkDrive.files.CREATE": "Create folders and upload resumes",
    "WorkDrive.files.UPDATE": "Move passed resumes to trash",
    "WorkDrive.files.DELETE": "Permanently delete passed resumes",
    "ZohoRecruit.modules.ALL": "Create candidates and attach resumes",
    "ZohoRecruit.settings.READ": "Read Recruit field types for exact mapping",
}


def _error(message: str, status: int):
    return jsonify({"error": message}), status


@app.errorhandler(Exception)
def handle_uncaught(e):
    if isinstance(e, HTTPException):
        # Normal HTTP errors (404 for /favicon.ico etc.) keep their own status.
        if request.path.startswith("/api/"):
            return _error(e.description or e.name, e.code or 500)
        return e
    if request.path.startswith("/api/"):
        traceback.print_exc()
        if isinstance(e, OutsideRootError):
            return _error(str(e), 403)
        if isinstance(e, (WorkDriveError, ZohoAuthError)):
            return _error(str(e), 502)
        if isinstance(e, email_fetcher.EmailFetchError):
            return _error(str(e), 502)
        if isinstance(e, pipeline.PipelineError):
            return _error(str(e), 400)
        if isinstance(e, SheetError):
            return _error(str(e), 400)
        if isinstance(e, mailer.MailError):
            return _error(str(e), 400)
        return _error(f"Unexpected server error: {e}", 500)
    raise e


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/healthz")
def healthz():
    # Render's health check: no template, no DB, no Zoho call - answers even
    # while a big screening run keeps the server busy.
    return "ok", 200, {"Content-Type": "text/plain"}


# ---------------------------------------------------------------- status

@app.get("/api/status")
def api_status():
    status = {
        "root_folder_id": config.WORKDRIVE_ROOT_FOLDER_ID,
        "default_threshold": config.DEFAULT_PASS_THRESHOLD,
        "bands": {"high": config.BAND_HIGH, "medium": config.BAND_MEDIUM},
        "form_pending_folder": config.FORM_PENDING_FOLDER,
        "walkin_folder": config.WALKIN_FOLDER,
        "delete_enabled": config.WORKDRIVE_DELETE_ENABLED,
        "openai_configured": bool(config.OPENAI_API_KEY),
        "model": config.OPENAI_MODEL,
        "keepalive": keepalive.status(),
        "settings_restore": role_settings.status(),
        "db_backup": db_backup.status(),
        "zoho_connected": False,
        "scopes": [],
        "recruit_schema": None,
        "warnings": [],
    }
    try:
        granted = zoho_auth.granted_scopes()
        status["zoho_connected"] = True
    except ZohoAuthError as e:
        status["warnings"].append(f"Zoho connection failed: {e}")
        return jsonify(status)

    for scope, purpose in REQUIRED_SCOPES.items():
        status["scopes"].append({"scope": scope, "purpose": purpose, "granted": scope in granted})

    missing = [s["scope"] for s in status["scopes"] if not s["granted"]]
    if any(s.startswith("WorkDrive.files.") and s != "WorkDrive.files.READ" for s in missing) \
            and config.WORKDRIVE_DELETE_ENABLED:
        status["warnings"].append(
            "Passed resumes can't be deleted from WorkDrive yet: the Zoho token is missing delete "
            "permission. Candidates still reach Recruit, and files stay in WorkDrive until the token "
            "is regenerated."
        )

    status["recruit_schema"] = zoho_recruit.schema_status()
    if not status["openai_configured"]:
        status["warnings"].append("OPENAI_API_KEY is not set - resumes cannot be scored.")
    return jsonify(status)


# ---------------------------------------------------------------- browsing

@app.get("/api/browse")
def api_browse():
    live = request.args.get("live", "").lower() in {"1", "true", "yes"}
    data = zoho_workdrive.browse(request.args.get("folder_id") or None, live=live)

    jds = storage.list_jds()
    overview = storage.role_overview() if data["depth"] == 0 else {}
    all_ids = [i for sub in data["subfolders"] for i in sub.get("file_ids", [])]
    screened = storage.latest_screening_by_file(all_ids)
    for sub in data["subfolders"]:
        if data["depth"] == 0:
            jd = jds.get(sub["id"]) or {}
            sub["has_jd"] = bool((jd.get("jd_text") or "").strip())
            sub["has_sheet"] = bool(jd.get("form_sheet_url"))
            sub["waiting"] = (overview.get(sub["id"]) or {}).get("waiting", 0)
            sub["last_activity"] = (overview.get(sub["id"]) or {}).get("last_activity")
        # Resumes directly in this folder that were never screened.
        sub["unscreened"] = sum(1 for i in sub.pop("file_ids", []) if i not in screened)

    latest = storage.latest_screening_by_file([f["id"] for f in data["files"]])
    for f in data["files"]:
        f["last_screening"] = latest.get(f["id"])

    if data["role"]:
        data["jd"] = storage.get_jd(data["role"]["id"])
    data["runs"] = storage.list_runs(limit=10, folder_id=data["folder"]["id"])
    active = storage.active_run_for_folder(data["folder"]["id"])
    data["active_run_id"] = active["id"] if active else None
    return jsonify(data)


# ---------------------------------------------------------------- folders & uploads

@app.post("/api/folders")
def api_create_folder():
    body = request.get_json(force=True, silent=True) or {}
    parent_id = (body.get("parent_id") or "").strip() or config.WORKDRIVE_ROOT_FOLDER_ID
    folder = zoho_workdrive.create_folder(parent_id, body.get("name") or "")
    storage.log("info", f"Folder '{folder['name']}' created from the app.")
    return jsonify(folder), 201


@app.post("/api/folders/<folder_id>/upload")
def api_upload(folder_id):
    files = request.files.getlist("files")
    if not files:
        return _error("Choose at least one resume to upload.", 400)
    if len(files) > 50:
        return _error("Upload at most 50 resumes at a time.", 400)
    results = []
    for f in files:
        name = f.filename or "resume"
        try:
            uploaded = zoho_workdrive.upload_resume(folder_id, name, f.read())
            results.append({"name": uploaded["name"], "id": uploaded["id"], "ok": True})
        except WorkDriveError as e:
            results.append({"name": name, "ok": False, "error": str(e)})
    ok = [r for r in results if r["ok"]]
    if ok:
        storage.log("info", f"Uploaded {len(ok)} resume(s) from the app: {', '.join(r['name'] for r in ok)}.")
    return jsonify({"results": results, "uploaded": len(ok), "failed": len(results) - len(ok)})


# ---------------------------------------------------------------- email fetch

@app.post("/api/fetch-emails")
def api_fetch_emails():
    """Starts a background fetch of Indeed application emails (or reports the one
    already running). Poll GET /api/fetch-emails/status for progress."""
    return jsonify(email_fetcher.start_fetch())


@app.get("/api/fetch-emails/status")
def api_fetch_status():
    return jsonify(email_fetcher.status())


# ---------------------------------------------------------------- JDs

@app.get("/api/roles/<role_folder_id>/jd")
def api_get_jd(role_folder_id):
    return jsonify(storage.get_jd(role_folder_id) or {})


@app.put("/api/roles/<role_folder_id>/jd")
def api_save_jd(role_folder_id):
    body = request.get_json(force=True, silent=True) or {}
    path = zoho_workdrive.resolve_path(role_folder_id)
    if len(path) != 2:
        return _error("Job descriptions belong to role folders (the first level inside the root).", 400)

    jd_text = (body.get("jd_text") or "").strip()
    if len(jd_text) < 30:
        return _error("The job description is too short to screen against - add the role's requirements.", 400)
    # Bands replaced the per-role pass mark: High/Medium (50+) always pass.
    threshold = config.BAND_MEDIUM

    previous = storage.get_jd(role_folder_id)
    # The sheet link has its own card/page now; a JD save keeps it unless sent.
    if "form_sheet_url" in body:
        sheet_url = _checked_sheet_url(body.get("form_sheet_url"))[0]
    else:
        sheet_url = (previous or {}).get("form_sheet_url") or ""
    saved = storage.save_jd(role_folder_id, path[1]["name"], jd_text, threshold, sheet_url)
    change = "created" if not (previous and previous["jd_text"].strip()) else (
        "updated" if previous["jd_text"] != jd_text else "saved (no change)")
    storage.log("info", f"Job description for '{path[1]['name']}' {change}.")
    role_settings.backup(role_folder_id)
    return jsonify(saved)


def _checked_sheet_url(raw) -> tuple[str, dict | None]:
    """(url, summary) after reading the sheet once; ("", None) to clear it.
    Raises SheetError (400) if the link is wrong or the sheet isn't public."""
    url = (raw or "").strip()
    if not url:
        return "", None
    google_sheets.parse_url(url)
    return url, google_sheets.describe(google_sheets.load(url, fresh=True))


def _role_folder(role_folder_id: str) -> dict:
    path = zoho_workdrive.resolve_path(role_folder_id)
    if len(path) != 2:
        raise pipeline.PipelineError("Google Form sheets belong to position folders (the first level inside the root).")
    return path[1]


@app.get("/api/roles")
def api_roles():
    """Every position folder with its JD / sheet link, for the Form sheets page."""
    jds = storage.list_jds()
    roles = []
    for f in zoho_workdrive.list_children(config.WORKDRIVE_ROOT_FOLDER_ID, cached=True)["folders"]:
        jd = jds.get(f["id"]) or {}
        roles.append({"id": f["id"], "name": f["name"], "has_jd": bool((jd.get("jd_text") or "").strip()),
                      "modified": f.get("modified"),
                      "form_sheet_url": jd.get("form_sheet_url") or "", "form_url": jd.get("form_url") or "",
                      "custom_template": bool(jd.get("invite_subject") or jd.get("invite_body"))})
    roles.sort(key=lambda r: r["name"].lower())
    return jsonify({"roles": roles})


@app.put("/api/roles/<role_folder_id>/sheet")
def api_save_sheet(role_folder_id):
    body = request.get_json(force=True, silent=True) or {}
    role = _role_folder(role_folder_id)
    url, info = _checked_sheet_url(body.get("form_sheet_url"))
    previous = (storage.get_jd(role_folder_id) or {}).get("form_sheet_url") or ""
    storage.set_form_sheet(role_folder_id, role["name"], url)
    role_settings.backup(role_folder_id)
    if url != previous:
        storage.log("info", f"Google Form sheet for '{role['name']}' "
                            + (f"set ({info['responses']} responses)." if url else "removed - resumes are scored alone."))
    return jsonify({"linked": bool(url), "ok": bool(url), "form_sheet_url": url, **(info or {})})


@app.get("/api/roles/<role_folder_id>/sheet")
def api_role_sheet(role_folder_id):
    """Checks the role's response sheet is readable and which columns match."""
    jd = storage.get_jd(role_folder_id) or {}
    url = (jd.get("form_sheet_url") or "").strip()
    if not url:
        return jsonify({"linked": False})
    try:
        return jsonify({"linked": True, "ok": True, "form_sheet_url": url,
                        **google_sheets.describe(google_sheets.load(url))})
    except SheetError as e:
        return jsonify({"linked": True, "ok": False, "form_sheet_url": url, "error": str(e)})


# ---------------------------------------------------------------- runs

@app.post("/api/runs")
def api_start_run():
    body = request.get_json(force=True, silent=True) or {}
    folder_id = (body.get("folder_id") or "").strip()
    if not folder_id:
        return _error("folder_id is required.", 400)
    if not config.OPENAI_API_KEY:
        return _error("OPENAI_API_KEY is not set - resumes cannot be scored.", 400)
    file_ids = body.get("file_ids")
    if file_ids is not None:
        if not isinstance(file_ids, list) or not all(isinstance(x, str) and x.isalnum() for x in file_ids):
            return _error("file_ids must be a list of WorkDrive file ids.", 400)
        if not file_ids:
            return _error("Select at least one resume to screen.", 400)
        if len(file_ids) > 500:
            return _error("Select at most 500 resumes per run.", 400)
    run_id = pipeline.start_run(folder_id, rescreen=bool(body.get("rescreen")), file_ids=file_ids or None)
    return jsonify({"run_id": run_id}), 202


@app.get("/api/runs")
def api_list_runs():
    return jsonify({"runs": storage.list_runs(limit=int(request.args.get("limit", 100)))})


@app.get("/api/runs/<int:run_id>")
def api_get_run(run_id):
    run = storage.get_run(run_id)
    if not run:
        return _error("Run not found.", 404)
    run.pop("jd_snapshot", None)
    _with_cost(run)
    return jsonify({
        "run": run,
        "screenings": storage.screenings_for_run(run_id),
        "events": storage.events(run_id=run_id, after_id=int(request.args.get("after_event", 0))),
    })


@app.delete("/api/runs/<int:run_id>")
def api_cancel_run(run_id):
    run = storage.get_run(run_id)
    if not run:
        return _error("Run not found.", 404)
    if run["status"] == "cancelling":
        return jsonify({"status": "cancelling"})
    if run["status"] != "running" or not storage.request_cancel_run(run_id):
        return _error("This screening is no longer running.", 409)
    storage.log("warn", "Screening stop requested by the user.", run_id)
    return jsonify({"status": "cancelling"})


@app.get("/api/runs/<int:run_id>/jd")
def api_run_jd(run_id):
    run = storage.get_run(run_id)
    if not run:
        return _error("Run not found.", 404)
    return jsonify({"jd_text": run["jd_snapshot"], "pass_threshold": run["pass_threshold"]})


@app.get("/api/screenings/<int:screening_id>")
def api_get_screening(screening_id):
    s = storage.get_screening(screening_id)
    if not s:
        return _error("Screening not found.", 404)
    s["walkin"] = storage.get_walkin(s["file_id"])
    return jsonify(s)


def _with_cost(block: dict) -> dict:
    block["tokens_total"] = (block.get("prompt_tokens") or 0) + (block.get("completion_tokens") or 0)
    block["estimated_cost_usd"] = round(ai_scorer.estimate_cost(
        block.get("prompt_tokens") or 0, block.get("completion_tokens") or 0, block.get("cached_tokens") or 0), 4)
    return block


@app.get("/api/dashboard")
def api_dashboard():
    data = storage.dashboard()
    _with_cost(data["tokens"])
    analysed = data["tokens"].get("analysed") or 0
    data["tokens"]["avg_tokens_per_resume"] = round(data["tokens"]["tokens_total"] / analysed) if analysed else 0
    data["recent_runs"] = [_with_cost(r) for r in storage.list_runs(limit=6)]
    return jsonify(data)


@app.get("/api/activity")
def api_activity():
    """Resumes received and Google Form responses per day and position."""
    return jsonify(activity.daily_activity())


@app.get("/api/candidates")
def api_candidates():
    outcome = request.args.get("outcome") or None
    if outcome and outcome not in ("passed", "rejected", "failed", "form_pending", "walkin"):
        return _error("outcome must be passed, rejected, failed, form_pending or walkin.", 400)
    recruit = request.args.get("recruit") or None
    if recruit and recruit not in storage._RECRUIT_FILTERS:
        return _error("recruit must be saved, not_saved or failed.", 400)
    band = request.args.get("band") or None
    if band and band not in storage.BAND_FILTERS:
        return _error("band must be high, medium or low.", 400)
    rows = storage.candidates(outcome=outcome, role_folder_id=request.args.get("role") or None,
                              query=(request.args.get("q") or "").strip() or None, recruit=recruit, band=band)
    roles = sorted({(r["role_folder_id"], r["role_name"]) for r in storage.candidates()}, key=lambda x: x[1].lower())
    return jsonify({"candidates": rows, "roles": [{"id": i, "name": n} for i, n in roles]})


# ---------------------------------------------------------------- WorkDrive rename / move / delete

def _busy_folder(folder_id: str):
    run = storage.active_run_for_folder(folder_id)
    if run:
        raise pipeline.PipelineError("A screening run is in progress in this folder - wait for it to finish "
                                     "or stop it first.")


@app.get("/api/folders/tree")
def api_folder_tree():
    return jsonify({"roles": zoho_workdrive.folder_tree()})


@app.patch("/api/items/<item_id>")
def api_rename(item_id):
    body = request.get_json(force=True, silent=True) or {}
    meta, parent_path = zoho_workdrive.item_in_root(item_id)
    _busy_folder(item_id if meta["is_folder"] else meta["parent_id"])
    out = zoho_workdrive.rename_item(item_id, body.get("name") or "")
    if out["is_folder"] and len(parent_path) == 1:  # a role folder: keep its JD's name in step
        storage.rename_role(item_id, out["name"])
    if out["name"] != meta["name"]:
        storage.log("info", f"Renamed {'folder' if out['is_folder'] else 'resume'} '{meta['name']}' -> '{out['name']}'.")
    return jsonify(out)


def _ids(body) -> list[str]:
    ids = body.get("file_ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(x, str) and x.isalnum() for x in ids):
        raise pipeline.PipelineError("Select at least one resume.")
    if len(ids) > 200:
        raise pipeline.PipelineError("Select at most 200 resumes at a time.")
    return list(dict.fromkeys(ids))


@app.post("/api/files/move")
def api_move_files():
    body = request.get_json(force=True, silent=True) or {}
    ids, dest = _ids(body), (body.get("dest_folder_id") or "").strip()
    if not dest:
        return _error("Choose a folder to move to.", 400)
    results = []
    for fid in ids:
        try:
            meta, _ = zoho_workdrive.item_in_root(fid)
            _busy_folder(meta["parent_id"])
            out = zoho_workdrive.move_file(fid, dest, meta=meta)
            pending = storage.get_form_pending(fid)
            if pending and pending["pending_folder_id"] != dest:
                storage.remove_form_pending(fid)  # moved out of Form Pending by hand
            results.append({"id": fid, "name": meta["name"], "ok": True})
            if out["moved"]:
                storage.log("info", f"Moved '{meta['name']}' to '{out['to']}'.")
        except (WorkDriveError, pipeline.PipelineError) as e:
            results.append({"id": fid, "ok": False, "error": str(e)})
    ok = sum(r["ok"] for r in results)
    return jsonify({"results": results, "moved": ok, "failed": len(results) - ok})


@app.post("/api/files/delete")
def api_delete_files():
    body = request.get_json(force=True, silent=True) or {}
    results = []
    for fid in _ids(body):
        try:
            meta, _ = zoho_workdrive.item_in_root(fid)
            if meta["is_folder"]:
                raise WorkDriveError(f"'{meta['name']}' is a folder - delete folders from their own page.")
            _busy_folder(meta["parent_id"])
            zoho_workdrive.trash_item(fid)
            storage.forget_file(fid)
            storage.log("delete", f"Resume '{meta['name']}' moved to WorkDrive trash from the app.")
            results.append({"id": fid, "name": meta["name"], "ok": True})
        except (WorkDriveError, pipeline.PipelineError) as e:
            results.append({"id": fid, "ok": False, "error": str(e)})
    ok = sum(r["ok"] for r in results)
    return jsonify({"results": results, "deleted": ok, "failed": len(results) - ok})


@app.delete("/api/folders/<folder_id>")
def api_delete_folder(folder_id):
    meta, parent_path = zoho_workdrive.item_in_root(folder_id)
    if not meta["is_folder"]:
        return _error("That is a file, not a folder.", 400)
    _busy_folder(folder_id)
    for sub in zoho_workdrive.list_children(folder_id)["folders"]:
        _busy_folder(sub["id"])
    out = zoho_workdrive.trash_item(folder_id)
    storage.log("delete", f"Folder '{' / '.join(p['name'] for p in parent_path[1:] + [meta])}' moved to "
                          "WorkDrive trash from the app.")
    return jsonify({**out, "parent_id": meta["parent_id"]})


# ---------------------------------------------------------------- walk-ins

@app.post("/api/walkins")
def api_add_walkin():
    """HR adds a walk-in: details + resume (PDF/DOCX, or phone photos of a
    printed resume). Filed in ROOT / <role> / Walk-in and scored right away."""
    import os
    import resume_parser

    form = request.form
    role = _role_folder((form.get("role_id") or "").strip())
    name = " ".join((form.get("name") or "").split())
    phone = (form.get("phone") or "").strip()
    email = (form.get("email") or "").strip()
    notes = (form.get("notes") or "").strip()[:3000]
    if not name:
        return _error("Enter the candidate's name.", 400)
    if not phone and not email:
        return _error("Enter a phone number or an email.", 400)
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if not files:
        return _error("Add the resume: a PDF / DOCX file, or photos of the printed resume.", 400)

    exts = [os.path.splitext(f.filename)[1].lower() for f in files]
    safe_name = re.sub(r'[\\/:*?"<>|]+', " ", name).strip()[:80] or "Walk-in"
    if all(e in resume_parser.IMAGE_EXTENSIONS for e in exts):
        if len(files) > 8:
            return _error("Add at most 8 photos (one per page).", 400)
        content = resume_parser.images_to_pdf([f.read() for f in files])
        filename = f"{safe_name} - Walk-in.pdf"
    elif len(files) == 1 and exts[0] in config.SUPPORTED_RESUME_EXTENSIONS:
        content, filename = files[0].read(), f"{safe_name} - Walk-in{exts[0]}"
    else:
        return _error("Upload ONE .pdf / .docx file, or one or more photos (JPG / PNG) - not a mix.", 400)

    folder_id = zoho_workdrive.walkin_folder(role["id"])
    up = zoho_workdrive.upload_resume(folder_id, filename, content)
    storage.add_walkin(file_id=up["id"], role_folder_id=role["id"], role_name=role["name"],
                       name=name, phone=phone, email=email, notes=notes)
    storage.log("info", f"Walk-in '{name}' added for {role['name']} ({up['name']}).")

    run_id, warning = None, None
    try:
        if not config.OPENAI_API_KEY:
            raise pipeline.PipelineError("OPENAI_API_KEY is not set - the walk-in can't be scored.")
        run_id = pipeline.start_run(folder_id, file_ids=[up["id"]])
    except pipeline.PipelineError as e:
        warning = f"Saved, but not scored yet: {e}"
    return jsonify({"file_id": up["id"], "name": up["name"], "folder_id": folder_id,
                    "run_id": run_id, "warning": warning}), 201


# ---------------------------------------------------------------- applicants (Home + Applicants pages)

@app.get("/api/home")
def api_home():
    return jsonify(applicants.home(request.args.get("range") or "7"))


@app.get("/api/applicants")
def api_applicants():
    rows = applicants.all_applicants(include_dismissed=request.args.get("tab") == "dismissed")
    if request.args.get("tab") == "dismissed":
        rows = [a for a in rows if a["dismissed"]]
    role = request.args.get("role") or ""
    if role:
        rows = [a for a in rows if a["role_id"] == role]
    rows = applicants.in_range(rows, request.args.get("range") or "all")
    q = (request.args.get("q") or "").strip().lower()
    if q:
        rows = [a for a in rows if q in a["name"].lower() or q in (a["email"] or "").lower()]
    counts = applicants.counts(rows)
    tab = request.args.get("tab") or "all"
    if tab in applicants.TABS:
        rows = [a for a in rows if a["step"] in applicants.TABS[tab]]
    jds = storage.list_jds()
    roles = sorted({(a["role_id"], a["position"]) for a in applicants.all_applicants()}, key=lambda r: r[1].lower())
    return jsonify({"items": rows, "counts": counts,
                    "roles": [{"id": i, "name": n, "form_url": (jds.get(i) or {}).get("form_url") or "",
                               "has_jd": bool(((jds.get(i) or {}).get("jd_text") or "").strip())} for i, n in roles],
                    "queue": applicants.queue_status(), "sender": mailer.status(),
                    "from": f"{config.EMAIL_FROM_NAME} <{config.EMAIL_ADDRESS}>"})


@app.get("/api/applicants/<file_id>")
def api_applicant(file_id):
    a = applicants.detail(file_id)
    if not a:
        return _error("Applicant not found.", 404)
    return jsonify(a)


@app.post("/api/applicants/send-form")
def api_applicants_send_form():
    body = request.get_json(force=True, silent=True) or {}
    wanted = set(body.get("ids") or [])
    ids = [a["invite_id"] for a in applicants.all_applicants() if a["id"] in wanted and a["invite_id"]]
    if not ids:
        return _error("Select applicants who haven't been sent the form yet.", 400)
    return jsonify(mailer.send_invites(ids))


@app.post("/api/applicants/screen")
def api_applicants_screen():
    body = request.get_json(force=True, silent=True) or {}
    return jsonify(applicants.screen(list(body.get("ids") or [])))


@app.get("/api/applicants/progress")
def api_applicants_progress():
    return jsonify({"queue": applicants.queue_status(), "sender": mailer.status(),
                    "fetch": {k: v for k, v in email_fetcher.status().items() if k != "results"}})


# ---------------------------------------------------------------- Google Form invites

_FORM_URL_RE = re.compile(r"^https://(docs\.google\.com/forms/|forms\.gle/)\S+$")


@app.get("/api/roles/<role_folder_id>/invite")
def api_get_invite_settings(role_folder_id):
    jd = storage.get_jd(role_folder_id) or {}
    return jsonify({"form_url": jd.get("form_url") or "",
                    "invite_subject": jd.get("invite_subject") or "", "invite_body": jd.get("invite_body") or "",
                    "default_subject": config.DEFAULT_INVITE_SUBJECT, "default_body": config.DEFAULT_INVITE_BODY,
                    "from": f"{config.EMAIL_FROM_NAME} <{config.EMAIL_ADDRESS}>"})


@app.put("/api/roles/<role_folder_id>/invite")
def api_save_invite_settings(role_folder_id):
    body = request.get_json(force=True, silent=True) or {}
    role = _role_folder(role_folder_id)
    jd = storage.get_jd(role_folder_id) or {}
    form_url = (body.get("form_url", jd.get("form_url")) or "").strip()
    if form_url and not _FORM_URL_RE.match(form_url):
        return _error("That doesn't look like a Google Form link. Open the form, click Send → the link icon, "
                      "and copy the link (it starts with https://docs.google.com/forms/ or https://forms.gle/).", 400)
    subject = (body.get("invite_subject", jd.get("invite_subject")) or "").strip()
    text = (body.get("invite_body", jd.get("invite_body")) or "").strip()
    # Saving the default text unchanged keeps the row on the default, so a later
    # improvement to the default reaches every position that never customised it.
    if subject == config.DEFAULT_INVITE_SUBJECT:
        subject = ""
    if text == config.DEFAULT_INVITE_BODY.strip():
        text = ""
    if text and "{form_link}" not in text:
        return _error("The email text must contain {form_link} - that's where the form link goes.", 400)
    storage.set_invite_settings(role_folder_id, role["name"], form_url, subject, text)
    role_settings.backup(role_folder_id)
    storage.log("info", f"Google Form invite settings for '{role['name']}' saved"
                        + ("" if form_url else " (no form link - invites can't be sent)") + ".")
    return api_get_invite_settings(role_folder_id)


@app.post("/api/roles/<role_folder_id>/invite/test")
def api_test_invite(role_folder_id):
    role = _role_folder(role_folder_id)
    to = mailer.send_test(role_folder_id, role["name"], storage.get_jd(role_folder_id))
    return jsonify({"sent_to": to})


@app.get("/api/invites")
def api_invites():
    jds = storage.list_jds()
    rows = storage.list_invites()
    roles: dict = {}
    for r in rows:
        role = roles.setdefault(r["role_folder_id"], {
            "id": r["role_folder_id"], "name": r["role_name"],
            "form_url": (jds.get(r["role_folder_id"]) or {}).get("form_url") or "", "items": []})
        role["items"].append(r)
    return jsonify({"roles": sorted(roles.values(), key=lambda x: x["name"].lower()),
                    "sender": mailer.status(), "from": f"{config.EMAIL_FROM_NAME} <{config.EMAIL_ADDRESS}>"})


@app.post("/api/invites/send")
def api_send_invites():
    body = request.get_json(force=True, silent=True) or {}
    try:
        ids = [int(i) for i in body.get("ids") or []]
    except (TypeError, ValueError):
        return _error("ids must be a list of invite ids.", 400)
    if not ids:
        return _error("Select at least one applicant.", 400)
    return jsonify(mailer.send_invites(ids))


@app.get("/api/invites/status")
def api_invites_status():
    return jsonify({**mailer.status(), "ready": storage.invites_ready_count()})


@app.patch("/api/invites/<int:invite_id>")
def api_update_invite(invite_id):
    inv = storage.get_invite(invite_id)
    if not inv:
        return _error("Invite not found.", 404)
    if inv["status"] in ("sending", "sent"):
        return _error("This invite has already gone out.", 400)
    body = request.get_json(force=True, silent=True) or {}
    if "email" in body:
        email = (body.get("email") or "").strip().lower()
        if email and not mailer.valid_email(email):
            return _error(f"'{email}' is not a valid email address.", 400)
        storage.update_invite(invite_id, email=email or None, email_source="manual" if email else None,
                              status="ready" if email else "no_email", error=None)
    if body.get("dismiss") is True:
        storage.update_invite(invite_id, status="dismissed")
    if body.get("restore") is True and inv["status"] == "dismissed":
        storage.update_invite(invite_id, status="ready" if inv["email"] else "no_email")
    return jsonify(storage.get_invite(invite_id))


# ---------------------------------------------------------------- Google Form pending & notifications

@app.get("/api/form-pending")
def api_form_pending():
    rows = storage.list_form_pending(request.args.get("role") or None)
    jds = storage.list_jds()
    roles: dict = {}
    for r in rows:
        role = roles.setdefault(r["role_folder_id"], {
            "id": r["role_folder_id"], "name": r["role_name"], "pending_folder_id": r["pending_folder_id"],
            "has_sheet": bool((jds.get(r["role_folder_id"]) or {}).get("form_sheet_url")),
            "items": []})
        role["items"].append(r)
    return jsonify({"roles": sorted(roles.values(), key=lambda x: x["name"].lower()),
                    "watcher": form_watch.status()})


@app.post("/api/form-pending/check")
def api_form_pending_check():
    return jsonify(form_watch.check_all())


@app.get("/api/notifications")
def api_notifications():
    return jsonify(storage.form_notifications())


@app.post("/api/notifications/seen")
def api_notifications_seen():
    storage.mark_notifications_seen()
    return jsonify({"ok": True})


@app.get("/api/events")
def api_events():
    return jsonify({"events": storage.events(limit=int(request.args.get("limit", 300)))})


if __name__ == "__main__":
    # Render binds to a dynamic port and expects the server to listen on 0.0.0.0,
    # not localhost/127.0.0.1.
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0").lower() in {"1", "true", "yes", "on"}
    # use_reloader=False: the reloader runs the app twice, and a restart would
    # kill an in-progress screening run mid-way.
    ensure_started()
    app.run(host=host, debug=debug, port=port, use_reloader=False, threaded=True)
