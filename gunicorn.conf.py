"""
Read automatically by gunicorn (it loads ./gunicorn.conf.py by default).

Runs the app's start-up in the worker process right after it boots: restore
the database copy from MongoDB, open the database, start background threads.
Doing this at import time instead broke the app on Render: the worker was
forked from a process that had already started threads, and a lock held by
one of them at that instant stayed held forever (every Zoho call hung).
"""


def post_worker_init(worker):
    import app
    app.ensure_started()
