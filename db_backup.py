"""
Keeps screener.db safe in MongoDB Atlas, so Render's free plan can't lose it.

Render's free plan has no persistent disk: every deploy or restart starts with
no screener.db, which wiped applicants, invites, screenings and the dashboard.
This module keeps a copy of the whole SQLite file in MongoDB (GridFS, database
MONGODB_DB, default "resume_screener"):

  * start-up: if there's no local screener.db yet, the latest copy is
    downloaded before the app opens the database (restore()).
  * while running: a background thread uploads a fresh copy whenever the
    database changed, at most every BACKUP_SECONDS (start()).
  * shutdown: one last upload when the process exits (Render sends SIGTERM
    on every deploy), so a normal redeploy loses nothing.

The app keeps using SQLite exactly as before; Mongo only holds the copy.
Worst case (a crash, not a deploy) loses the last BACKUP_SECONDS of changes.

Each environment writes its own copy (MONGODB_SNAPSHOT: "render" on Render,
"local-<machine>" elsewhere), so running the app locally against the same
cluster never overwrites production.
"""
import atexit
import os
import socket
import sqlite3
import tempfile
import threading
import time
import traceback

import config
import forksafe
import storage

BACKUP_SECONDS = int(os.getenv("BACKUP_SECONDS", "60"))
_BUCKET = "sqlite_snapshots"

_client = None
_started = False
_last_uploaded = None          # storage change counter at the last upload
_upload_lock = threading.Lock()
_state = {"enabled": False, "snapshot": None, "restored_at": None, "restored_bytes": 0,
          "last_backup": None, "last_bytes": 0, "error": None}


def enabled() -> bool:
    return bool(config.MONGODB_URI)


def snapshot_name() -> str:
    explicit = os.getenv("MONGODB_SNAPSHOT", "").strip()
    if explicit:
        return explicit
    return "render" if os.getenv("RENDER") else f"local-{socket.gethostname()}"


def status() -> dict:
    return {**_state, "enabled": enabled(), "snapshot": snapshot_name() if enabled() else None}


@forksafe.after_fork
def _reset_after_fork() -> None:
    # A MongoClient must never be used across a fork: drop the parent's.
    global _client, _started, _upload_lock
    _client = None
    _started = False
    _upload_lock = threading.Lock()


def _db():
    global _client
    if _client is None:
        from pymongo import MongoClient   # imported lazily: only needed when enabled
        kwargs = {}
        uri = config.MONGODB_URI.lower()
        if uri.startswith("mongodb+srv://") or "tls=true" in uri or "ssl=true" in uri:
            try:
                # python.org builds on macOS ship without CA certificates, so Atlas's
                # TLS check fails locally; certifi (a requests dependency) has them.
                # Only for TLS connections: passing it turns TLS on.
                import certifi
                kwargs["tlsCAFile"] = certifi.where()
            except ImportError:
                pass
        _client = MongoClient(config.MONGODB_URI, serverSelectionTimeoutMS=15000,
                              connectTimeoutMS=15000, socketTimeoutMS=60000, appname="resume-screener", **kwargs)
    return _client[config.MONGODB_DB]


_OWN_COLLECTIONS = {f"{_BUCKET}.files", f"{_BUCKET}.chunks"}
_RESERVED_DBS = {"admin", "local", "config"}
_checked_db = False


class ForeignDataError(Exception):
    pass


def _ensure_own_database(db) -> None:
    """Safety guard: the cluster is shared with other apps. Refuse to read,
    write or delete anything unless the database is empty or holds only this
    app's own backup collections - so a wrong MONGODB_DB (e.g. another app's
    database) can never touch, overwrite or delete someone else's data."""
    global _checked_db
    if _checked_db:
        return
    if db.name in _RESERVED_DBS:
        raise ForeignDataError(f"MONGODB_DB='{db.name}' is a MongoDB system database. Use resume_screener.")
    others = sorted(set(db.list_collection_names()) - _OWN_COLLECTIONS)
    if others:
        raise ForeignDataError(
            f"MongoDB database '{db.name}' already holds other data ({', '.join(others[:5])}). "
            "Backups are switched off so nothing there is touched. Set MONGODB_DB to a database "
            "used only by this app (default: resume_screener).")
    _checked_db = True


