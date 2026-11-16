"""
Makes the app safe to fork after import.

On Render the app module was imported in one process and the process that
serves requests was forked from it. A fork copies memory but not threads:
background threads (form watcher, keep-alive, WorkDrive warm-up) vanish, and
any lock one of them held at that instant stays locked forever in the child.
That is how the Zoho token lock ended up permanently held, so every page that
needed Zoho hung while /healthz kept answering.

Each module registers a small reset with @after_fork: fresh locks, a fresh
HTTP connection pool and SQLite connection, cleared in-flight state. app.py
registers last, so its hook restarts the background threads once everything
else has been reset. Hooks run in the order they were registered.
"""
import os
import traceback

_hooks: list = []


def after_fork(fn):
    _hooks.append(fn)
    return fn


def _run_hooks() -> None:
    for fn in _hooks:
        try:
            fn()
        except Exception:  # noqa: BLE001 - one bad hook must not stop the rest
            traceback.print_exc()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_run_hooks)
