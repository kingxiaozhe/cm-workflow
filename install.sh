#!/usr/bin/env bash
# CM Workflow Claude Code compatibility installer.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
DEST_PARENT="$(dirname "$DEST")"
VERSION="$(cat "$SRC_DIR/VERSION" 2>/dev/null || echo 未知)"
STAGE="$DEST_PARENT/.cm-claude.stage.$$"
BACKUP="$DEST_PARENT/.cm-claude.backup.$$"
ASSUME_YES=0
OVERWRITE_LOCAL_EDITS=0
INSTALL_COMPLETE=0
DEST_TOUCHED=0
# Records what this install wrote so the next install can tell hand edits apart.
INSTALL_MANIFEST_RELATIVE="cm-workflow/install-manifest.sha256"
INSTALL_MANIFEST="$DEST/$INSTALL_MANIFEST_RELATIVE"
GUARD_TMP=""
MANIFEST_PUBLISHED=0
MANIFEST_TMP=""
# One install transaction per target; never taken over automatically. The path
# is set from the canonical target below (shared rule with install-codex.sh).
LOCK_DIR=""
LOCK_HELD=0
ROLLBACK_FAILED=0
# Files this run started writing; rollback restores only these, so a file that
# was never copied (e.g. one found hand-edited mid-copy) is left untouched.
WRITTEN_LIST=""
VERIFIED_MANIFEST=""
MANIFEST_SAVED_NAME=".cm-previous-install-manifest"

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --overwrite-local-edits) OVERWRITE_LOCAL_EDITS=1 ;;
    *) echo "用法: $0 [--yes] [--overwrite-local-edits]" >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/cm-install-manifest.sh
. "$SRC_DIR/scripts/cm-install-manifest.sh"

if ! command -v node >/dev/null 2>&1 ||
  ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node.js 18+ 未找到。请安装 Node.js 并确保 node 在 PATH 中，然后重试。" >&2
  exit 1
fi

# Canonical install root: one physical path per real target, never a symlink.
if DEST_CANONICAL=$(cm_install_canonical_target "$DEST"); then
  :
else
  canonical_status=$?
  if [ "$canonical_status" -eq 2 ]; then
    echo "安装目录不能是符号链接或非目录: ${DEST}；安装已停止，未修改任何文件。" >&2
  else
    echo "无法确定安装目录的真实路径: ${DEST}；安装已停止，未修改任何文件。" >&2
  fi
  exit 2
fi
DEST="$DEST_CANONICAL"
DEST_PARENT="$(dirname "$DEST")"
STAGE="$DEST_PARENT/.cm-claude.stage.$$"
BACKUP="$DEST_PARENT/.cm-claude.backup.$$"
INSTALL_MANIFEST="$DEST/$INSTALL_MANIFEST_RELATIVE"
LOCK_DIR="$(cm_install_lock_path "$DEST")"

# Rollback keeps going after a failed step (no errexit, signals ignored), keeps
# the backup whenever anything could not be restored, and always unlocks.
rollback_fail() {
  echo "  恢复失败: $1" >&2
  ROLLBACK_FAILED=1
}