def _bucket():
    import gridfs
    db = _db()
    _ensure_own_database(db)
    return gridfs.GridFSBucket(db, bucket_name=_BUCKET)


# ---------------------------------------------------------------- restore

def restore() -> None:
    """Downloads the latest copy if this machine has no database yet.
    Never overwrites an existing local file. Errors are reported, not raised:
    the app then starts with an empty database, as before."""
    if not enabled():
        return
    path = config.DATABASE_PATH
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    try:
        bucket = _bucket()
        latest = next(iter(bucket.find({"filename": snapshot_name()}).sort("uploadDate", -1).limit(1)), None)
        if latest is None:
            print(f"Mongo backup: no copy named '{snapshot_name()}' yet - starting with an empty database.")
            return
        data = bucket.open_download_stream(latest._id).read()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        tmp = path + ".restoring"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        _state.update(restored_at=latest.upload_date.isoformat(), restored_bytes=len(data), error=None)
        print(f"Mongo backup: restored {len(data) // 1024} KB saved {latest.upload_date:%Y-%m-%d %H:%M} UTC.")
    except Exception as e:  # noqa: BLE001 - never block start-up on the backup
        _state["error"] = f"Restore failed: {e}"
        print(f"Mongo backup: restore failed, starting with an empty database: {e}")


# ---------------------------------------------------------------- backup

def _consistent_copy() -> bytes:
    """A point-in-time copy via SQLite's backup API (safe while the app writes)."""
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        src = sqlite3.connect(config.DATABASE_PATH, timeout=30)
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def backup_now(force: bool = False) -> bool:
    """Uploads a copy if the database changed since the last one. Returns True
    if it uploaded."""
    global _last_uploaded
    if not enabled():
        return False
    with _upload_lock:
        counter = storage.change_counter()
        if not force and counter == _last_uploaded:
            return False
        data = _consistent_copy()
        bucket = _bucket()
        name = snapshot_name()
        new_id = bucket.upload_from_stream(name, data, metadata={"bytes": len(data), "host": socket.gethostname()})
        # Keep the newest two copies: the one just written and one before it.
        old = list(bucket.find({"filename": name}).sort("uploadDate", -1).skip(2))
        for f in old:
            if f._id != new_id:
                bucket.delete(f._id)
        _last_uploaded = counter
        _state.update(last_backup=storage.now(), last_bytes=len(data), error=None)
        return True


def _loop() -> None:
    while True:
        time.sleep(BACKUP_SECONDS)
        try:
            backup_now()
        except ForeignDataError as e:
            _state["error"] = str(e)
            print(f"Mongo backup stopped: {e}")
            return
        except Exception as e:  # noqa: BLE001 - keep trying next round
            _state["error"] = f"Backup failed: {e}"
            traceback.print_exc()


def start() -> None:
    global _started, _last_uploaded
    if not enabled() or _started:
        return
    _started = True
    # A freshly restored database matches Mongo already; don't re-upload it.
    _last_uploaded = storage.change_counter() if _state["restored_at"] else None
    threading.Thread(target=_loop, daemon=True, name="mongo-backup").start()
    print(f"Mongo backup: saving screener.db to MongoDB as '{snapshot_name()}' every {BACKUP_SECONDS}s when it changes.")


@atexit.register
def _final_backup() -> None:
    if not (enabled() and _started):
        return
    try:
        if backup_now():
            print("Mongo backup: final copy saved before shutdown.")
    except Exception as e:  # noqa: BLE001
        print(f"Mongo backup: final copy failed: {e}")
