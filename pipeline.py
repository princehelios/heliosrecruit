"""
Screening pipeline for one WorkDrive folder, run in a background thread.

Per resume:
  download -> extract text + hyperlinks -> compact text
    role has a Google Form sheet?
      find the resume's email/phone in the sheet (regex, no AI)
        no response yet -> move to ROOT / <role> / Form Pending, no AI call
        response found  -> its answers are scored together with the resume
    identical file + answers already analysed under the same JD -> reuse it (0 tokens)
    else one AI call: basic information + scores -> band
      Low (<50)          : rejected -> file stays in WorkDrive
      High / Medium (50+): passed   -> upsert to Recruit
                                    -> attach resume -> VERIFY in Recruit
                                    -> guarded permanent delete from WorkDrive

The WorkDrive delete happens only after Recruit is confirmed to hold the
resume. Any failure along the way leaves the file in WorkDrive and records
exactly why in the audit log.
"""
import hashlib
import os
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import ai_scorer
import config
import forksafe
import email_fetcher
import google_sheets
import recruit_mapping
import resume_parser
import storage
import zoho_recruit
import zoho_workdrive
from google_sheets import SheetError
from zoho_recruit import RecruitError
from zoho_workdrive import WorkDriveError

# Resumes scored at once. Each worker holds a downloaded PDF plus its extracted
# text in memory and waits mostly on OpenAI, so 3 is a good balance; drop it to
# 2 if a 512 MB instance starts getting OOM-killed mid-run.
MAX_PARALLEL_RESUMES = max(1, int(os.getenv("MAX_PARALLEL_RESUMES", "3")))

_start_lock = threading.Lock()


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _start_lock
    _start_lock = threading.Lock()


class PipelineError(Exception):
    pass


def start_run(folder_id: str, rescreen: bool = False, file_ids: list[str] | None = None) -> int:
    """Validates the folder and JD, creates the run, and starts it in the
    background. Returns run_id. Raises PipelineError for user-fixable issues."""
    path = zoho_workdrive.resolve_path(folder_id)
    if len(path) < 2:
        raise PipelineError("Open a role folder (e.g. Full Stack) or one of its date folders to screen resumes.")
    role = path[1]
    folder_path = " / ".join(p["name"] for p in path)

    jd = storage.get_jd(role["id"])
    if not jd or not jd["jd_text"].strip():
        raise PipelineError(f"No job description saved for '{role['name']}'. Add one before screening.")

    # Chrome (email fetch) and a screening run together can exceed a small
    # server's memory and get it killed, taking both jobs down.
    if email_fetcher.status().get("running"):
        raise PipelineError("Resumes are being fetched from email right now. Start screening when the fetch finishes.")

    with _start_lock:
        active = storage.active_run_for_folder(folder_id)
        if active:
            raise PipelineError(f"A screening run (#{active['id']}) is already in progress for this folder.")
        run_id = storage.create_run(
            folder_id, folder_path, role["id"], role["name"], jd["jd_text"], config.BAND_MEDIUM
        )

    scope = f"{len(file_ids)} selected resume(s)" if file_ids else ("all resumes, re-screening" if rescreen else "all resumes")
    form = "resume + Google Form answers" if (jd.get("form_sheet_url") or "").strip() else "resume only (no form sheet linked)"
    storage.log("info", f"Run started on '{folder_path}' for {scope}; scoring {form}. High/Medium "
                        f"({config.BAND_MEDIUM}+) go to Recruit, Low stays.", run_id)
    thread = threading.Thread(target=_run, args=(run_id, folder_id, rescreen, file_ids), daemon=True, name=f"run-{run_id}")
    thread.start()
    return run_id


def _human_duration(started: float) -> str:
    seconds = time.monotonic() - started
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m {int(seconds % 60):02d}s"


