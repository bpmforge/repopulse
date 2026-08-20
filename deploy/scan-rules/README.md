# Scan rules and vulnerability data

This directory is mounted **read-only** into the worker and, from there, into
the `--network=none` scan container. It is populated on the HOST by
`deploy/scan-db-sync.sh` (run it nightly from cron or a timer).

It is committed empty on purpose. The bind mount's source has to exist before
`compose up`, and without this file a clean checkout fails to start the worker
with `statfs .../scan-rules: no such file or directory` — a first-run failure
that says nothing about what to create. Found by running the W11-03 rollback
drill on a stack whose worker container had been recreated.

Contents are generated data, not source: nothing in here is committed.
