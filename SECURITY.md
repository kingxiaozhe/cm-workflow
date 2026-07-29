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
- the optional external-expert channel defaults to explicit activation; AUTO
  requires a current-invocation opt-in, cannot be inherited from a global
  router, never selects HANDOFF, and never authorizes local-file transmission;
- external-expert must disclose the canonical absolute path of every individual
  file and obtain fresh approval before sending its content, reject directories,
  globs, unresolved symlinks, archives, encoded archives, archive-derived bulk
  context, credentials, and customer data, and keep external responses advisory
  until locally verified.

The optional Claude auto-updater is disabled until the user explicitly adds the
documented SessionStart hook.