def _run(run_id: int, folder_id: str, rescreen: bool, file_ids: list[str] | None = None) -> None:
    run = storage.get_run(run_id)
    run_started = time.monotonic()
    try:
        parts = run["folder_path"].split(" / ")
        run["walkin"] = len(parts) == 3 and parts[-1].strip().lower() == config.WALKIN_FOLDER.lower()
        jd = storage.get_jd(run["role_folder_id"]) or {}
        sheet_url = (jd.get("form_sheet_url") or "").strip()
        if run["walkin"]:
            # Walk-ins don't fill the Google Form, so the sheet isn't even read.
            storage.log("info", "Walk-in folder: scored on resume + HR notes, kept in the app only "
                                "(not sent to Recruit, nothing deleted).", run_id)
        elif sheet_url:
            try:
                run["form_sheet"] = google_sheets.load(sheet_url, fresh=True)
            except SheetError as e:
                raise PipelineError(f"Couldn't read the Google Form response sheet: {e}")
            storage.log("info", f"Google Form sheet loaded: {len(run['form_sheet']['rows'])} response(s).", run_id)
        run["pending_folder"] = {}  # lazily created Form Pending folder id
        run["pending_lock"] = threading.Lock()
        files = zoho_workdrive.list_children(folder_id)["files"]
        if file_ids:
            # Only ids that are really resumes in THIS folder - anything else is ignored.
            wanted = set(file_ids)
            unknown = wanted - {f["id"] for f in files}
            if unknown:
                storage.log("warn", f"{len(unknown)} selected file(s) are no longer in this folder and were skipped.", run_id)
            files = [f for f in files if f["id"] in wanted]
        else:
            files = _skip_already_screened(run, files, rescreen)
        storage.update_run(run_id, total=len(files))
        if not files:
            storage.log("info", "No resumes to screen in this folder.", run_id)

        jobs = [(storage.create_screening(run_id, f["id"], f["name"], folder_id, f.get("added")), f) for f in files]
        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_RESUMES) as pool:
            for (sid, f) in jobs:
                pool.submit(_safe_process, run, sid, f)

        final = storage.get_run(run_id)
        status = "cancelled" if final["status"] == "cancelling" else "completed"
        storage.update_run(run_id, status=status, finished_at=storage.now())
        if status == "cancelled":
            storage.log("warn", f"Run stopped in {_human_duration(run_started)}.", run_id)
            return
        storage.log("info", f"Run finished in {_human_duration(run_started)}: {final['passed']} High/Medium, "
                            f"{final['rejected']} Low, {final.get('form_pending') or 0} waiting for the Google Form, "
                            f"{final['failed']} failed, {final['deleted']} deleted from WorkDrive.", run_id)
    except Exception as e:
        traceback.print_exc()
        if storage.get_run(run_id)["status"] == "cancelling":
            storage.update_run(run_id, status="cancelled", finished_at=storage.now())
            storage.log("warn", f"Run stopped in {_human_duration(run_started)}.", run_id)
        else:
            storage.update_run(run_id, status="failed", error=str(e), finished_at=storage.now())
            storage.log("error", f"Run aborted: {e}", run_id)


def _skip_already_screened(run: dict, files: list, rescreen: bool) -> list:
    """Rejected resumes stay in WorkDrive by design, so every later run would
    re-score (and re-bill) them. Skip ones already rejected under the SAME JD
    and threshold unless a rescreen is requested. Failed and passed-but-kept
    files are always retried - both steps are idempotent."""
    if rescreen or not files:
        return files
    latest = storage.latest_screening_by_file([f["id"] for f in files])
    keep, skipped = [], []
    for f in files:
        prev = latest.get(f["id"])
        if prev and prev["outcome"] == "rejected":
            prev_run = storage.get_run(prev["run_id"])
            if (prev_run and prev_run["jd_snapshot"] == run["jd_snapshot"]
                    and prev_run["pass_threshold"] == run["pass_threshold"]):
                skipped.append(f["name"])
                continue
        keep.append(f)
    if skipped:
        storage.log("info", f"Skipped {len(skipped)} resume(s) already rejected under this JD: "
                            f"{', '.join(skipped)}. Use 'Re-screen all' to score them again.", run["id"])
    return keep


def _safe_process(run: dict, sid: int, f: dict) -> None:
    started = time.monotonic()
    try:
        if storage.get_run(run["id"])["status"] == "cancelling":
            storage.update_screening(sid, stage="done", outcome="failed", error="Cancelled by user.")
            storage.bump_run(run["id"], processed=1, failed=1)
            return
        _process(run, sid, f)
    except Exception as e:
        traceback.print_exc()
        storage.update_screening(sid, stage="done", outcome="failed", error=f"Unexpected error: {e}")
        storage.bump_run(run["id"], processed=1, failed=1)
        storage.log("error", f"{f['name']}: unexpected error: {e}", run["id"], sid)
    finally:
        storage.update_screening(sid, duration_ms=round((time.monotonic() - started) * 1000))