cleanup() {
  status=$?
  set +e
  trap '' HUP INT TERM
  trap - EXIT
  if [ "$INSTALL_COMPLETE" -ne 1 ] && [ "$DEST_TOUCHED" -eq 1 ]; then
    # Without a readable list of what was written nothing can be restored
    # safely: report it and keep the backup instead of claiming success.
    if written_files=$(cat "$WRITTEN_LIST" 2>/dev/null); then
      :
    else
      written_files=""
      rollback_fail "回滚清单不可读: ${WRITTEN_LIST}（已写入的文件未恢复）"
    fi
    # Split on newlines only (no temporary file, unlike a here-document).
    saved_ifs=$IFS
    IFS='
'
    set -f
    for relative in $written_files; do
      [ -n "$relative" ] || continue
      target="$DEST/$relative"
      saved="$BACKUP/$relative"
      if ! assert_safe_target "$relative"; then
        rollback_fail "$target（路径类型已变化，未写入）"
        continue
      fi
      if [ -f "$saved" ]; then
        { mkdir -p "$(dirname "$target")" && cp -p "$saved" "$target"; } || rollback_fail "$target"
      elif [ -f "$target" ]; then
        rm -f "$target" || rollback_fail "$target"
      fi
    done
    set +f
    IFS=$saved_ifs
    # Keep the manifest paired with the restored files.
    if [ "$MANIFEST_PUBLISHED" -eq 1 ]; then
      if ! assert_safe_target "$INSTALL_MANIFEST_RELATIVE"; then
        rollback_fail "$INSTALL_MANIFEST（路径类型已变化，未写入）"
      elif [ -f "$BACKUP/$MANIFEST_SAVED_NAME" ]; then
        cp -p "$BACKUP/$MANIFEST_SAVED_NAME" "$INSTALL_MANIFEST" || rollback_fail "$INSTALL_MANIFEST"
      else
        rm -f "$INSTALL_MANIFEST" || rollback_fail "$INSTALL_MANIFEST"
      fi
    fi
    if [ "$ROLLBACK_FAILED" -eq 1 ]; then
      echo "⚠ 安装失败，回滚不完整。恢复材料保留在: ${BACKUP}" >&2
      echo "  （按相对路径存放的原文件；旧安装清单为 ${BACKUP}/${MANIFEST_SAVED_NAME}）" >&2
    else
      echo "安装失败，已回滚本次写入。" >&2
    fi
  fi
  rm -rf "$STAGE"
  [ "$ROLLBACK_FAILED" -eq 1 ] || rm -rf "$BACKUP"
  [ -z "$GUARD_TMP" ] || rm -rf "$GUARD_TMP"
  # Only the temporary manifest this run created (mktemp) is removed.
  [ -z "$MANIFEST_TMP" ] || rm -f "$MANIFEST_TMP"
  [ "$LOCK_HELD" -ne 1 ] || rm -rf "$LOCK_DIR" || echo "⚠ 无法释放安装锁: ${LOCK_DIR}" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage_tree() {
  src=$1
  relative=$2
  [ -d "$src" ] || return 0
  mkdir -p "$STAGE/$relative"
  cp -R "$src/." "$STAGE/$relative/"
}

stage_file() {
  src=$1
  relative=$2
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$STAGE/$relative")"
  cp "$src" "$STAGE/$relative"
}

assert_safe_target() {
  relative=$1
  if [ -L "$DEST" ]; then
    echo "拒绝写入符号链接安装目录: $DEST" >&2
    return 2
  fi
  if [ -e "$DEST" ] && [ ! -d "$DEST" ]; then
    echo "安装目录必须是普通目录: $DEST" >&2
    return 2
  fi

  parent_relative=$(dirname "$relative")
  current=$DEST
  remaining=$parent_relative
  while [ -n "$remaining" ] && [ "$remaining" != "." ]; do
    case "$remaining" in
      */*) component=${remaining%%/*}; remaining=${remaining#*/} ;;
      *) component=$remaining; remaining="" ;;
    esac
    current="$current/$component"
    if [ -L "$current" ]; then
      echo "拒绝写入符号链接父目录: $current" >&2
      return 2
    fi
    if [ -e "$current" ] && [ ! -d "$current" ]; then
      echo "安装目标父路径不是目录: $current" >&2
      return 2
    fi
  done

  target="$DEST/$relative"
  if [ -L "$target" ]; then
    echo "拒绝覆盖符号链接目标: $target" >&2
    return 2
  fi
  if [ -e "$target" ] && [ ! -f "$target" ]; then
    echo "安装目标必须是普通文件: $target" >&2
    return 2
  fi
}

