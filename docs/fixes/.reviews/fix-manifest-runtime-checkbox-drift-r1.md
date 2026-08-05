---
at: 2026-08-04T20:10:00-07:00
reviewer: codex-subagent
independent: true
task: fix-manifest-runtime-checkbox-drift
round: 1
scope:
  - scripts/cm-spec-manifest.py
  - scripts/test-spec-manifest.py
  - runtime/test-contract.md
  - skills/cm-ai/references/N1-init.md
  - skills/cm-prd/SKILL.md
  - docs/architecture.md
  - docs/user-guide.md
---

Verdict: changes_requested (1 blocking finding).

The runtime task/AC checkbox normalization is correct for ordinary specification
lines, but the regular expressions also match Markdown examples inside fenced or
four-space-indented code blocks. Changing an example from unchecked to checked
could therefore evade the approved-spec manifest.

Review comment:

- [P1] Do not normalize task/AC-shaped text inside Markdown code examples —
  `scripts/cm-spec-manifest.py`

  Normalize only semantic list items in the document body. Preserve fenced and
  indented code bytes exactly, and add regression fixtures for both forms.

Disposition: accepted. The implementation will remain schema-compatible, but
the canonicalization pass will become Markdown-context-aware before round 2.