def _fail(run: dict, sid: int, name: str, message: str) -> None:
    storage.update_screening(sid, stage="done", outcome="failed", error=message,
                             workdrive_action="kept", workdrive_reason="not screened successfully")
    storage.bump_run(run["id"], processed=1, failed=1)
    storage.log("error", f"{name}: {message}", run["id"], sid)


def _process(run: dict, sid: int, f: dict) -> None:
    run_id, name = run["id"], f["name"]
    started = time.monotonic()

    # 1. download
    storage.update_screening(sid, stage="downloading")
    try:
        data = zoho_workdrive.download_file(f["id"])
    except WorkDriveError as e:
        return _fail(run, sid, name, str(e))
    size = len(data)
    storage.update_screening(sid, file_size=size)
    if f.get("size") is not None and int(f["size"]) != size:
        return _fail(run, sid, name, f"Downloaded {size} bytes but WorkDrive lists {f['size']} - file may be changing.")

    # 2. extract
    try:
        parsed = resume_parser.extract(data, name)
    except Exception as e:
        return _fail(run, sid, name, f"Could not read file: {e}")
    ocr_usage = None
    if not parsed["text"].strip():
        # Scanned PDF or photographed printout: read the page images with AI.
        if not name.lower().endswith(".pdf"):
            return _fail(run, sid, name, "No text could be extracted from this file.")
        try:
            pages = resume_parser.render_pdf_pages(data, config.OCR_MAX_PAGES)
            parsed["text"], ocr_usage = ai_scorer.ocr_images(pages)
        except Exception as e:
            return _fail(run, sid, name, f"Scanned resume - reading it with AI OCR failed: {e}")
        if not parsed["text"].strip():
            return _fail(run, sid, name, "Scanned resume - no readable text found even with AI OCR.")
        storage.log("info", f"{name}: scanned/photo resume read with AI OCR ({len(pages)} page(s)).", run_id, sid)
    walkin = storage.get_walkin(f["id"]) if run.get("walkin") else None
    if walkin:
        details = "\n".join(x for x in (
            f"Name: {walkin['name']}", walkin.get("phone") and f"Phone: {walkin['phone']}",
            walkin.get("email") and f"Email: {walkin['email']}") if x)
        parsed["text"] += f"\n\n--- WALK-IN CANDIDATE, details entered by HR ---\n{details}"
        if walkin.get("notes"):
            parsed["text"] += f"\n--- NOTES FROM HR (walk-in interview) ---\n{walkin['notes']}"
    resume_text = ai_scorer.compact_resume_text(resume_parser.build_ai_input(parsed))

    # 2b. Google Form: match the resume to a response before spending tokens
    form_text = ""
    if run.get("form_sheet"):
        contacts = resume_parser.find_contacts(parsed)
        if not contacts["emails"] and not contacts["phones"]:
            return _fail(run, sid, name, "No email or phone number found on the resume, so it can't be matched "
                                         "to a Google Form response.")
        response = google_sheets.find_response(run["form_sheet"], contacts["emails"], contacts["phones"])
        if not response:
            return _to_form_pending(run, sid, f, contacts, size)
        form_text = google_sheets.answers_text(response)
        storage.update_screening(sid, form_json=response)
        storage.log("info", f"{name}: Google Form response found (matched by {response['matched_by']}, "
                            f"{len(response['answers'])} answers).", run_id, sid)

    # Reuse key covers the file AND the form answers / HR notes it was scored with.
    extra = form_text + (f"|walkin:{walkin.get('notes') or ''}|{walkin.get('name')}" if walkin else "")
    content_hash = hashlib.sha256(data + extra.encode("utf-8")).hexdigest()
    storage.update_screening(sid, content_hash=content_hash)

    # 3. AI: reuse identical file+JD, else one screening call
    storage.update_screening(sid, stage="scoring")
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
    previous = storage.find_reusable_analysis(content_hash, run["jd_snapshot"], ai_scorer.EXTRACTION_VERSION)
    if previous:
        result = previous["ai_json"]
        storage.update_screening(sid, reused=1)
        storage.log("info", f"{name}: identical file already analysed for this JD (screening "
                            f"#{previous['id']}) - reused, 0 tokens.", run_id, sid)
    else:
        try:
            result, usage = ai_scorer.screen_resume(
                resume_text, run["jd_snapshot"], run["role_name"], _picklist_options(), form_answers=form_text)
        except Exception as e:
            return _fail(run, sid, name, f"AI scoring failed: {e}")
    result["_source"] = {"filename": name, "file_id": f["id"], "bytes": size, "links_found": parsed["links"]}

    ev = result["evaluation"]
    overall = ev["overall_score"]
    ev["band"] = config.band(overall)
    passed = overall >= run["pass_threshold"]
    if ocr_usage:
        usage = {k: usage.get(k, 0) + ocr_usage.get(k, 0) for k in ("prompt_tokens", "completion_tokens", "cached_tokens")}
    _save_analysis(sid, result, usage)
    if walkin:
        if not ai_scorer.full_name(result):
            storage.update_screening(sid, candidate_name=walkin["name"])
        if walkin.get("email"):
            storage.update_screening(sid, email=walkin["email"])
    if storage.get_run(run_id)["status"] == "cancelling":
        storage.update_screening(sid, stage="done", outcome="failed", error="Cancelled by user.")
        storage.bump_run(run_id, processed=1, failed=1)
        return
    storage.log("info", f"{name}: {ev['band']} ({overall}, {ev['recommendation']}"
                        f"{', resume + form' if form_text else ''}) -> "
                        f"{'to Recruit' if passed else 'stays in WorkDrive'} "
                        f"in {time.monotonic() - started:.1f}s.", run_id, sid)

    if run.get("walkin"):
        storage.update_screening(sid, stage="done", outcome="walkin", workdrive_action="kept",
                                 workdrive_reason=f"Walk-in ({ev['band']}) - kept in the app only, not sent to Recruit")
        storage.bump_run(run_id, processed=1)
        storage.log("info", f"{name}: walk-in scored {ev['band']} ({overall}) - kept in the app.", run_id, sid)
        return

    if not passed:
        storage.update_screening(sid, stage="done", outcome="rejected", workdrive_action="kept",
                                 workdrive_reason=f"Low band (score {overall}, below {run['pass_threshold']})")
        storage.bump_run(run_id, processed=1, rejected=1)
        _leave_pending(run, sid, f, move_back=True)
        return

    storage.bump_run(run_id, passed=1)

    # 4. Recruit: upsert + attach + verify
    storage.update_screening(sid, stage="pushing", outcome="passed")
    record_id = _push_to_recruit(run, sid, name, result, data)
    if not record_id:
        storage.update_screening(sid, stage="done", workdrive_action="kept",
                                 workdrive_reason="Recruit push not confirmed - file kept")
        storage.bump_run(run_id, processed=1)
        return

    # 5. guarded delete
    if not config.WORKDRIVE_DELETE_ENABLED:
        storage.update_screening(sid, stage="done", workdrive_action="kept",
                                 workdrive_reason="automatic delete is switched off (WORKDRIVE_DELETE_ENABLED)")
        storage.log("warn", f"{name}: kept in WorkDrive - automatic delete is switched off.", run_id, sid)
        storage.bump_run(run_id, processed=1)
        _leave_pending(run, sid, f, move_back=True)
        return

    storage.update_screening(sid, stage="deleting")
    try:
        zoho_workdrive.delete_permanently(
            f["id"], expected_folder_id=run["folder_id"], expected_name=name, expected_size=size,
        )
    except WorkDriveError as e:
        blocked = str(e).startswith("Delete blocked")
        storage.update_screening(sid, stage="done",
                                 workdrive_action="delete_blocked" if blocked else "delete_failed",
                                 workdrive_reason=str(e))
        storage.log("warn" if blocked else "error", f"{name}: NOT deleted from WorkDrive - {e}", run_id, sid)
        storage.bump_run(run_id, processed=1)
        return

    storage.update_screening(sid, stage="done", workdrive_action="deleted",
                             workdrive_reason=f"verified in Recruit record {record_id}, then permanently deleted")
    storage.remove_form_pending(f["id"])
    storage.log("delete", f"{name} ({size} bytes, file id {f['id']}) permanently deleted from "
                          f"'{run['folder_path']}' after verification in Recruit record {record_id}.", run_id, sid)
    storage.bump_run(run_id, processed=1, deleted=1)