confirm_bundle_conflicts() {
  conflicts=""
  while IFS= read -r relative; do
    [ -n "$relative" ] || continue
    target="$DEST/$relative"
    if ! assert_safe_target "$relative"; then
      return 2
    fi
    [ -e "$target" ] && conflicts="${conflicts}${relative}
"
  done < "$STAGE/.cm-managed-files"
  [ -n "$conflicts" ] || return 0
  echo "⚠ 以下 CM 文件已存在，将作为一个整体更新："
  printf '%s' "$conflicts" | sed '/^$/d; s/^/    /'
  [ "$ASSUME_YES" -eq 1 ] && return 0
  read -r -p "  继续整体更新全部 CM 文件（失败时回滚）？[y/N] " answer
  case "$answer" in
    y|Y) return 0 ;;
    *) echo "安装已取消，未修改现有运行时。"; return 1 ;;
  esac
}

# Stop before any write when a file recorded by the previous install changed.
# --yes only accepts replacing CM files; it never discards hand edits.
# Runs twice: once up front, and again ("recheck") after staging and the
# overwrite prompt, right before the first write, because another session may
# edit an installed file while this one waits for an answer.
guard_local_edits() {
  guard_mode=${1:-initial}
  if ! cm_manifest_select_hasher; then
    echo "未找到 shasum 或 sha256sum，无法核对已安装文件是否被手改；安装已停止，未修改任何文件。" >&2
    return 2
  fi
  if ! assert_safe_target "$INSTALL_MANIFEST_RELATIVE"; then
    return 2
  fi
  if [ ! -e "$INSTALL_MANIFEST" ]; then
    [ "$guard_mode" = recheck ] ||
      echo "ℹ 未找到上次的安装清单（首次安装或旧版本安装），本次不核对手改；安装成功后会生成清单。"
    return 0
  fi
  edits="$GUARD_TMP/local-edits"
  if cm_manifest_find_edits "$DEST" "$INSTALL_MANIFEST" "$edits" "$GUARD_TMP"; then
    :
  else
    find_status=$?
    if [ "$find_status" -ne 3 ]; then
      echo "核对已安装文件失败，安装已停止，未修改任何文件。" >&2
      return 2
    fi
    echo "⚠ 安装清单格式无法识别: ${INSTALL_MANIFEST}" >&2
    if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ]; then
      echo "已指定 --overwrite-local-edits，跳过手改核对并重新生成清单。"
      return 0
    fi
    echo "安装已停止，未修改任何文件。确认要覆盖现有 CM 文件时，加 --overwrite-local-edits 重新运行。" >&2
    return 1
  fi
  [ -s "$edits" ] || return 0
  if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ] && [ "$guard_mode" = recheck ]; then
    return 0
  fi
  echo "⚠ 以下 CM 文件在上次安装后被改动过（与安装清单记录的 sha256 不一致）：" >&2
  sed 's/^/    /' "$edits" >&2
  if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ]; then
    echo "已指定 --overwrite-local-edits，将覆盖以上改动。"
    return 0
  fi
  echo "安装已停止，未修改任何文件。--yes 不会覆盖手改；请先保存或合并这些改动，确认丢弃时加 --overwrite-local-edits 重新运行。" >&2
  return 1
}

copy_file_atomic() {
  src=$1
  dst=$2
  label=$3
  [ -f "$src" ] || return 0
  if [ -e "$dst" ] && [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "⚠ ${label} 已存在，继续覆盖？[y/N] " answer
    case "$answer" in
      y|Y) ;;
      *) echo "  跳过 $label"; return 0 ;;
    esac
  fi
  if ! mkdir -p "$(dirname "$dst")"; then
    return 1
  fi
  tmp="${dst}.tmp.$$"
  if ! cp "$src" "$tmp" || ! chmod +x "$tmp" || ! mv -f "$tmp" "$dst"; then
    rm -f "$tmp"
    return 1
  fi
  echo "✓ ${label} 已安装"
}

echo "CM Workflow Claude Code 兼容安装  v$VERSION"
echo "  来源: $SRC_DIR"
echo "  目标: $DEST"
echo

