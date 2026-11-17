"""
One record per applicant, from Gmail fetch (or walk-in) to Zoho Recruit.

The data already lives in separate tables, all keyed by the resume's WorkDrive
file id: form_invites (fetched from Gmail, Google Form sent / filled), walkins,
form_pending and screenings. This module joins them into the single list the
Applicants page and Home dashboard show, and works out each person's step:

  new            fetched, Google Form not sent yet (no_email: no address found)
  sent           Google Form sent, no response yet
  filled         response found in the position's sheet - ready to screen
  screening      a screening run is working on it right now
  qualified      screened High / Medium (in Zoho Recruit; walk-ins stay in the app)
  not_qualified  screened Low
  error          screening failed - can be screened again

Screening stays manual: screen() queues the chosen applicants and runs them
one WorkDrive folder at a time (runs work per folder, and one run at a time
keeps a 512 MB instance from running out of memory).
"""
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone

import config
import forksafe
import pipeline
import storage

STEP_LABELS = {
    "new": "New", "no_email": "No email", "queued": "Form queued", "sent": "Form sent", "filled": "Form filled",
    "screening": "Screening…", "qualified": "Qualified", "not_qualified": "Not qualified", "error": "Screening failed",
}
TABS = {  # tab -> steps it shows
    "new": ("new", "no_email"), "sent": ("queued", "sent"), "filled": ("filled", "screening", "error"),
    "qualified": ("qualified",), "not_qualified": ("not_qualified",),
}


def _parse(ts: str | None):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _from_screening(a: dict, s: dict | None) -> None:
    """Fills step/score from the latest screening, when it decides the step."""
    if not s:
        return
    a.update(screening_id=s["id"], score=s.get("overall_score"), screened_at=s.get("updated_at"),
             recruit_status=s.get("recruit_status"), recruit_record_id=s.get("recruit_record_id"))
    a["band"] = config.band(a["score"]) if a["score"] is not None else ""
    if s.get("stage") != "done":
        a["step"] = "screening"
    elif s.get("outcome") == "passed":
        a["step"] = "qualified"
    elif s.get("outcome") == "rejected":
        a["step"] = "not_qualified"
    elif s.get("outcome") == "walkin":
        a["step"] = "qualified" if (a["score"] or 0) >= config.BAND_MEDIUM else "not_qualified"
    elif s.get("outcome") == "failed":
        a["step"] = "error"
        a["error"] = s.get("error")
    # outcome form_pending: screened before the form arrived -> step stays as the invite says


def all_applicants(include_dismissed: bool = False) -> list[dict]:
    invites = storage.list_invites()
    walkins = storage.list_walkins()
    pending = storage.form_pending_by_file()
    ids = [i["file_id"] for i in invites if i["file_id"]] + [w["file_id"] for w in walkins]
    screened = storage.latest_screening_by_file(ids)
    out: list[dict] = []

    for i in invites:
        if i["status"] == "dismissed" and not include_dismissed:
            continue
        a = {"id": i["file_id"], "invite_id": i["id"], "source": i.get("source") or "gmail", "name": i["candidate"],
             "email": i["email"] or "", "email_source": i["email_source"] or "", "other_emails": i["other_emails"],
             "position": i["role_name"], "role_id": i["role_folder_id"], "file_name": i["file_name"],
             "folder_id": i.get("folder_id"), "applied_at": i["applied_at"] or i["created_at"],
             "sent_at": i["sent_at"], "form_filled_at": i.get("form_filled_at"), "invite_status": i["status"],
             "error": i["error"] if i["status"] == "failed" else None,
             "score": None, "band": "", "screening_id": None, "screened_at": None, "recruit_status": None,
             "recruit_record_id": None, "dismissed": i["status"] == "dismissed"}
        p = pending.get(i["file_id"])
        if p:  # screened without the form earlier: the resume now waits in Form Pending
            a["folder_id"] = p["pending_folder_id"]
            if p.get("filled_at") and not a["form_filled_at"]:
                a["form_filled_at"] = p["filled_at"]
        if a["form_filled_at"]:
            a["step"] = "filled"
        elif i["status"] in ("sent", "already_sent"):
            a["step"] = "sent"
        elif i["status"] == "queued":
            a["step"] = "queued"
        elif i["status"] == "no_email" or not a["email"]:
            a["step"] = "no_email"
        else:
            a["step"] = "new"
        _from_screening(a, screened.get(i["file_id"]))
        out.append(a)

    for w in walkins:
        a = {"id": w["file_id"], "invite_id": None, "source": "walkin", "name": w["name"], "email": w["email"] or "",
             "email_source": "walk-in", "other_emails": [], "position": w["role_name"], "role_id": w["role_folder_id"],
             "file_name": "", "folder_id": None, "applied_at": w["added_at"], "sent_at": None, "form_filled_at": None,
             "invite_status": None, "error": None, "score": None, "band": "", "screening_id": None,
             "screened_at": None, "recruit_status": None, "recruit_record_id": None, "dismissed": False,
             "step": "screening"}
        _from_screening(a, screened.get(w["file_id"]))
        out.append(a)

    for a in out:
        a["step_label"] = STEP_LABELS.get(a["step"], a["step"])
    out.sort(key=lambda a: a["applied_at"] or "", reverse=True)
    return out


