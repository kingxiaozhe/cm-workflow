#!/usr/bin/env bash
# Shared install-manifest and install-lock helpers for install.sh and
# install-codex.sh.
# Sourced by the installers (bash 3.2 compatible); it prints nothing itself so
# each installer keeps its own language. A manifest records the sha256 of every
# file the previous install wrote; a mismatch on reinstall means a local edit
# (real incident: a hand-edited ~/.claude/scripts/cm-ai-host.mjs was silently
# overwritten by another session's `./install.sh --yes`).
#
# Manifest format (v1):
#   line 1: "# cm-workflow install manifest v1"
#   then:   "<64 lowercase hex>  <relative path>"

CM_MANIFEST_HEADER="# cm-workflow install manifest v1"
CM_SHA256_TOOL=""

# Pick a sha256 tool. Returns 1 when neither exists; callers must stop rather
# than skip the local-edit check.
cm_manifest_select_hasher() {
  if command -v shasum >/dev/null 2>&1; then
    CM_SHA256_TOOL=shasum
  elif command -v sha256sum >/dev/null 2>&1; then
    CM_SHA256_TOOL=sha256sum
  else
    CM_SHA256_TOOL=""
    return 1
  fi
}

cm_manifest_abs() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

# cm_manifest_hash_list ROOT LIST OUT
# Hash each relative path listed in LIST (one per line) under ROOT and write
# "<hash>  <path>" lines to OUT. Returns 1 on any hashing failure, and when
# LIST is missing or unreadable (only a readable empty LIST is an empty list).
cm_manifest_hash_list() {
  hl_root=$1
  hl_list=$(cm_manifest_abs "$2")
  hl_out=$(cm_manifest_abs "$3")
  [ -n "$CM_SHA256_TOOL" ] || return 1
  if [ ! -f "$hl_list" ] || [ ! -r "$hl_list" ]; then
    return 1
  fi
  : > "$hl_out" || return 1
  [ -s "$hl_list" ] || return 0
  if [ "$CM_SHA256_TOOL" = shasum ]; then
    (cd "$hl_root" && tr '\n' '\0' < "$hl_list" | xargs -0 shasum -a 256) > "$hl_out" || return 1
  else
    (cd "$hl_root" && tr '\n' '\0' < "$hl_list" | xargs -0 sha256sum) > "$hl_out" || return 1
  fi
  # GNU sha256sum escapes names containing a backslash or newline with a leading
  # backslash; such names cannot round-trip through this format.
  hl_grep=0
  grep -q '^\\' "$hl_out" || hl_grep=$?
  [ "$hl_grep" -eq 1 ] || return 1
  # Every listed file must have exactly one hash line; a failed count is a
  # failure, never an "equal" pair of empty strings.
  hl_out_lines=$(wc -l < "$hl_out") || return 1
  hl_list_lines=$(wc -l < "$hl_list") || return 1
  [ -n "$hl_out_lines" ] && [ "$((hl_out_lines))" -eq "$((hl_list_lines))" ] || return 1
}

# cm_manifest_write ROOT LIST OUT
# Write a complete v1 manifest for the files listed in LIST under ROOT.
# Python bytecode caches and Finder metadata are regenerated outside the
# installer, so they are copied but never recorded (otherwise they would later
# look like hand edits).
cm_manifest_write() {
  mw_out=$(cm_manifest_abs "$3")
  # The line format cannot round-trip a backslash in a name (GNU checksum
  # tools escape it); refuse such names instead of writing a bad manifest.
  mw_grep=0
  grep -q '\\' "$2" || mw_grep=$?
  # 0: a backslash was found; 2: LIST could not be read. Only 1 may continue.
  [ "$mw_grep" -eq 1 ] || return 1
  grep -Ev '(^|/)__pycache__/|(^|/)\.DS_Store$' "$2" > "${mw_out}.list" || [ $? -eq 1 ] || return 1
  cm_manifest_hash_list "$1" "${mw_out}.list" "${mw_out}.body" ||
    { rm -f "${mw_out}.list" "${mw_out}.body"; return 1; }
  rm -f "${mw_out}.list"
  {
    printf '%s\n' "$CM_MANIFEST_HEADER"
    LC_ALL=C sort -k2 "${mw_out}.body"
  } > "$mw_out" || { rm -f "${mw_out}.body"; return 1; }
  rm -f "${mw_out}.body"
  # Never publish a manifest the next install would reject as malformed.
  cm_manifest_validate "$mw_out" || return 1
}