mkdir -p "$DEST_PARENT"
cm_defer_signals
if cm_install_lock_acquire "$LOCK_DIR"; then
  LOCK_HELD=1
  cm_install_test_hook lock-acquired
  cm_install_lock_write_owner "$LOCK_DIR" "$DEST"
fi
cm_resume_signals
if [ "$LOCK_HELD" -eq 1 ]; then
  :
elif [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
  echo "无法创建安装锁: ${LOCK_DIR}；安装已停止，未修改任何文件。" >&2
  exit 2
else
  lock_pid=$(cm_install_lock_field "$LOCK_DIR" pid)
  lock_started=$(cm_install_lock_field "$LOCK_DIR" started)
  lock_state=$(cm_install_lock_pid_state "$lock_pid")
  echo "⚠ 另一个 CM 安装正在写同一目标，本次已停止，未修改任何文件。" >&2
  echo "    锁: ${LOCK_DIR}" >&2
  echo "    持有进程: ${lock_pid:-未知}（开始于 ${lock_started:-未知}）" >&2
  case "$lock_state" in
    alive) echo "    该进程仍在运行；等它结束后重试。" >&2 ;;
    not-running) echo "    该进程已不在运行，锁可能是中断遗留。确认没有安装在进行后，手动清理再重试：" >&2
      echo "    rm -rf $(cm_install_quote "$LOCK_DIR")" >&2 ;;
    *) echo "    无法判断持有进程是否还在；确认没有安装在进行后，手动清理再重试：" >&2
      echo "    rm -rf $(cm_install_quote "$LOCK_DIR")" >&2 ;;
  esac
  exit 4
fi
GUARD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cm-install-guard.XXXXXX")"
WRITTEN_LIST="$GUARD_TMP/written-files"
: > "$WRITTEN_LIST"
if guard_local_edits; then
  :
else
  guard_status=$?
  [ "$guard_status" -eq 1 ] && exit 3
  exit "$guard_status"
fi

mkdir -p "$STAGE"
for part in skills agents runtime scripts compat; do
  stage_tree "$SRC_DIR/$part" "$part"
done
stage_tree "$SRC_DIR/docs" "cm-workflow/docs"
stage_tree "$SRC_DIR/assets" "cm-workflow/assets"
stage_file "$SRC_DIR/README.md" "cm-workflow/README.md"

for wrapper in "$SRC_DIR"/compat/claude-commands/cm-*.md; do
  name="$(basename "$wrapper" .md)"
  verb="${name#cm-}"
  stage_file "$wrapper" "commands/cm:${verb}.md"
done

stage_tree "$SRC_DIR/templates/rules" "templates/rules"
stage_tree "$SRC_DIR/templates/rules" "templates/cm-rules"
stage_file "$SRC_DIR/templates/arch-reference.md" "templates/arch-reference.md"
stage_file "$SRC_DIR/templates/cm-workflow.yml" "templates/cm-workflow.yml"
stage_tree "$SRC_DIR/templates/dashboard" "templates/dashboard"
stage_tree "$SRC_DIR/templates/dashboard" "templates/cm-dashboard"
stage_tree "$SRC_DIR/templates/pixel" "templates/pixel"
stage_tree "$SRC_DIR/templates/pixel" "templates/cm-pixel"
stage_tree "$SRC_DIR/templates/hooks" "templates/hooks"
stage_tree "$SRC_DIR/templates/refactor" "templates/refactor"
stage_tree "$SRC_DIR/templates/ui-lens" "templates/ui-lens"
stage_file "$SRC_DIR/templates/statusline/cm-statusline.sh" "templates/cm-statusline.sh"
stage_file "$SRC_DIR/templates/hooks/pre-commit-cm-task-check" "templates/cm-task-check-hook"
stage_file "$SRC_DIR/templates/refactor/cm-refactor-denies.json" "templates/cm-refactor-denies.json"
stage_file "$SRC_DIR/templates/ui-lens/cm-ui-lens-extract.mjs" "templates/cm-ui-lens-extract.mjs"
printf '%s\n' "$VERSION" > "$STAGE/templates/cm-VERSION"