def _since(range_key: str):
    now = datetime.now(timezone.utc)
    return {"7": now - timedelta(days=7), "30": now - timedelta(days=30),
            "today": now.replace(hour=0, minute=0, second=0, microsecond=0)}.get(range_key)


def in_range(rows: list[dict], range_key: str) -> list[dict]:
    since = _since(range_key)
    if not since:
        return rows
    return [a for a in rows if (_parse(a["applied_at"]) or since) >= since]


def counts(rows: list[dict]) -> dict:
    by_tab = {tab: sum(1 for a in rows if a["step"] in steps) for tab, steps in TABS.items()}
    return {"all": len(rows), **by_tab}


def home(range_key: str = "7") -> dict:
    everyone = all_applicants()
    rows = in_range(everyone, range_key)
    gmail = [a for a in rows if a["source"] != "walkin"]   # Gmail + uploaded: both go through the form
    screened = [a for a in rows if a["step"] in ("qualified", "not_qualified")]
    qualified = [a for a in gmail if a["step"] == "qualified"]   # High/Medium split of the funnel's Qualified
    funnel = {
        "applied": len(gmail),
        "form_sent": sum(1 for a in gmail if a["step"] not in ("new", "no_email", "queued")),
        "form_filled": sum(1 for a in gmail if a["form_filled_at"] or a["step"] in ("qualified", "not_qualified")),
        "screened": sum(1 for a in gmail if a["step"] in ("qualified", "not_qualified")),
        "qualified": sum(1 for a in gmail if a["step"] == "qualified"),
        "high": sum(1 for a in qualified if a["band"] == "High"),
        "medium": sum(1 for a in qualified if a["band"] == "Medium"),
        "not_qualified": sum(1 for a in rows if a["step"] == "not_qualified"),
        "walkins": sum(1 for a in rows if a["source"] == "walkin"),
        "in_recruit": sum(1 for a in rows if a["recruit_status"] == "saved"),
    }
    # Where the resumes came from, and how far each source got.
    sources = {}
    for key in ("gmail", "upload", "walkin"):
        group = [a for a in rows if a["source"] == key]
        sources[key] = {
            "received": len(group),
            "form_sent": sum(1 for a in group if a["step"] not in ("new", "no_email", "queued") and key != "walkin"),
            "qualified": sum(1 for a in group if a["step"] == "qualified"),
            "in_recruit": sum(1 for a in group if a["recruit_status"] == "saved"),
        }
    # To-do counts are about now, whatever the date range.
    jds = storage.list_jds()
    todo = {
        "send": sum(1 for a in everyone if a["step"] == "new"),
        "no_email": sum(1 for a in everyone if a["step"] == "no_email"),
        "send_blocked": sum(1 for a in everyone if a["step"] == "new"
                            and not ((jds.get(a["role_id"]) or {}).get("form_url"))),
        "screen": sum(1 for a in everyone if a["step"] in ("filled", "error")),
        "screening": sum(1 for a in everyone if a["step"] == "screening"),
        "waiting": sum(1 for a in everyone if a["step"] == "sent"),
    }
    positions: dict = {}
    for a in rows:
        p = positions.setdefault(a["role_id"], {"id": a["role_id"], "name": a["position"], "applied": 0,
                                                "gmail": 0, "upload": 0, "walkin": 0, "form_sent": 0,
                                                "filled": 0, "screened": 0, "qualified": 0, "in_recruit": 0,
                                                "send": 0, "screen": 0})
        p["applied"] += 1
        p[a["source"] if a["source"] in ("gmail", "upload", "walkin") else "gmail"] += 1
        p["form_sent"] += 1 if a["source"] != "walkin" and a["step"] not in ("new", "no_email", "queued") else 0
        p["in_recruit"] += 1 if a["recruit_status"] == "saved" else 0
        p["filled"] += 1 if (a["form_filled_at"] or a["step"] in ("qualified", "not_qualified")) else 0
        p["screened"] += 1 if a["step"] in ("qualified", "not_qualified") else 0
        p["qualified"] += 1 if a["step"] == "qualified" else 0
    for a in everyone:  # next-step counts are current, like the to-do cards
        if a["role_id"] in positions:
            positions[a["role_id"]]["send"] += 1 if a["step"] == "new" else 0
            positions[a["role_id"]]["screen"] += 1 if a["step"] in ("filled", "error") else 0
    for p in positions.values():
        p["rate"] = round(100 * p["qualified"] / p["screened"]) if p["screened"] else None
        jd = jds.get(p["id"]) or {}
        p["setup_missing"] = [k for k, ok in (("job description", (jd.get("jd_text") or "").strip()),
                                              ("Google Form", jd.get("form_url")),
                                              ("response sheet", jd.get("form_sheet_url"))) if not ok]
    return {"range": range_key, "funnel": funnel, "todo": todo, "sources": sources,
            "positions": sorted(positions.values(), key=lambda p: -p["applied"]),
            "queue": queue_status()}


