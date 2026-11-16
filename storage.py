"""
SQLite persistence: job descriptions, screening runs, per-resume results, and
an append-only audit log of every step (including every WorkDrive deletion
decision). The database is a single file next to the app (screener.db).

Why SQLite: the app runs as one process, the data is small, and it needs to
survive restarts - the old in-memory CANDIDATE_STORE lost everything.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

import config
import forksafe

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS job_descriptions (
    role_folder_id  TEXT PRIMARY KEY,
    role_name       TEXT NOT NULL,
    jd_text         TEXT NOT NULL DEFAULT '',
    pass_threshold  INTEGER NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id        TEXT NOT NULL,
    folder_path      TEXT NOT NULL,
    role_folder_id   TEXT NOT NULL,
    role_name        TEXT NOT NULL,
    jd_snapshot      TEXT NOT NULL,
    pass_threshold   INTEGER NOT NULL,
    status           TEXT NOT NULL,          -- running | cancelling | cancelled | completed | failed
    total            INTEGER NOT NULL DEFAULT 0,
    processed        INTEGER NOT NULL DEFAULT 0,
    passed           INTEGER NOT NULL DEFAULT 0,
    rejected         INTEGER NOT NULL DEFAULT 0,
    failed           INTEGER NOT NULL DEFAULT 0,
    deleted          INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    started_at       TEXT NOT NULL,
    finished_at      TEXT
);

CREATE TABLE IF NOT EXISTS screenings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              INTEGER NOT NULL REFERENCES runs(id),
    file_id             TEXT NOT NULL,
    filename            TEXT NOT NULL,
    folder_id           TEXT NOT NULL,
    file_size           INTEGER,
    stage               TEXT NOT NULL,       -- queued | downloading | scoring | pushing | deleting | done
    outcome             TEXT,                -- passed | rejected | failed
    candidate_name      TEXT,
    email               TEXT,
    overall_score       REAL,
    ai_score            REAL,
    skill_score         REAL,
    recommendation      TEXT,
    ai_json             TEXT,
    recruit_status      TEXT NOT NULL DEFAULT 'not_pushed',  -- not_pushed | saved | failed
    recruit_record_id   TEXT,
    recruit_error       TEXT,
    dropped_fields      TEXT,                -- JSON list of fields Recruit refused
    workdrive_action    TEXT NOT NULL DEFAULT 'kept',  -- kept | deleted | delete_blocked | delete_failed
    workdrive_reason    TEXT,
    error               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_screenings_run  ON screenings(run_id);
CREATE INDEX IF NOT EXISTS idx_screenings_file ON screenings(file_id);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER,
    screening_id  INTEGER,
    level         TEXT NOT NULL,             -- info | warn | error | delete
    message       TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);

CREATE TABLE IF NOT EXISTS fetched_emails (
    message_id  TEXT PRIMARY KEY,
    position    TEXT,
    candidate   TEXT,
    file_name   TEXT,
    file_id     TEXT,
    fetched_at  TEXT NOT NULL
);

-- Walk-in candidates added by HR. The resume sits in ROOT / <role> / Walk-in.
CREATE TABLE IF NOT EXISTS walkins (
    file_id         TEXT PRIMARY KEY,
    role_folder_id  TEXT NOT NULL,
    role_name       TEXT NOT NULL,
    name            TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    notes           TEXT,
    added_at        TEXT NOT NULL
);

-- Resumes waiting for the candidate to fill the role's Google Form. The file
-- sits in ROOT / <role> / Form Pending; this row remembers how to match it.
CREATE TABLE IF NOT EXISTS form_pending (
    file_id           TEXT PRIMARY KEY,
    filename          TEXT NOT NULL,
    role_folder_id    TEXT NOT NULL,
    role_name         TEXT NOT NULL,
    pending_folder_id TEXT NOT NULL,
    from_folder_id    TEXT,                  -- where it was before (Low results go back there)
    from_folder_path  TEXT,
    emails            TEXT NOT NULL DEFAULT '[]',
    phones            TEXT NOT NULL DEFAULT '[]',
    pending_since     TEXT NOT NULL,
    filled_at         TEXT,                  -- set when a matching response appears
    seen              INTEGER NOT NULL DEFAULT 0  -- 1 = "form filled" notification read
);

-- Applicants fetched from email who should get the position's Google Form.
-- Nothing is sent until someone reviews the list and clicks Send.
CREATE TABLE IF NOT EXISTS form_invites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         TEXT UNIQUE,             -- the resume in WorkDrive
    file_name       TEXT,
    role_folder_id  TEXT NOT NULL,
    role_name       TEXT NOT NULL,
    candidate       TEXT NOT NULL,
    email           TEXT,                    -- where the invite goes (editable)
    email_source    TEXT,                    -- resume | indeed | manual
    other_emails    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL,           -- ready | no_email | sending | sent | already_sent | failed | dismissed
    error           TEXT,
    applied_at      TEXT,                    -- date of the application email
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_status ON form_invites(status);

-- Settings changed from the app (e.g. the sender email). Env vars are the defaults.
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_db: sqlite3.Connection | None = None


@forksafe.after_fork
def _reset_after_fork() -> None:
    # A SQLite connection must never be shared across a fork: drop the
    # parent's (without closing it) and open a fresh one on next use.
    global _lock, _db
    _lock = threading.RLock()
    _db = None


def _open() -> sqlite3.Connection:
    """Opens the one shared connection and applies the pragmas that matter.

    check_same_thread=False is safe here because _lock (an RLock) serialises
    every single access below - no two threads ever touch it at once.
    """
    conn = sqlite3.connect(config.DATABASE_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL + NORMAL: the old default (journal_mode=DELETE, synchronous=FULL)
    # fsync'd the disk on every commit, and a screening run commits constantly
    # (per-resume progress + audit log). This is the single biggest speed-up in
    # the app, and still crash-safe: WAL only risks the last commit or two if
    # the machine loses power, which on Render means a redeploy anyway.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-16000")   # 16 MB page cache, not 2 MB
    return conn


@contextmanager
def _conn():
    """Hands out the shared connection, one caller at a time.

    Re-opening the file per call (the old behaviour) re-parsed the schema and
    re-ran the pragmas every time; keeping it open removes that entirely.
    """
    global _db
    with _lock:
        if _db is None:
            _db = _open()
        try:
            yield _db
            _db.commit()
        except Exception:
            # Without this, a failed write would leave the transaction open and
            # every later write on this connection would fail too.
            try:
                _db.rollback()
            except sqlite3.Error:
                pass
            raise


def change_counter() -> int:
    """Rows changed through the shared connection since it opened. Goes up on
    every write; db_backup uploads only when it moved."""
    global _db
    with _lock:
        if _db is None:
            _db = _open()
        return _db.total_changes


# Columns added after the first release - applied to existing databases.
_MIGRATIONS = {
    "job_descriptions": {
        "form_sheet_url": "TEXT",                   # role's Google Form response sheet
        "form_url": "TEXT",                         # the Google Form itself (sent to applicants)
        "invite_subject": "TEXT",                   # invite email template (NULL = default)
        "invite_body": "TEXT",
        "form_id": "INTEGER",                       # the shared Google Form it uses (forms table)
    },
    "runs": {
        "form_pending": "INTEGER NOT NULL DEFAULT 0",  # resumes parked until the form is filled
    },
    "screenings": {
        "content_hash": "TEXT",
        "extraction": "TEXT",                       # quick | full
        "prompt_tokens": "INTEGER NOT NULL DEFAULT 0",
        "completion_tokens": "INTEGER NOT NULL DEFAULT 0",
        "cached_tokens": "INTEGER NOT NULL DEFAULT 0",
        "reused": "INTEGER NOT NULL DEFAULT 0",     # 1 = analysis reused from an identical file
        "recruit_action": "TEXT",                   # insert = new candidate | update = existing one
        "duration_ms": "INTEGER",                   # wall time for this resume, download -> done
        "form_json": "TEXT",                        # matched Google Form response (answers)
        "file_added_ms": "INTEGER",                 # when the resume landed in WorkDrive (applications chart)
    },
    "form_invites": {
        "folder_id": "TEXT",                        # WorkDrive folder the resume was filed in (date folder)
        "phones": "TEXT NOT NULL DEFAULT '[]'",     # from the resume, to match the form by phone too
        "form_filled_at": "TEXT",                   # set when their Google Form response appears
        "form_json": "TEXT",                        # the matched response (answers)
        "source": "TEXT NOT NULL DEFAULT 'gmail'",  # gmail | upload
    },
}


_FORMS_SCHEMA = """
-- Google Forms, set up once on the Forms page and assigned to positions.
-- A position copies its form's links into job_descriptions.form_url /
-- form_sheet_url, so sending and form-checking read them as before.
CREATE TABLE IF NOT EXISTS forms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    form_url    TEXT,
    sheet_url   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"""


def init_db() -> None:
    with _conn() as c:
        c.executescript(SCHEMA)
        c.executescript(_FORMS_SCHEMA)
        for table, columns in _MIGRATIONS.items():
            existing = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            for name, decl in columns.items():
                if name not in existing:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        c.execute("CREATE INDEX IF NOT EXISTS idx_screenings_hash ON screenings(content_hash)")


def _row(r):
    return dict(r) if r else None


# ---------------------------------------------------------------- JDs

def get_jd(role_folder_id: str):
    with _conn() as c:
        return _row(c.execute(
            "SELECT * FROM job_descriptions WHERE role_folder_id = ?", (role_folder_id,)
        ).fetchone())


def list_jds() -> dict:
    with _conn() as c:
        return {r["role_folder_id"]: dict(r) for r in c.execute("SELECT * FROM job_descriptions")}


def save_jd(role_folder_id: str, role_name: str, jd_text: str, pass_threshold: int,
            form_sheet_url: str | None = None) -> dict:
    with _conn() as c:
        c.execute(
            """INSERT INTO job_descriptions (role_folder_id, role_name, jd_text, pass_threshold, form_sheet_url, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(role_folder_id) DO UPDATE SET
                 role_name = excluded.role_name, jd_text = excluded.jd_text,
                 pass_threshold = excluded.pass_threshold,
                 form_id = CASE WHEN IFNULL(form_sheet_url, '') = IFNULL(excluded.form_sheet_url, '')
                                THEN form_id END,
                 form_sheet_url = excluded.form_sheet_url,
                 updated_at = excluded.updated_at""",
            (role_folder_id, role_name, jd_text, pass_threshold, form_sheet_url or None, now()),
        )
    return get_jd(role_folder_id)


def set_form_sheet(role_folder_id: str, role_name: str, url: str | None) -> dict:
    """Saves (or clears) a position's Google Form response sheet link. Works
    before the JD is written: the row is created with an empty JD."""
    with _conn() as c:
        c.execute(
            """INSERT INTO job_descriptions (role_folder_id, role_name, jd_text, pass_threshold, form_sheet_url, updated_at)
               VALUES (?, ?, '', ?, ?, ?)
               ON CONFLICT(role_folder_id) DO UPDATE SET
                 role_name = excluded.role_name,
                 form_id = CASE WHEN IFNULL(form_sheet_url, '') = IFNULL(excluded.form_sheet_url, '')
                                THEN form_id END,
                 form_sheet_url = excluded.form_sheet_url,
                 updated_at = excluded.updated_at""",
            (role_folder_id, role_name, config.BAND_MEDIUM, url or None, now()),
        )
    return get_jd(role_folder_id)


def set_invite_settings(role_folder_id: str, role_name: str, form_url: str | None,
                        subject: str | None, body: str | None) -> dict:
    """Saves a position's Google Form link and invite email template. Like the
    sheet link, works before the JD is written."""
    with _conn() as c:
        c.execute(
            """INSERT INTO job_descriptions (role_folder_id, role_name, jd_text, pass_threshold,
                                             form_url, invite_subject, invite_body, updated_at)
               VALUES (?, ?, '', ?, ?, ?, ?, ?)
               ON CONFLICT(role_folder_id) DO UPDATE SET
                 role_name = excluded.role_name,
                 form_id = CASE WHEN IFNULL(form_url, '') = IFNULL(excluded.form_url, '') THEN form_id END,
                 form_url = excluded.form_url,
                 invite_subject = excluded.invite_subject, invite_body = excluded.invite_body,
                 updated_at = excluded.updated_at""",
            (role_folder_id, role_name, config.BAND_MEDIUM, form_url or None, subject or None, body or None, now()),
        )
    return get_jd(role_folder_id)


def restore_role_settings(role_folder_id: str, role_name: str, s: dict) -> bool:
    """Re-creates a position's row from its WorkDrive settings file. Only fills
    a missing row - never overwrites anything saved in this database."""
    with _conn() as c:
        cur = c.execute(
            """INSERT OR IGNORE INTO job_descriptions (role_folder_id, role_name, jd_text, pass_threshold,
                   form_sheet_url, form_url, invite_subject, invite_body, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (role_folder_id, role_name, s.get("jd_text") or "", config.BAND_MEDIUM,
             s.get("form_sheet_url") or None, s.get("form_url") or None,
             s.get("invite_subject") or None, s.get("invite_body") or None,
             s.get("updated_at") or now()),
        )
        return cur.rowcount > 0


# ---------------------------------------------------------------- shared Google Forms

def _adopt_unlinked_forms(c) -> None:
    """Positions set up before the Forms page (or restored from their WorkDrive
    settings file) have links but no form: group them by their links and
    create one form per group, so every link shows up on the Forms page."""
    groups: dict = {}
    for r in c.execute("""SELECT role_folder_id, role_name, form_url, form_sheet_url FROM job_descriptions
                          WHERE form_id IS NULL AND (IFNULL(form_url, '') != '' OR IFNULL(form_sheet_url, '') != '')
                          ORDER BY role_name"""):
        groups.setdefault((r["form_url"] or "", r["form_sheet_url"] or ""), []).append(r)
    for (form_url, sheet_url), rows in groups.items():
        same = c.execute("SELECT id FROM forms WHERE IFNULL(form_url, '') = ? AND IFNULL(sheet_url, '') = ?",
                         (form_url, sheet_url)).fetchone()
        if same:
            fid = same["id"]
        else:
            name = f"{rows[0]['role_name']} form" if len(rows) == 1 else "Shared form"
            taken = {r["name"] for r in c.execute("SELECT name FROM forms")}
            base, k = name, 2
            while name in taken:
                name, k = f"{base} {k}", k + 1
            fid = c.execute("INSERT INTO forms (name, form_url, sheet_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                            (name, form_url or None, sheet_url or None, now(), now())).lastrowid
        c.executemany("UPDATE job_descriptions SET form_id = ? WHERE role_folder_id = ?",
                      [(fid, r["role_folder_id"]) for r in rows])


def list_forms() -> list:
    with _conn() as c:
        _adopt_unlinked_forms(c)
        forms = [dict(r) for r in c.execute("SELECT * FROM forms ORDER BY name COLLATE NOCASE")]
        used: dict = {}
        for r in c.execute("SELECT role_folder_id, role_name, form_id FROM job_descriptions "
                           "WHERE form_id IS NOT NULL ORDER BY role_name COLLATE NOCASE"):
            used.setdefault(r["form_id"], []).append({"id": r["role_folder_id"], "name": r["role_name"]})
    for f in forms:
        f["positions"] = used.get(f["id"], [])
    return forms


def get_form(form_id: int):
    with _conn() as c:
        return _row(c.execute("SELECT * FROM forms WHERE id = ?", (form_id,)).fetchone())


def save_form(form_id: int | None, name: str, form_url: str | None, sheet_url: str | None) -> tuple[dict, list]:
    """Creates or updates a form. Every position using it gets the new links.
    Returns (form, ids of the positions whose links changed)."""
    with _conn() as c:
        if form_id:
            c.execute("UPDATE forms SET name = ?, form_url = ?, sheet_url = ?, updated_at = ? WHERE id = ?",
                      (name, form_url or None, sheet_url or None, now(), form_id))
        else:
            form_id = c.execute("INSERT INTO forms (name, form_url, sheet_url, created_at, updated_at) "
                                "VALUES (?, ?, ?, ?, ?)",
                                (name, form_url or None, sheet_url or None, now(), now())).lastrowid
        changed = [r["role_folder_id"] for r in c.execute(
            """SELECT role_folder_id FROM job_descriptions WHERE form_id = ?
               AND (IFNULL(form_url, '') != ? OR IFNULL(form_sheet_url, '') != ?)""",
            (form_id, form_url or "", sheet_url or ""))]
        c.execute("UPDATE job_descriptions SET form_url = ?, form_sheet_url = ?, updated_at = ? WHERE form_id = ?",
                  (form_url or None, sheet_url or None, now(), form_id))
    return get_form(form_id), changed


def assign_form(role_folder_id: str, role_name: str, form_id: int | None) -> None:
    """Points a position at a form (copying its links), or at none."""
    form = get_form(form_id) if form_id else None
    with _conn() as c:
        c.execute(
            """INSERT INTO job_descriptions (role_folder_id, role_name, jd_text, pass_threshold,
                                             form_id, form_url, form_sheet_url, updated_at)
               VALUES (?, ?, '', ?, ?, ?, ?, ?)
               ON CONFLICT(role_folder_id) DO UPDATE SET
                 role_name = excluded.role_name, form_id = excluded.form_id, form_url = excluded.form_url,
                 form_sheet_url = excluded.form_sheet_url, updated_at = excluded.updated_at""",
            (role_folder_id, role_name, config.BAND_MEDIUM, form["id"] if form else None,
             (form or {}).get("form_url"), (form or {}).get("sheet_url"), now()))


def form_position_ids(form_id: int) -> list:
    with _conn() as c:
        return [r["role_folder_id"] for r in c.execute(
            "SELECT role_folder_id FROM job_descriptions WHERE form_id = ?", (form_id,))]


def delete_form(form_id: int) -> list:
    """Deletes a form; its positions are left without one. Returns their ids."""
    ids = form_position_ids(form_id)
    with _conn() as c:
        c.execute("""UPDATE job_descriptions SET form_id = NULL, form_url = NULL, form_sheet_url = NULL,
                     updated_at = ? WHERE form_id = ?""", (now(), form_id))
        c.execute("DELETE FROM forms WHERE id = ?", (form_id,))
    return ids


# ---------------------------------------------------------------- deleted folders

def forget_folder(folder_id: str, *, position: bool, role_folder_id: str, walkin_folder: bool = False) -> int:
    """After a folder went to WorkDrive trash: drops the applicants whose
    resumes were in it, so they stop showing in the app. Screening history
    (Activity) is kept. Returns how many applicants were removed."""
    with _conn() as c:
        if position:
            n = c.execute("DELETE FROM form_invites WHERE role_folder_id = ?", (folder_id,)).rowcount
            n += c.execute("DELETE FROM walkins WHERE role_folder_id = ?", (folder_id,)).rowcount
            c.execute("DELETE FROM form_pending WHERE role_folder_id = ?", (folder_id,))
            c.execute("DELETE FROM job_descriptions WHERE role_folder_id = ?", (folder_id,))
            return n
        parked = [r["file_id"] for r in c.execute(
            "SELECT file_id FROM form_pending WHERE pending_folder_id = ?", (folder_id,))]
        n = c.execute("DELETE FROM form_invites WHERE folder_id = ?", (folder_id,)).rowcount
        for fid in parked:
            n += c.execute("DELETE FROM form_invites WHERE file_id = ?", (fid,)).rowcount
        c.execute("DELETE FROM form_pending WHERE pending_folder_id = ?", (folder_id,))
        if walkin_folder:
            n += c.execute("DELETE FROM walkins WHERE role_folder_id = ?", (role_folder_id,)).rowcount
        return n


def rename_role(role_folder_id: str, role_name: str) -> None:
    with _conn() as c:
        c.execute("UPDATE job_descriptions SET role_name = ? WHERE role_folder_id = ?", (role_name, role_folder_id))
        c.execute("UPDATE form_pending SET role_name = ? WHERE role_folder_id = ?", (role_name, role_folder_id))
        c.execute("UPDATE form_invites SET role_name = ? WHERE role_folder_id = ?", (role_name, role_folder_id))


# ---------------------------------------------------------------- runs

def create_run(folder_id, folder_path, role_folder_id, role_name, jd_text, threshold) -> int:
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO runs (folder_id, folder_path, role_folder_id, role_name, jd_snapshot,
                                 pass_threshold, status, started_at)
               VALUES (?, ?, ?, ?, ?, ?, 'running', ?)""",
            (folder_id, folder_path, role_folder_id, role_name, jd_text, threshold, now()),
        )
        return cur.lastrowid


def update_run(run_id: int, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE runs SET {cols} WHERE id = ?", (*fields.values(), run_id))


def bump_run(run_id: int, **increments) -> None:
    cols = ", ".join(f"{k} = {k} + ?" for k in increments)
    with _conn() as c:
        c.execute(f"UPDATE runs SET {cols} WHERE id = ?", (*increments.values(), run_id))


def get_run(run_id: int):
    with _conn() as c:
        return _row(c.execute("SELECT runs.*" + _RUN_TOKENS + " FROM runs WHERE id = ?", (run_id,)).fetchone())


_RUN_TOKENS = """, (SELECT COALESCE(SUM(prompt_tokens), 0) FROM screenings WHERE run_id = runs.id) AS prompt_tokens,
    (SELECT COALESCE(SUM(completion_tokens), 0) FROM screenings WHERE run_id = runs.id) AS completion_tokens,
    (SELECT COALESCE(SUM(cached_tokens), 0) FROM screenings WHERE run_id = runs.id) AS cached_tokens"""


def list_runs(limit: int = 100, folder_id: str | None = None) -> list:
    sql = "SELECT runs.*" + _RUN_TOKENS + " FROM runs"
    args: list = []
    if folder_id:
        sql += " WHERE folder_id = ?"
        args.append(folder_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args)]


def active_run_for_folder(folder_id: str):
    with _conn() as c:
        return _row(c.execute(
            "SELECT * FROM runs WHERE folder_id = ? AND status IN ('running', 'cancelling') ORDER BY id DESC LIMIT 1",
            (folder_id,),
        ).fetchone())


def role_overview() -> dict:
    """role_folder_id -> {"last_activity", "waiting"} for the Positions page."""
    out: dict = {}
    with _conn() as c:
        for r in c.execute("SELECT role_folder_id, MAX(started_at) AS t FROM runs GROUP BY role_folder_id"):
            out.setdefault(r["role_folder_id"], {})["last_activity"] = r["t"]
        for r in c.execute("SELECT role_folder_id, COUNT(*) AS n FROM form_pending GROUP BY role_folder_id"):
            out.setdefault(r["role_folder_id"], {})["waiting"] = r["n"]
    return out


def any_active_run():
    with _conn() as c:
        return _row(c.execute(
            "SELECT * FROM runs WHERE status IN ('running', 'cancelling') ORDER BY id DESC LIMIT 1").fetchone())


def request_cancel_run(run_id: int) -> bool:
    with _conn() as c:
        cur = c.execute(
            "UPDATE runs SET status = 'cancelling' WHERE id = ? AND status = 'running'",
            (run_id,),
        )
        return cur.rowcount > 0


def mark_interrupted_runs() -> int:
    """Runs left 'running' by a previous process can never finish - the thread
    died with it. Close them out so the folder isn't locked forever."""
    with _conn() as c:
        ts = now()
        # Their unfinished resumes too, or they'd show "Screening…" forever
        # (the database now survives restarts via the MongoDB backup).
        c.execute(
            "UPDATE screenings SET stage = 'done', outcome = 'failed', "
            "error = 'Interrupted: the server restarted mid-run. Screen it again.', updated_at = ? "
            "WHERE stage != 'done' AND run_id IN (SELECT id FROM runs WHERE status IN ('running', 'cancelling'))",
            (ts,),
        )
        cur = c.execute(
            "UPDATE runs SET status = 'failed', error = 'Interrupted: the server restarted mid-run.', "
            "finished_at = ? WHERE status IN ('running', 'cancelling')",
            (ts,),
        )
        return cur.rowcount


# ---------------------------------------------------------------- screenings

def create_screening(run_id, file_id, filename, folder_id, file_added_ms=None) -> int:
    with _conn() as c:
        ts = now()
        cur = c.execute(
            """INSERT INTO screenings (run_id, file_id, filename, folder_id, stage, created_at, updated_at, file_added_ms)
               VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)""",
            (run_id, file_id, filename, folder_id, ts, ts, file_added_ms),
        )
        return cur.lastrowid


def update_screening(screening_id: int, **fields) -> None:
    if "ai_json" in fields and not isinstance(fields["ai_json"], (str, type(None))):
        fields["ai_json"] = json.dumps(fields["ai_json"], ensure_ascii=False)
    if "dropped_fields" in fields and not isinstance(fields["dropped_fields"], (str, type(None))):
        fields["dropped_fields"] = json.dumps(fields["dropped_fields"])
    if "form_json" in fields and not isinstance(fields["form_json"], (str, type(None))):
        fields["form_json"] = json.dumps(fields["form_json"], ensure_ascii=False)
    fields["updated_at"] = now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE screenings SET {cols} WHERE id = ?", (*fields.values(), screening_id))


def _decode_screening(r: dict) -> dict:
    for key in ("ai_json", "dropped_fields", "form_json"):
        if r.get(key):
            try:
                r[key] = json.loads(r[key])
            except ValueError:
                pass
    return r


def get_screening(screening_id: int):
    with _conn() as c:
        r = _row(c.execute("SELECT * FROM screenings WHERE id = ?", (screening_id,)).fetchone())
    return _decode_screening(r) if r else None


def screenings_for_run(run_id: int, include_json: bool = False) -> list:
    with _conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM screenings WHERE run_id = ? ORDER BY id", (run_id,)
        )]
    for r in rows:
        if include_json:
            _decode_screening(r)
        else:
            r.pop("ai_json", None)
            r.pop("form_json", None)
            if r.get("dropped_fields"):
                try:
                    r["dropped_fields"] = json.loads(r["dropped_fields"])
                except ValueError:
                    pass
    return rows