# cm_manifest_validate MANIFEST
# Check the whole manifest in one awk pass that always reads to the end (an
# early-exit `grep -q` at the end of a pipeline dies with SIGPIPE under
# pipefail and silently skipped these checks). Returns 0 when valid, 3 when
# malformed (bad header, bad hash/separator, empty or absolute path, or a `..`
# segment), 1 when the check itself failed.
cm_manifest_validate() {
  if awk -v header="$CM_MANIFEST_HEADER" '
    NR == 1 { if ($0 != header) bad = 1; next }
    {
      hash = substr($0, 1, 64)
      relative = substr($0, 67)
      if (length($0) < 67 || length(hash) != 64 || hash ~ /[^0-9a-f]/ || substr($0, 65, 2) != "  ") { bad = 1; next }
      if (relative ~ /^\// || ("/" relative "/") ~ /\/\.\.\//) bad = 1
    }
    END { if (NR < 1) bad = 1; exit (bad ? 3 : 0) }' "$1"; then
    return 0
  else
    va_status=$?
    [ "$va_status" -eq 3 ] && return 3
    return 1
  fi
}

# cm_manifest_parent_is_safe ROOT RELATIVE
# Whether RELATIVE's existence can be judged inside ROOT. Returns 0 when every
# existing parent (ROOT included) is a real, searchable directory, so `-e`,
# `-f` and `-L` on RELATIVE are trustworthy; 1 when ROOT or a parent is a
# symlink or not a directory (hashing must never follow a link out of ROOT);
# 2 when ROOT or a parent cannot be searched, so "absent" cannot be told apart
# from "not accessible" and the caller must treat it as a check failure.
cm_manifest_parent_is_safe() {
  ps_current=$1
  if [ -L "$ps_current" ]; then
    return 1
  fi
  if [ ! -e "$ps_current" ]; then
    return 0
  fi
  [ -d "$ps_current" ] || return 1
  [ -x "$ps_current" ] || return 2
  ps_remaining=$(dirname "$2")
  while [ -n "$ps_remaining" ] && [ "$ps_remaining" != "." ]; do
    case "$ps_remaining" in
      */*) ps_component=${ps_remaining%%/*}; ps_remaining=${ps_remaining#*/} ;;
      *) ps_component=$ps_remaining; ps_remaining="" ;;
    esac
    ps_current="$ps_current/$ps_component"
    if [ -L "$ps_current" ]; then
      return 1
    fi
    # The parent of this component was searchable, so "missing" is real.
    if [ ! -e "$ps_current" ]; then
      return 0
    fi
    [ -d "$ps_current" ] || return 1
    [ -x "$ps_current" ] || return 2
  done
  return 0
}