def detail(file_id: str) -> dict | None:
    a = next((x for x in all_applicants(include_dismissed=True) if x["id"] == file_id), None)
    if not a:
        return None
    if a["invite_id"]:
        a["form"] = (storage.get_invite(a["invite_id"]) or {}).get("form")
    if a["screening_id"]:
        a["screening"] = storage.get_screening(a["screening_id"])
    if a["source"] == "walkin":
        a["walkin"] = storage.get_walkin(file_id)
    return a


# ---------------------------------------------------------------- manual screening queue

_queue_lock = threading.Lock()
_queue: list[dict] = []          # [{"folder_id", "file_ids", "role"}]
_q_state = {"running": False, "current_run": None, "done_runs": [], "error": None, "total": 0}


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _queue_lock
    _queue_lock = threading.Lock()
    _queue.clear()
    _q_state.update(running=False, current_run=None)


def queue_status() -> dict:
    return {**_q_state, "waiting_batches": len(_queue), "done_runs": list(_q_state["done_runs"])}


def screen(file_ids: list[str]) -> dict:
    """Queues the chosen applicants. Only those whose form is filled (or whose
    last screening failed) and that aren't already queued/being screened."""
    rows = {a["id"]: a for a in all_applicants()}
    chosen = [rows[f] for f in dict.fromkeys(file_ids) if f in rows and rows[f]["step"] in ("filled", "error")]
    if not chosen:
        raise pipeline.PipelineError("Nothing to screen: pick applicants whose Google Form is filled.")
    missing_folder = [a["name"] for a in chosen if not a["folder_id"]]
    if missing_folder:
        raise pipeline.PipelineError("Can't find the resume folder for: " + ", ".join(missing_folder[:5]))
    no_jd = sorted({a["position"] for a in chosen
                    if not ((storage.get_jd(a["role_id"]) or {}).get("jd_text") or "").strip()})
    if no_jd:
        raise pipeline.PipelineError("Add a job description first for: " + ", ".join(no_jd))
    with _queue_lock:
        queued = {f for b in _queue for f in b["file_ids"]}
        batches: dict = {}
        for a in chosen:
            if a["id"] not in queued:
                batches.setdefault(a["folder_id"], {"folder_id": a["folder_id"], "file_ids": [], "role": a["position"]})
                batches[a["folder_id"]]["file_ids"].append(a["id"])
        _queue.extend(batches.values())
        _q_state["total"] += sum(len(b["file_ids"]) for b in batches.values())
        start = not _q_state["running"]
        if start:
            _q_state.update(running=True, error=None, done_runs=[])
    if start:
        threading.Thread(target=_drain, daemon=True, name="screen-queue").start()
    return {"queued": sum(len(b["file_ids"]) for b in batches.values()), **queue_status()}


def _drain() -> None:
    try:
        while True:
            with _queue_lock:
                if not _queue:
                    _q_state.update(running=False, current_run=None, total=0)
                    return
                batch = _queue.pop(0)
            try:
                run_id = pipeline.start_run(batch["folder_id"], file_ids=batch["file_ids"])
            except pipeline.PipelineError as e:
                # e.g. an email fetch is running: wait and try this batch again.
                if "being fetched" in str(e):
                    with _queue_lock:
                        _queue.insert(0, batch)
                    time.sleep(15)
                    continue
                _q_state["error"] = str(e)
                storage.log("warn", f"Screening {batch['role']} ({len(batch['file_ids'])}) not started: {e}")
                continue
            _q_state["current_run"] = run_id
            while (storage.get_run(run_id) or {}).get("status") in ("running", "cancelling"):
                time.sleep(3)
            _q_state["done_runs"].append(run_id)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _q_state.update(running=False, error=f"Unexpected: {e}")