def latest_screening_by_file(file_ids: list[str]) -> dict:
    """file_id -> the most recent screening for that file (any run)."""
    if not file_ids:
        return {}
    rows = []
    with _conn() as c:
        for i in range(0, len(file_ids), 500):  # stay under SQLite's bound-parameter limit
            chunk = file_ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            rows += c.execute(
                f"""SELECT s.* FROM screenings s
                    JOIN (SELECT file_id, MAX(id) AS mid FROM screenings
                          WHERE file_id IN ({marks}) GROUP BY file_id) m
                      ON s.id = m.mid""",
                chunk,
            ).fetchall()
    out = {}
    for r in rows:
        d = dict(r)
        d.pop("ai_json", None)
        d.pop("form_json", None)
        out[d["file_id"]] = d
    return out


# ---------------------------------------------------------------- events

def log(level: str, message: str, run_id: int | None = None, screening_id: int | None = None) -> None:
    with _conn() as c:
        c.execute(
            "INSERT INTO events (run_id, screening_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)",
            (run_id, screening_id, level, message, now()),
        )
    print(f"[{level.upper():6}] run={run_id} scr={screening_id} {message}", flush=True)


def events(run_id: int | None = None, limit: int = 500, after_id: int = 0) -> list:
    sql = "SELECT * FROM events WHERE id > ?"
    args: list = [after_id]
    if run_id is not None:
        sql += " AND run_id = ?"
        args.append(run_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _conn() as c:
        rows = [dict(r) for r in c.execute(sql, args)]
    rows.reverse()
    return rows


# ---------------------------------------------------------------- token saving

def find_reusable_analysis(content_hash: str, jd_text: str, extraction: str):
    """A previous analysis of a byte-identical file, under the exact same JD,
    produced by the current extraction format."""
    if not content_hash:
        return None
    with _conn() as c:
        r = _row(c.execute(
            """SELECT s.* FROM screenings s JOIN runs r ON r.id = s.run_id
               WHERE s.content_hash = ? AND r.jd_snapshot = ? AND s.extraction = ? AND s.ai_json IS NOT NULL
               ORDER BY s.id DESC LIMIT 1""",
            (content_hash, jd_text, extraction),
        ).fetchone())
    return _decode_screening(r) if r else None


# ---------------------------------------------------------------- dashboard & candidates

_LATEST = """latest AS (
    SELECT s.*, r.role_name, r.role_folder_id, r.folder_path, r.pass_threshold
    FROM screenings s
    JOIN (SELECT file_id, MAX(id) AS mid FROM screenings WHERE stage = 'done' GROUP BY file_id) m
      ON s.id = m.mid
    JOIN runs r ON r.id = s.run_id
)"""

_COUNTS = f"""SUM(outcome != 'form_pending') AS screened,
    SUM(outcome = 'passed') AS passed,
    SUM(outcome = 'rejected') AS rejected,
    SUM(outcome = 'failed') AS failed,
    SUM(outcome = 'form_pending') AS form_pending,
    SUM(outcome = 'walkin') AS walkins,
    SUM(outcome IN ('passed', 'rejected', 'walkin') AND overall_score >= {config.BAND_HIGH}) AS band_high,
    SUM(outcome IN ('passed', 'rejected', 'walkin') AND overall_score >= {config.BAND_MEDIUM} AND overall_score < {config.BAND_HIGH}) AS band_medium,
    SUM(outcome IN ('passed', 'rejected', 'walkin') AND overall_score < {config.BAND_MEDIUM}) AS band_low,
    SUM(recruit_status = 'saved') AS in_recruit,
    SUM(workdrive_action = 'deleted') AS deleted,
    ROUND(AVG(overall_score), 1) AS avg_score,
    ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_seconds,
    ROUND(SUM(COALESCE(duration_ms, 0)) / 1000.0, 1) AS total_seconds"""


def dashboard() -> dict:
    """Outcome counts use each file's LATEST screening, so re-screening a
    resume doesn't double count it. Token totals include every AI call."""
    with _conn() as c:
        totals = dict(c.execute(f"WITH {_LATEST} SELECT {_COUNTS} FROM latest").fetchone())
        roles = [dict(r) for r in c.execute(
            f"""WITH {_LATEST} SELECT role_folder_id, role_name, {_COUNTS}, MAX(updated_at) AS last_activity
                FROM latest GROUP BY role_folder_id ORDER BY last_activity DESC""")]
        tokens = dict(c.execute(
            """SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                      COALESCE(SUM(reused), 0) AS reused,
                      COALESCE(SUM(extraction = 'full'), 0) AS full_extractions,
                      COALESCE(SUM(extraction IS NOT NULL), 0) AS analysed
               FROM screenings""").fetchone())
        not_in_recruit = [dict(r) for r in c.execute(
            f"""WITH {_LATEST} SELECT id, filename, candidate_name, email, overall_score, recruit_status,
                       recruit_error, role_name, updated_at
                FROM latest WHERE {_RECRUIT_FILTERS['not_saved']} ORDER BY updated_at DESC LIMIT 20""")]
        recent_passed = [dict(r) for r in c.execute(
            f"""WITH {_LATEST} SELECT id, run_id, filename, candidate_name, email, overall_score, recommendation,
                       recruit_status, workdrive_action, role_name, updated_at
                FROM latest WHERE outcome = 'passed' ORDER BY updated_at DESC LIMIT 8""")]
        # "Waiting for the form" comes from the pending list itself, so it matches
        # the Form pending page even after files are moved or deleted by hand.
        pending = {r["role_folder_id"]: r["n"] for r in c.execute(
            "SELECT role_folder_id, COUNT(*) AS n FROM form_pending GROUP BY role_folder_id")}
    totals["form_pending"] = sum(pending.values())
    for r in roles:
        r["form_pending"] = pending.get(r["role_folder_id"], 0)
    for block in [totals, *roles]:
        for k in ("screened", "passed", "rejected", "failed", "in_recruit", "deleted",
                  "form_pending", "walkins", "band_high", "band_medium", "band_low"):
            block[k] = block.get(k) or 0
    return {"totals": totals, "roles": roles, "tokens": tokens,
            "recent_passed": recent_passed, "not_in_recruit": not_in_recruit}


# recruit filter -> SQL on the latest screening of each file.
_RECRUIT_FILTERS = {
    "saved": "recruit_status = 'saved'",
    "not_saved": "outcome = 'passed' AND (recruit_status IS NULL OR recruit_status != 'saved')",
    "failed": "recruit_status = 'failed'",
}


_SCORED = "outcome IN ('passed', 'rejected', 'walkin')"
BAND_FILTERS = {
    "high": f"{_SCORED} AND overall_score >= {config.BAND_HIGH}",
    "medium": f"{_SCORED} AND overall_score >= {config.BAND_MEDIUM} AND overall_score < {config.BAND_HIGH}",
    "low": f"{_SCORED} AND overall_score < {config.BAND_MEDIUM}",
}


def candidates(outcome: str | None = None, role_folder_id: str | None = None,
               query: str | None = None, recruit: str | None = None, band: str | None = None,
               limit: int = 500) -> list:
    sql = f"""WITH {_LATEST} SELECT id, run_id, file_id, filename, candidate_name, email, overall_score,
                     ai_score, skill_score, recommendation, outcome, recruit_status, recruit_record_id,
                     workdrive_action, workdrive_reason, extraction, error, role_name, role_folder_id,
                     folder_path, created_at, updated_at, duration_ms, recruit_action, recruit_error,
                     prompt_tokens, completion_tokens, reused
              FROM latest WHERE 1 = 1"""
    args: list = []
    if outcome:
        sql += " AND outcome = ?"
        args.append(outcome)
    if role_folder_id:
        sql += " AND role_folder_id = ?"
        args.append(role_folder_id)
    if recruit in _RECRUIT_FILTERS:
        sql += f" AND ({_RECRUIT_FILTERS[recruit]})"
    if band in BAND_FILTERS:
        sql += f" AND ({BAND_FILTERS[band]})"
    if query:
        sql += " AND (LOWER(candidate_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(filename) LIKE ?)"
        like = f"%{query.lower()}%"
        args += [like, like, like]
    sql += " ORDER BY updated_at DESC LIMIT ?"
    args.append(limit)
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args)]