# cm_manifest_find_edits ROOT MANIFEST EDITS_OUT WORK_DIR
# Write to EDITS_OUT every manifest path that still exists under ROOT but no
# longer matches its recorded hash. A symlink or non-file at that path, or a
# symlinked / non-directory parent, also counts. Paths absent from ROOT or from
# the manifest are not judged; a path whose parent cannot be searched is a
# check failure (status 1), never "absent".
# Returns 0 on success, 3 when the manifest is malformed or not a regular file,
# 1 on any check or hashing failure.
cm_manifest_find_edits() {
  fe_root=$1
  fe_manifest=$2
  fe_edits=$(cm_manifest_abs "$3")
  fe_work=$(cm_manifest_abs "$4")
  : > "$fe_edits" || return 1
  if [ -L "$fe_manifest" ] || [ ! -f "$fe_manifest" ]; then
    return 3
  fi
  if cm_manifest_validate "$fe_manifest"; then
    :
  else
    return $?
  fi
  awk 'NR > 1 { print substr($0, 67) }' "$fe_manifest" > "$fe_work/recorded-paths" || return 1
  : > "$fe_work/existing-paths" || return 1
  # Read the whole list first so an open or read failure is a check failure;
  # a loop fed by `< file` would just see no lines and report "no edits".
  fe_paths=$(cat "$fe_work/recorded-paths") || return 1
  case $- in *f*) fe_noglob=1 ;; *) fe_noglob=0 ;; esac
  fe_saved_ifs=$IFS
  IFS='
'
  set -f
  fe_failed=0
  for fe_rel in $fe_paths; do
    [ -n "$fe_rel" ] || continue
    fe_target="$fe_root/$fe_rel"
    fe_parent=0
    cm_manifest_parent_is_safe "$fe_root" "$fe_rel" || fe_parent=$?
    if [ "$fe_parent" -eq 2 ]; then
      # Cannot tell "deleted" from "not accessible": a check failure.
      fe_failed=1
      break
    elif [ "$fe_parent" -ne 0 ]; then
      printf '%s\n' "$fe_rel" >> "$fe_edits" || { fe_failed=1; break; }
    elif [ -L "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_edits" || { fe_failed=1; break; }
    elif [ -f "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_work/existing-paths" || { fe_failed=1; break; }
    elif [ -e "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_edits" || { fe_failed=1; break; }
    fi
  done
  IFS=$fe_saved_ifs
  [ "$fe_noglob" -eq 1 ] || set +f
  [ "$fe_failed" -eq 0 ] || return 1
  cm_manifest_hash_list "$fe_root" "$fe_work/existing-paths" "$fe_work/current-hashes" || return 1
  awk 'NR == FNR { if (FNR > 1) recorded[substr($0, 67)] = substr($0, 1, 64); next }
       { path = substr($0, 67); if (recorded[path] != substr($0, 1, 64)) print path }' \
    "$fe_manifest" "$fe_work/current-hashes" >> "$fe_edits" || return 1
  LC_ALL=C sort -o "$fe_edits" "$fe_edits" || return 1
}

# cm_manifest_recorded_hash MANIFEST RELATIVE
# Print the recorded hash for RELATIVE (empty when not recorded). The manifest
# must already have passed cm_manifest_validate.
cm_manifest_recorded_hash() {
  awk -v wanted="$2" 'NR > 1 && substr($0, 67) == wanted { print substr($0, 1, 64); exit }' "$1"
}

# cm_manifest_file_hash FILE
# Print the sha256 of one file; returns 1 on failure.
cm_manifest_file_hash() {
  if [ "$CM_SHA256_TOOL" = shasum ]; then
    fh_line=$(shasum -a 256 < "$1") || return 1
  else
    fh_line=$(sha256sum < "$1") || return 1
  fi
  printf '%s\n' "${fh_line%% *}"
}

# ---- Install lock -----------------------------------------------------------
# One install transaction per target at a time (bash 3.2: `mkdir` is atomic).
# A stale lock is never taken over automatically; the installer reports the
# holder and the manual removal command, and a person decides.

# cm_install_lock_acquire LOCK_DIR -> 0 acquired, 1 not acquired. Call it
# between cm_defer_signals and cm_resume_signals and register ownership right
# after. mkdir runs via cm_run_shielded, so a signal sent to the whole process
# group cannot kill it after the directory exists: the exit status always
# tells whether this run created the lock.
cm_install_lock_acquire() {
  cm_run_shielded mkdir "$1" 2>/dev/null
}

# cm_install_lock_write_owner LOCK_DIR TARGET
cm_install_lock_write_owner() {
  printf 'pid=%s\nstarted=%s\ntarget=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$1/owner" || true
}

# cm_install_lock_field LOCK_DIR FIELD -> value from the owner file, or empty
cm_install_lock_field() {
  [ -f "$1/owner" ] || return 0
  awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1/owner"
}

# cm_install_lock_pid_state PID -> alive | not-running | unknown
cm_install_lock_pid_state() {
  case "$1" in
    ''|*[!0-9]*) echo unknown; return 0 ;;
  esac
  if kill -0 "$1" 2>/dev/null; then
    echo alive
  elif ps -p "$1" >/dev/null 2>&1; then
    echo alive
  else
    echo not-running
  fi
}

# cm_install_lock_path CANONICAL_TARGET -> the one lock path for that target.
# Both installers use this rule, so any spelling of the same real directory
# (and the Claude and Codex installers aimed at the same directory) share it.
cm_install_lock_path() {
  printf '%s/.%s.cm-install.lock\n' "$(dirname "$1")" "$(basename "$1")"
}

# cm_install_canonical_target PATH
# Print the physical path of an install root: trailing "/" and "/." are
# dropped and the parent is resolved with `pwd -P` (creating it if needed).
# Returns 2 when the root itself is a symlink or not a directory, 1 when the
# path is empty, ends in ".." or its parent cannot be resolved.
cm_install_canonical_target() {
  ct_path=$1
  while :; do
    case "$ct_path" in
      ?*/) ct_path=${ct_path%/} ;;
      ?*/.) ct_path=${ct_path%/.} ;;
      *) break ;;
    esac
  done
  case "$ct_path" in
    ''|.|..|*/..|/) return 1 ;;
  esac
  if [ -L "$ct_path" ]; then
    return 2
  fi
  if [ -e "$ct_path" ] && [ ! -d "$ct_path" ]; then
    return 2
  fi
  ct_parent=$(dirname "$ct_path")
  mkdir -p "$ct_parent" 2>/dev/null || return 1
  ct_parent=$(cd "$ct_parent" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "${ct_parent%/}" "$(basename "$ct_path")"
}

