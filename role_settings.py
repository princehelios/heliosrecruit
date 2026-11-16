"""
Keeps each position's settings in WorkDrive as well as in the database.

Render's free plan has no persistent disk: every deploy or restart starts with
an empty screener.db, which used to lose every job description, response-sheet
link, Google Form link and invite template. Now each save also writes
ROOT / <position> / _screener-settings.json, and on start-up any position the
database doesn't know is filled back in from that file.

The database stays the source of truth while the app runs; the file is only a
backup. A restore never overwrites a row that already exists.
"""
import json
import threading
import time
import traceback

import config
import forksafe
import storage
import zoho_workdrive
from zoho_auth import ZohoAuthError
from zoho_workdrive import WorkDriveError

_FIELDS = ("jd_text", "form_sheet_url", "form_url", "invite_subject", "invite_body")
_state = {"restored": 0, "last_restore": None, "error": None, "done": False}
_started = False


@forksafe.after_fork
def _reset_after_fork() -> None:
    global _started
    _started = _state["done"]        # restart the restore only if it hadn't finished


def status() -> dict:
    return dict(_state)


def backup(role_folder_id: str) -> None:
    """Writes the position's current settings to WorkDrive in the background.
    A failure is logged, never raised: the database already has the change."""
    threading.Thread(target=_backup, args=(role_folder_id,), daemon=True, name="settings-backup").start()


def _backup(role_folder_id: str) -> None:
    row = storage.get_jd(role_folder_id)
    if not row:
        return
    doc = {"version": 1, "role_name": row["role_name"], "updated_at": row["updated_at"],
           **{k: row.get(k) or "" for k in _FIELDS}}
    try:
        zoho_workdrive.save_settings_file(role_folder_id, config.ROLE_SETTINGS_FILE,
                                          json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
    except (WorkDriveError, ZohoAuthError) as e:
        storage.log("warn", f"Settings for '{row['role_name']}' are saved here but the WorkDrive backup failed "
                            f"(they will be lost on the next redeploy until it succeeds): {e}")


def restore_all() -> int:
    """Fills in every position the database is missing from its WorkDrive
    settings file. Returns how many were restored."""
    known = storage.list_jds()
    restored = 0
    for role in zoho_workdrive.list_children(config.WORKDRIVE_ROOT_FOLDER_ID)["folders"]:
        if role["id"] in known:
            continue
        others = zoho_workdrive.list_children(role["id"]).get("others") or []
        hit = next((o for o in others if o["name"] == config.ROLE_SETTINGS_FILE), None)
        if not hit:
            continue
        try:
            doc = json.loads(zoho_workdrive.download_file(hit["id"]).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            storage.log("warn", f"Settings file for '{role['name']}' is unreadable, skipped: {e}")
            continue
        if storage.restore_role_settings(role["id"], role["name"], doc):
            restored += 1
    return restored


def start() -> None:
    """Restores in the background, retrying until Zoho answers once."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_restore_loop, daemon=True, name="settings-restore").start()


def _restore_loop() -> None:
    delay = 30
    while True:
        try:
            n = restore_all()
            _state.update(restored=_state["restored"] + n, done=True, error=None,
                          last_restore=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            if n:
                storage.log("info", f"Restored the settings of {n} position(s) from WorkDrive.")
            return
        except (WorkDriveError, ZohoAuthError) as e:
            _state["error"] = str(e)
        except Exception as e:  # noqa: BLE001 - never kill the thread
            traceback.print_exc()
            _state["error"] = f"Unexpected: {e}"
        time.sleep(delay)
        delay = min(delay * 2, 600)