def _pending_folder_id(run: dict) -> str:
    with run["pending_lock"]:
        if "id" not in run["pending_folder"]:
            run["pending_folder"]["id"] = zoho_workdrive.form_pending_folder(run["role_folder_id"])
        return run["pending_folder"]["id"]


def _to_form_pending(run: dict, sid: int, f: dict, contacts: dict, size: int) -> None:
    """No Google Form response yet: park the resume in ROOT / <role> / Form
    Pending and remember its email/phone so the watcher can spot the response."""
    run_id, name = run["id"], f["name"]
    who = ", ".join(contacts["emails"][:2] + contacts["phones"][:1])
    try:
        pending_id = _pending_folder_id(run)
        if run["folder_id"] != pending_id:
            zoho_workdrive.move_file(f["id"], pending_id)
            where = f"moved to '{run['role_name']} / {config.FORM_PENDING_FOLDER}'"
            action = "moved_pending"
        else:
            where, action = f"still in '{config.FORM_PENDING_FOLDER}'", "kept"
    except WorkDriveError as e:
        pending_id, where, action = run["folder_id"], f"could not be moved ({e}), left where it is", "kept"
        storage.log("warn", f"{name}: {where}", run_id, sid)
    storage.add_form_pending(
        file_id=f["id"], filename=name, role_folder_id=run["role_folder_id"], role_name=run["role_name"],
        pending_folder_id=pending_id, from_folder_id=run["folder_id"], from_folder_path=run["folder_path"],
        emails=contacts["emails"], phones=contacts["phones"])
    storage.update_screening(sid, stage="done", outcome="form_pending", email=(contacts["emails"] or [""])[0],
                             workdrive_action=action,
                             workdrive_reason=f"Google Form not filled yet ({who}) - {where}")
    storage.bump_run(run_id, processed=1, form_pending=1)
    storage.log("info", f"{name}: no Google Form response for {who} yet - {where}. Not scored.", run_id, sid)


