#!/usr/bin/env bash
# Shared install-manifest helpers for install.sh and install-codex.sh.
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
# "<hash>  <path>" lines to OUT. Returns 1 on any hashing failure.
cm_manifest_hash_list() {
  hl_root=$1
  hl_list=$(cm_manifest_abs "$2")
  hl_out=$(cm_manifest_abs "$3")
  [ -n "$CM_SHA256_TOOL" ] || return 1
  : > "$hl_out" || return 1
  [ -s "$hl_list" ] || return 0
  if [ "$CM_SHA256_TOOL" = shasum ]; then
    (cd "$hl_root" && tr '\n' '\0' < "$hl_list" | xargs -0 shasum -a 256) > "$hl_out" || return 1
  else
    (cd "$hl_root" && tr '\n' '\0' < "$hl_list" | xargs -0 sha256sum) > "$hl_out" || return 1
  fi
  # GNU sha256sum escapes names containing a backslash or newline with a leading
  # backslash; such names cannot round-trip through this format.
  if grep -q '^\\' "$hl_out"; then
    return 1
  fi
  if [ "$(wc -l < "$hl_out" | tr -d ' ')" != "$(wc -l < "$hl_list" | tr -d ' ')" ]; then
    return 1
  fi
}

# cm_manifest_write ROOT LIST OUT
# Write a complete v1 manifest for the files listed in LIST under ROOT.
# Python bytecode caches and Finder metadata are regenerated outside the
# installer, so they are copied but never recorded (otherwise they would later
# look like hand edits).
cm_manifest_write() {
  mw_out=$(cm_manifest_abs "$3")
  grep -Ev '(^|/)__pycache__/|(^|/)\.DS_Store$' "$2" > "${mw_out}.list" || [ $? -eq 1 ] || return 1
  cm_manifest_hash_list "$1" "${mw_out}.list" "${mw_out}.body" ||
    { rm -f "${mw_out}.list" "${mw_out}.body"; return 1; }
  rm -f "${mw_out}.list"
  {
    printf '%s\n' "$CM_MANIFEST_HEADER"
    LC_ALL=C sort -k2 "${mw_out}.body"
  } > "$mw_out" || { rm -f "${mw_out}.body"; return 1; }
  rm -f "${mw_out}.body"
}

# cm_manifest_find_edits ROOT MANIFEST EDITS_OUT WORK_DIR
# Write to EDITS_OUT every manifest path that still exists under ROOT but no
# longer matches its recorded hash (a symlink or non-file at that path also
# counts). Paths absent from ROOT or from the manifest are not judged.
# Returns 0 on success, 3 when the manifest is malformed, 1 on hashing failure.
cm_manifest_find_edits() {
  fe_root=$1
  fe_manifest=$2
  fe_edits=$(cm_manifest_abs "$3")
  fe_work=$(cm_manifest_abs "$4")
  : > "$fe_edits" || return 1
  [ "$(sed -n '1p' "$fe_manifest")" = "$CM_MANIFEST_HEADER" ] || return 3
  if sed '1d' "$fe_manifest" | grep -Ev '^[0-9a-f]{64}  [^/].*$' | grep -q .; then
    return 3
  fi
  if sed '1d' "$fe_manifest" | cut -c67- | grep -Eq '(^|/)\.\.(/|$)'; then
    return 3
  fi
  sed '1d' "$fe_manifest" | cut -c67- > "$fe_work/recorded-paths" || return 1
  : > "$fe_work/existing-paths"
  while IFS= read -r fe_rel; do
    [ -n "$fe_rel" ] || continue
    fe_target="$fe_root/$fe_rel"
    if [ -L "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_edits"
    elif [ -f "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_work/existing-paths"
    elif [ -e "$fe_target" ]; then
      printf '%s\n' "$fe_rel" >> "$fe_edits"
    fi
  done < "$fe_work/recorded-paths"
  cm_manifest_hash_list "$fe_root" "$fe_work/existing-paths" "$fe_work/current-hashes" || return 1
  awk 'NR == FNR { if (FNR > 1) recorded[substr($0, 67)] = substr($0, 1, 64); next }
       { path = substr($0, 67); if (recorded[path] != substr($0, 1, 64)) print path }' \
    "$fe_manifest" "$fe_work/current-hashes" >> "$fe_edits" || return 1
  LC_ALL=C sort -o "$fe_edits" "$fe_edits" || return 1
}
