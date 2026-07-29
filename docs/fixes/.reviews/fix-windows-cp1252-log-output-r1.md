---
at: 2026-07-29T02:41:49-07:00
reviewer: codex-cli
independent: true
task: fix-windows-cp1252-log-output
round: 1
scope:
  - scripts/cm-log-event.py
  - scripts/test-cm-log-event.py
---

The production change appears appropriate, but the added regression test does not
exercise non-ASCII stdout and therefore cannot detect the bug it is intended to
prevent.

Review comment:

- [P2] Exercise Unicode in a returned field —
  `scripts/test-cm-log-event.py:121-124`

  The Chinese `--detail` value is written only to the logs and is absent from the
  result printed to stdout; since every returned path and identifier here is
  ASCII, this test still passes with the previous `ensure_ascii=False`
  implementation. Use a non-ASCII specs or log path, then verify the result, so
  the fixture actually reproduces the cp1252 encoding failure.

Disposition: accepted. The fixed project-log filename was already non-ASCII and
the test had produced the expected red failure, but the trigger was implicit.
The fixture now uses an explicitly non-ASCII specs path and checks both the raw
ASCII escape and the decoded Unicode path.