# ---------------------------------------------------------------- fetched emails

def email_already_fetched(message_id: str) -> bool:
    with _conn() as c:
        return c.execute("SELECT 1 FROM fetched_emails WHERE message_id = ?", (message_id,)).fetchone() is not None


def mark_email_fetched(message_id: str, position: str, candidate: str, file_name: str, file_id: str | None) -> None:
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO fetched_emails (message_id, position, candidate, file_name, file_id, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, position, candidate, file_name, file_id, now()),
        )


# ---------------------------------------------------------------- Google Form invites

def _decode_invite(r) -> dict:
    d = dict(r)
    d["other_emails"] = json.loads(d.get("other_emails") or "[]")
    d["phones"] = json.loads(d.get("phones") or "[]")
    d["form"] = json.loads(d.pop("form_json") or "null")
    return d


def add_invite(*, file_id, file_name, role_folder_id, role_name, candidate, email, email_source,
               other_emails, applied_at, folder_id=None, phones=None, source="gmail") -> int | None:
    """One row per fetched or uploaded resume; the same file again is ignored."""
    with _conn() as c:
        cur = c.execute(
            """INSERT OR IGNORE INTO form_invites (file_id, file_name, role_folder_id, role_name, candidate,
                   email, email_source, other_emails, status, applied_at, created_at, folder_id, phones, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (file_id, file_name, role_folder_id, role_name, candidate, email or None, email_source or None,
             json.dumps(other_emails or []), "ready" if email else "no_email", applied_at, now(),
             folder_id, json.dumps(phones or []), source),
        )
        return cur.lastrowid if cur.rowcount else None


def get_setting(key: str, default=None):
    with _conn() as c:
        r = c.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return r["value"] if r and r["value"] is not None else default


def set_setting(key: str, value) -> None:
    with _conn() as c:
        if value is None or value == "":
            c.execute("DELETE FROM app_settings WHERE key = ?", (key,))
        else:
            c.execute("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                      (key, str(value), now()))


def get_invite_by_file(file_id: str):
    with _conn() as c:
        r = c.execute("SELECT * FROM form_invites WHERE file_id = ?", (file_id,)).fetchone()
        return _decode_invite(r) if r else None


def invites_awaiting_form(role_folder_id: str) -> list:
    """Invited applicants of a position whose form response hasn't been seen yet."""
    with _conn() as c:
        return [_decode_invite(r) for r in c.execute(
            """SELECT * FROM form_invites WHERE role_folder_id = ? AND status IN ('sent', 'already_sent')
                 AND form_filled_at IS NULL""", (role_folder_id,))]


def mark_invite_filled(invite_id: int, response: dict) -> bool:
    with _conn() as c:
        return c.execute(
            "UPDATE form_invites SET form_filled_at = ?, form_json = ? WHERE id = ? AND form_filled_at IS NULL",
            (now(), json.dumps(response, ensure_ascii=False), invite_id)).rowcount > 0


def get_invite(invite_id: int):
    with _conn() as c:
        r = c.execute("SELECT * FROM form_invites WHERE id = ?", (invite_id,)).fetchone()
        return _decode_invite(r) if r else None


def list_invites(include_done: bool = True) -> list:
    sql = "SELECT * FROM form_invites"
    if not include_done:
        sql += " WHERE status NOT IN ('sent', 'already_sent', 'dismissed')"
    with _conn() as c:
        return [_decode_invite(r) for r in c.execute(sql + " ORDER BY applied_at DESC, id DESC")]


def update_invite(invite_id: int, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE form_invites SET {cols} WHERE id = ?", (*fields.values(), invite_id))


def claim_invites(ids: list[int]) -> list[dict]:
    """Marks the given ready/failed invites as 'sending' and returns them, so a
    double click (or two people) can never send the same invite twice."""
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    with _conn() as c:
        rows = [_decode_invite(r) for r in c.execute(
            f"SELECT * FROM form_invites WHERE id IN ({marks}) AND status IN ('ready', 'failed') AND email IS NOT NULL",
            ids)]
        if rows:
            c.execute(f"UPDATE form_invites SET status = 'sending', error = NULL WHERE id IN "
                      f"({','.join('?' * len(rows))})", [r["id"] for r in rows])
    return rows


def reset_stuck_invites() -> int:
    """'sending' rows left by a restart mid-send go back to 'ready' (the Sent
    folder check stops a real duplicate if one did go out)."""
    with _conn() as c:
        return c.execute("UPDATE form_invites SET status = 'ready' WHERE status = 'sending'").rowcount


def invites_ready_count() -> int:
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM form_invites WHERE status = 'ready'").fetchone()[0]


# ---------------------------------------------------------------- Google Form pending

def _decode_pending(r) -> dict:
    d = dict(r)
    for key in ("emails", "phones"):
        try:
            d[key] = json.loads(d.get(key) or "[]")
        except ValueError:
            d[key] = []
    return d


def add_form_pending(*, file_id, filename, role_folder_id, role_name, pending_folder_id,
                     from_folder_id, from_folder_path, emails, phones) -> None:
    """Upsert: a resume screened again while still pending keeps its original
    pending_since and its original from_folder."""
    with _conn() as c:
        c.execute(
            """INSERT INTO form_pending (file_id, filename, role_folder_id, role_name, pending_folder_id,
                                         from_folder_id, from_folder_path, emails, phones, pending_since)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(file_id) DO UPDATE SET
                 filename = excluded.filename, role_name = excluded.role_name,
                 pending_folder_id = excluded.pending_folder_id,
                 emails = excluded.emails, phones = excluded.phones,
                 filled_at = NULL, seen = 0""",
            (file_id, filename, role_folder_id, role_name, pending_folder_id, from_folder_id,
             from_folder_path, json.dumps(emails), json.dumps(phones), now()),
        )


def get_form_pending(file_id: str):
    with _conn() as c:
        r = c.execute("SELECT * FROM form_pending WHERE file_id = ?", (file_id,)).fetchone()
    return _decode_pending(r) if r else None


def list_form_pending(role_folder_id: str | None = None) -> list:
    sql, args = "SELECT * FROM form_pending", []
    if role_folder_id:
        sql += " WHERE role_folder_id = ?"
        args.append(role_folder_id)
    sql += " ORDER BY (filled_at IS NULL), filled_at DESC, pending_since DESC"
    with _conn() as c:
        return [_decode_pending(r) for r in c.execute(sql, args)]


def mark_form_filled(file_id: str) -> bool:
    """True the first time a pending resume's response is found."""
    with _conn() as c:
        cur = c.execute("UPDATE form_pending SET filled_at = ?, seen = 0 WHERE file_id = ? AND filled_at IS NULL",
                        (now(), file_id))
        return cur.rowcount > 0


def remove_form_pending(file_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM form_pending WHERE file_id = ?", (file_id,))


def update_form_pending(file_id: str, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE form_pending SET {cols} WHERE file_id = ?", (*fields.values(), file_id))


def form_notifications() -> dict:
    """Unread 'form filled' notifications for the sidebar bell."""
    with _conn() as c:
        rows = [_decode_pending(r) for r in c.execute(
            "SELECT * FROM form_pending WHERE filled_at IS NOT NULL AND seen = 0 ORDER BY filled_at DESC LIMIT 50")]
        waiting = c.execute("SELECT COUNT(*) FROM form_pending WHERE filled_at IS NULL").fetchone()[0]
        filled = c.execute("SELECT COUNT(*) FROM form_pending WHERE filled_at IS NOT NULL").fetchone()[0]
    return {"unseen": len(rows), "items": rows, "waiting": waiting, "filled": filled}


def mark_notifications_seen() -> None:
    with _conn() as c:
        c.execute("UPDATE form_pending SET seen = 1 WHERE filled_at IS NOT NULL AND seen = 0")


def roles_with_form_sheet() -> list:
    with _conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM job_descriptions WHERE form_sheet_url IS NOT NULL AND form_sheet_url != ''")]


def forget_file(file_id: str) -> None:
    """A file deleted from the app: drop its pending entry. Screening history stays."""
    remove_form_pending(file_id)


# ---------------------------------------------------------------- walk-ins

def add_walkin(*, file_id, role_folder_id, role_name, name, phone, email, notes) -> None:
    with _conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO walkins (file_id, role_folder_id, role_name, name, phone, email, notes, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (file_id, role_folder_id, role_name, name, phone or None, email or None, notes or None, now()))


def list_walkins() -> list:
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM walkins ORDER BY added_at DESC")]


def form_pending_by_file() -> dict:
    with _conn() as c:
        return {r["file_id"]: _decode_pending(r) for r in c.execute("SELECT * FROM form_pending")}


def get_walkin(file_id: str):
    with _conn() as c:
        return _row(c.execute("SELECT * FROM walkins WHERE file_id = ?", (file_id,)).fetchone())