# Shell-quote one argument for a command shown to a person (bash 3.2 %q).
cm_install_quote() {
  printf '%q' "$1"
}

# ---- Signal deferral ----------------------------------------------------------
# Between a state change and the variable that tells cleanup about it (lock
# taken / directory renamed), HUP/INT/TERM are recorded instead of acted on,
# then honoured once the state is registered.
CM_PENDING_SIGNAL=""
cm_defer_signals() {
  CM_PENDING_SIGNAL=""
  trap 'CM_PENDING_SIGNAL=129' HUP
  trap 'CM_PENDING_SIGNAL=130' INT
  trap 'CM_PENDING_SIGNAL=143' TERM
}
cm_resume_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -n "$CM_PENDING_SIGNAL" ]; then
    exit "$CM_PENDING_SIGNAL"
  fi
}

# cm_run_shielded COMMAND [ARGS...]
# Run one state-changing external command with HUP/INT/TERM ignored (the
# ignored disposition survives exec), so its exit status reports whether the
# side effect happened even when the whole process group is signalled. The
# parent records such signals through cm_defer_signals and acts on them after
# registering the result.
cm_run_shielded() {
  (trap '' HUP INT TERM; exec "$@")
}

# Test-only fault injection point. CM_INSTALL_TEST_HOOK is unset outside the
# repository's tests; when set it is run as `$CM_INSTALL_TEST_HOOK <point> ...`.
cm_install_test_hook() {
  if [ -n "${CM_INSTALL_TEST_HOOK:-}" ]; then
    "$CM_INSTALL_TEST_HOOK" "$@"
  fi
}