for executable in \
  "$STAGE/scripts/cm-check-runtime.sh" \
  "$STAGE/templates/cm-statusline.sh" \
  "$STAGE/templates/cm-task-check-hook" \
  "$STAGE/templates/hooks/pre-commit-cm-task-check" \
  "$STAGE/templates/dashboard/serve.sh" \
  "$STAGE/templates/cm-dashboard/serve.sh" \
  "$STAGE/templates/pixel/cm-pixel.sh" \
  "$STAGE/templates/pixel/serve.sh" \
  "$STAGE/templates/cm-pixel/cm-pixel.sh" \
  "$STAGE/templates/cm-pixel/serve.sh"; do
  [ -f "$executable" ] && chmod +x "$executable"
done

(cd "$STAGE" && find . -type f ! -name .cm-managed-files | sed 's#^\./##' | sort) \
  > "$STAGE/.cm-managed-files"
if ! cm_manifest_write "$STAGE" "$STAGE/.cm-managed-files" "$GUARD_TMP/new-manifest"; then
  echo "生成安装清单失败，安装已停止，未修改任何文件。" >&2
  exit 1
fi

if confirm_bundle_conflicts; then
  :
else
  conflict_status=$?
  [ "$conflict_status" -eq 1 ] && exit 0
  exit "$conflict_status"
fi

mkdir -p "$BACKUP"
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  if ! assert_safe_target "$relative"; then
    echo "安装目标在确认后发生结构变化，安装已停止，未修改任何文件。" >&2
    exit 3
  fi
  if [ -f "$DEST/$relative" ]; then
    mkdir -p "$(dirname "$BACKUP/$relative")"
    cp -p "$DEST/$relative" "$BACKUP/$relative"
  fi
done < "$STAGE/.cm-managed-files"
if [ -f "$INSTALL_MANIFEST" ] && [ ! -L "$INSTALL_MANIFEST" ]; then
  cp -p "$INSTALL_MANIFEST" "$BACKUP/$MANIFEST_SAVED_NAME"
fi

# Second check, just before the first write to the real target.
if guard_local_edits recheck; then
  :
else
  guard_status=$?
  [ "$guard_status" -eq 1 ] && exit 3
  exit "$guard_status"
fi
# Freeze the manifest the recheck just accepted for the per-file checks below.
if [ "$OVERWRITE_LOCAL_EDITS" -ne 1 ] && [ -f "$INSTALL_MANIFEST" ]; then
  VERIFIED_MANIFEST="$GUARD_TMP/verified-manifest"
  cp "$INSTALL_MANIFEST" "$VERIFIED_MANIFEST"
  if ! cm_manifest_validate "$VERIFIED_MANIFEST"; then
    echo "⚠ 安装清单在核对后发生变化，安装已停止，未修改任何文件。" >&2
    exit 3
  fi
fi

# Narrow the check-to-write window to a single file: right before each copy,
# compare the file's current sha256 with the previous manifest. This cannot be
# atomic; do not edit installed CM files while an install is running.
# CM_INSTALL_TEST_HOOK is for the repository's tests only (unset by default):
# it runs as `$CM_INSTALL_TEST_HOOK before-copy <relative>` before each file.
mkdir -p "$DEST"
DEST_TOUCHED=1
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  cm_install_test_hook before-copy "$relative"
  # Type and parent path first: never write through a symlink or into a
  # directory that replaced a file after the earlier checks.
  if ! assert_safe_target "$relative"; then
    echo "⚠ 安装过程中 ${relative} 的路径类型发生变化，已停止并回滚已写入的文件；该路径保持原样。" >&2
    exit 3
  fi
  if [ -n "$VERIFIED_MANIFEST" ] && [ -f "$DEST/$relative" ]; then
    recorded=$(cm_manifest_recorded_hash "$VERIFIED_MANIFEST" "$relative")
    if [ -n "$recorded" ]; then
      current=$(cm_manifest_file_hash "$DEST/$relative")
      if [ "$current" != "$recorded" ]; then
        echo "⚠ 安装过程中 ${relative} 被改动（与安装清单记录的 sha256 不一致），已停止并回滚已写入的文件；该文件保持原样。" >&2
        echo "  确认丢弃这个改动时，加 --overwrite-local-edits 重新运行。" >&2
        exit 3
      fi
    fi
  fi
  printf '%s\n' "$relative" >> "$WRITTEN_LIST"
  mkdir -p "$(dirname "$DEST/$relative")"
  cp -p "$STAGE/$relative" "$DEST/$relative"
