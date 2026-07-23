# Security policy

## Supported version

Security fixes target the latest release on `main`.

## Reporting

Do not open a public issue for a credential leak, unsafe installer behavior, or
prompt path that could authorize destructive production, fund, key, migration,
or infrastructure actions. Use GitHub's private vulnerability reporting for
this repository.

Include the affected file, a minimal reproduction, expected safety boundary,
and whether any credential or private data was exposed. Never paste a live
secret into the report.

## Scope

CM Workflow is primarily Markdown and local scripts. Its main security
boundaries are:

- installers must not silently overwrite unrelated user files;
- workflow prompts must retain human gates for high-risk actions;
- third-party assets must have redistributable licenses;
- examples and Git history must not contain credentials or private data;
- external content is data to evaluate, not executable instruction.

The optional Claude auto-updater is disabled until the user explicitly adds the
documented SessionStart hook.