def _leave_pending(run: dict, sid: int, f: dict, *, move_back: bool) -> None:
    """A pending resume got its final result. Clear the pending entry and, when
    the file stays in WorkDrive, move it out of Form Pending to where it came from."""
    pending = storage.get_form_pending(f["id"])
    if not pending:
        return
    storage.remove_form_pending(f["id"])
    back_to = pending.get("from_folder_id")
    if not (move_back and back_to and run["folder_id"] == pending["pending_folder_id"] and back_to != run["folder_id"]):
        return
    try:
        zoho_workdrive.move_file(f["id"], back_to)
        storage.log("info", f"{f['name']}: moved out of '{config.FORM_PENDING_FOLDER}' back to "
                            f"'{pending.get('from_folder_path') or back_to}'.", run["id"], sid)
    except WorkDriveError as e:
        storage.log("warn", f"{f['name']}: stays in '{config.FORM_PENDING_FOLDER}' - couldn't move it back: {e}",
                    run["id"], sid)


def _push_to_recruit(run: dict, sid: int, name: str, result: dict, data: bytes):
    """Returns the Recruit record id once the candidate AND the resume
    attachment are confirmed by reading them back, else None."""
    run_id = run["id"]
    try:
        payload = recruit_mapping.build_candidate_payload(
            result, role_name=run["role_name"], folder_path=run["folder_path"])
        outcome = zoho_recruit.upsert_candidate(payload)
        record_id = outcome["record_id"]
        storage.update_screening(sid, recruit_record_id=record_id, recruit_action=outcome["action"],
                                 dropped_fields=outcome["dropped"])
        storage.log("info", f"{name}: Recruit candidate {record_id} ({outcome['action']}), "
                            f"{len(payload) - len(outcome['dropped'])} fields sent.", run_id, sid)
        if outcome["dropped"]:
            detail = "; ".join(f"{d['field']}: {d['reason']}" for d in outcome["dropped"])
            storage.log("warn", f"{name}: {len(outcome['dropped'])} field(s) not saved - {detail}", run_id, sid)

        # AI score + summary as a note: visible on the candidate even while the
        # score fields don't exist in Recruit. Never blocks the push.
        try:
            note = zoho_recruit.upsert_note(record_id, recruit_mapping.AI_NOTE_TITLE, recruit_mapping.ai_note_content(
                result, role_name=run["role_name"], pass_threshold=run["pass_threshold"], filename=name))
            storage.log("info", f"{name}: AI score and summary note {note} in Recruit.", run_id, sid)
        except RecruitError as e:
            storage.log("warn", f"{name}: {e}", run_id, sid)

        attach = zoho_recruit.attach_resume(record_id, data, name)
        storage.log("info", f"{name}: resume " + (
            f"attached (category {attach['category']})." if attach["uploaded"] else "already attached, not re-uploaded."
        ), run_id, sid)

        if not zoho_recruit.find_matching_attachment(record_id, name, len(data)):
            raise RecruitError("Attachment could not be verified in Recruit after upload.")
        saved = zoho_recruit.get_candidate(record_id)
        expected_email = (payload.get(config.RECRUIT_DUPLICATE_FIELD) or "").strip().lower()
        actual_email = str(saved.get(config.RECRUIT_DUPLICATE_FIELD) or "").strip().lower()
        if expected_email != actual_email:
            raise RecruitError(f"Read-back mismatch: record {record_id} has "
                               f"{config.RECRUIT_DUPLICATE_FIELD} '{actual_email}', expected '{expected_email}'.")

        # Recruit silently ignores api_names that don't exist on the module
        # (no error), so detect them from the read-back instead.
        rejected = {d["field"] for d in outcome["dropped"]}
        ignored = sorted(k for k in payload if k not in saved and k not in rejected)
        if ignored:
            all_dropped = outcome["dropped"] + [
                {"field": k, "reason": "field does not exist in Recruit Candidates (ignored)"} for k in ignored
            ]
            storage.update_screening(sid, dropped_fields=all_dropped)
            storage.log("warn", f"{name}: Recruit has no field for {', '.join(ignored)} - "
                                "create these in Recruit to store them.", run_id, sid)
    except RecruitError as e:
        storage.update_screening(sid, recruit_status="failed", recruit_error=str(e))
        storage.log("error", f"{name}: Recruit push failed - {e}", run_id, sid)
        return None
    except Exception as e:
        storage.update_screening(sid, recruit_status="failed", recruit_error=f"Unexpected: {e}")
        storage.log("error", f"{name}: Recruit push failed unexpectedly - {e}", run_id, sid)
        return None

    storage.update_screening(sid, recruit_status="saved", recruit_error=None)
    storage.log("info", f"{name}: verified in Recruit (record + attachment, {len(data)} bytes).", run_id, sid)
    return record_id


def _save_analysis(sid: int, result: dict, usage: dict) -> None:
    ev, basic = result["evaluation"], result["basic_information"]
    storage.update_screening(
        sid, ai_json=result, extraction=result.get("extraction"),
        candidate_name=ai_scorer.full_name(result), email=basic.get("email"),
        overall_score=ev["overall_score"], ai_score=ev["ai_score"], skill_score=ev["skill_score"],
        recommendation=ev["recommendation"], **usage,
    )


def _picklist_options() -> dict[str, list[str]]:
    """Recruit's real options for each dropdown the AI fills, so it picks values
    Recruit accepts. Fields whose metadata can't be read are left out and fall
    back to ai_scorer.DEFAULT_OPTIONS."""
    try:
        fields = zoho_recruit.load_field_schema() or {}
    except Exception:
        return {}
    options = {}
    for key, api in ai_scorer.PICKLIST_FIELDS.items():
        meta = fields.get(api)
        if meta and meta.get("data_type") == "picklist":
            opts = [o for o in zoho_recruit._picklist_options(meta) if o.lower() not in ("option 2",)]
            if opts:
                options[key] = opts
    return options