done < "$STAGE/.cm-managed-files"

"$DEST/scripts/cm-check-runtime.sh" --project "$SRC_DIR"
mkdir -p "$(dirname "$INSTALL_MANIFEST")"
if ! assert_safe_target "$INSTALL_MANIFEST_RELATIVE"; then
  echo "安装清单路径类型发生变化，已停止并回滚。" >&2
  exit 3
fi
# The temporary manifest is created exclusively by mktemp under a random name
# in the checked directory; cleanup removes only this file.
cm_defer_signals
MANIFEST_TMP=$(cm_run_shielded mktemp "$(dirname "$INSTALL_MANIFEST")/.install-manifest.XXXXXX")
cm_resume_signals
cp "$GUARD_TMP/new-manifest" "$MANIFEST_TMP"
chmod 644 "$MANIFEST_TMP"
cm_install_test_hook before-manifest-publish
MANIFEST_PUBLISHED=1
mv -f "$MANIFEST_TMP" "$INSTALL_MANIFEST"
MANIFEST_TMP=""
cm_install_test_hook after-manifest-publish
INSTALL_COMPLETE=1
echo "✓ 安装清单已写入: ${INSTALL_MANIFEST}"

# User runtimes.yml: only after the verified core install, before updater prompts.
if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ] && [ -t 1 ]; then
  node "$DEST/scripts/cm-runtime-install.mjs"
fi

copy_file_atomic "$SRC_DIR/templates/auto-update/cm-update.sh" "$HOME/.cm-workflow/cm-update.sh" "~/.cm-workflow/cm-update.sh" ||
  echo "⚠ 可选更新器安装跳过: ~/.cm-workflow/cm-update.sh" >&2
copy_file_atomic "$SRC_DIR/templates/auto-update/cm-announce.sh" "$HOME/.cm-workflow/cm-announce.sh" "~/.cm-workflow/cm-announce.sh" ||
  echo "⚠ 可选更新器安装跳过: ~/.cm-workflow/cm-announce.sh" >&2

echo
echo "完成（已安装版本: v${VERSION}）。"
echo "建议在 Claude Code 中运行 /cm-check 校验；macOS/Linux 也保留 /cm:check 别名。"
echo "使用手册: $DEST/cm-workflow/docs/user-guide.md"
# 播报 hook 的实际状态由脚本判断后再说话：此前这行无条件打印，对已启用的人是错的，
# 对未启用的人又读着像普通说明，两边都没起作用。仅在交互安装时询问，且只加播报 hook。
if [ -x "$DEST/scripts/cm-announce-hook.mjs" ] || [ -f "$DEST/scripts/cm-announce-hook.mjs" ]; then
  if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ] && [ -t 1 ]; then
    node "$DEST/scripts/cm-announce-hook.mjs" || true
  else
    CM_NONINTERACTIVE=1 node "$DEST/scripts/cm-announce-hook.mjs" </dev/null || true
  fi
else
  echo "自动更新器未自动启用；按 docs/installation.md 手工配置 SessionStart hook。"
fi
echo "后台自动升级仍需另行开启，见 docs/installation.md。"
