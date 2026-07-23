#!/usr/bin/env bash
# cm-workflow 自动更新：检测上游有新提交则拉取并安装
# 用法: cm-update.sh [--throttle] [--force] [--check]
# 分发源: cm-workflow 仓库 templates/auto-update/（本文件由 install.sh 装到 ~/.cm-workflow/,
#         更新自己时经 tmp+mv 原子替换,不会截断正在运行的实例）
set -uo pipefail

ROOT="$HOME/.cm-workflow"
REPO="$ROOT/repo"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
MANIFEST="$ROOT/manifest.txt"
LOG="$ROOT/update.log"
STAMP="$ROOT/.last-check"
LOCK="$ROOT/.lock"
ANNOUNCE="$ROOT/pending-announce"   # 下次 Claude Code 启动时播报，由 cm-announce.sh 消费
REMOTE="${CM_UPDATE_REMOTE:-git@github.com:kingxiaozhe/cm-workflow.git}"   # 团队 fork 用环境变量覆盖,别改文件(会被自愈还原)
BRANCH="${CM_UPDATE_BRANCH:-main}"
THROTTLE_SECS=900   # --throttle 模式下两次 fetch 的最小间隔

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"

mkdir -p "$ROOT"

log()    { printf '%s  %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true; }
die()    { log "✗ $*"; exit 1; }

THROTTLE=0; FORCE=0; CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --throttle) THROTTLE=1 ;;
    --force)    FORCE=1 ;;
    --check)    CHECK_ONLY=1 ;;
  esac
done

# ---- 单实例锁（mkdir 原子；超过 30 分钟视为陈旧锁）----
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null || exit 0
    log "清除陈旧锁"
  else
    exit 0   # 另一个实例在跑
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---- 限流：启动 hook 频繁触发时避免每次都连网 ----
if [ "$THROTTLE" = 1 ] && [ "$FORCE" = 0 ] && [ -f "$STAMP" ]; then
  if [ -z "$(find "$STAMP" -maxdepth 0 -mmin +$((THROTTLE_SECS / 60)) 2>/dev/null)" ]; then
    exit 0
  fi
fi

# ---- 首次运行：clone ----
if [ ! -d "$REPO/.git" ]; then
  log "首次克隆 $REMOTE"
  rm -rf "$REPO"
  git clone --quiet "$REMOTE" "$REPO" || die "克隆失败（检查 SSH 凭证）"
fi

cd "$REPO" || die "仓库目录不可用: $REPO"

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG"; then
  log "fetch 失败（离线或凭证问题），本次跳过"
  exit 0
fi
touch "$STAMP"

local_sha="$(git rev-parse HEAD 2>/dev/null)"
remote_sha="$(git rev-parse "origin/$BRANCH" 2>/dev/null)"

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$local_sha" = "$remote_sha" ]; then
    echo "已是最新: $(cat "$DEST/templates/cm-VERSION" 2>/dev/null) ($(git rev-parse --short HEAD))"
  else
    echo "有更新: $(git rev-parse --short HEAD) → $(git rev-parse --short "origin/$BRANCH")"
    git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/  /'
  fi
  exit 0
fi

# ---- 运行中工作流保护：/cm-ai 正在跑时不换安装文件（中途换版 = 混装风险）----
# 实证事故：2026-07-17 10:06 自动更新 v0.9.27 恰逢 diff-lens 运行中(10:04–10:17)，
# 节点文件被中途替换。状态新鲜(30分钟内有写入)才算真在跑；僵死的 running 不拦更新。
PTR="$HOME/.claude/cm-current-specs"
if [ -f "$PTR" ]; then
  ACTIVE_SPECS="$(head -1 "$PTR" 2>/dev/null | tr -d '[:space:]')"
  ACTIVE_ST="$ACTIVE_SPECS/.cm-status.json"
  if [ -n "$ACTIVE_SPECS" ] && [ -f "$ACTIVE_ST" ] \
     && grep -q '"state":"running"' "$ACTIVE_ST" 2>/dev/null \
     && [ -n "$(find "$ACTIVE_ST" -maxdepth 0 -mmin -30 2>/dev/null)" ]; then
    log "工作流运行中($ACTIVE_SPECS)，本轮跳过安装，避免中途换版"
    exit 0
  fi
fi

# ---- 源文件 ↔ 安装目标 的配对（必须与 install.sh 的拷贝映射一致）----
# 输出 "源路径<TAB>目标路径"。安装清单和完整性校验都基于它，只此一份映射。
TAB="$(printf '\t')"
build_pairs() {
  local part
  for part in commands skills agents runtime scripts; do
    if [ -d "$REPO/$part" ]; then
      ( cd "$REPO/$part" && find . -type f ) \
        | sed "s|^\./\(.*\)$|$REPO/$part/\1$TAB$DEST/$part/\1|"
    fi
  done
  if [ -d "$REPO/templates/rules" ]; then
    ( cd "$REPO/templates/rules" && find . -type f ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/rules/\1$TAB$DEST/templates/rules/\1|"
    ( cd "$REPO/templates/rules" && find . -type f ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/rules/\1$TAB$DEST/templates/cm-rules/\1|"
  fi
  if [ -f "$REPO/templates/arch-reference.md" ]; then
    echo "$REPO/templates/arch-reference.md$TAB$DEST/templates/arch-reference.md"
  fi
  if [ -d "$REPO/templates/dashboard" ]; then
    ( cd "$REPO/templates/dashboard" && find . -type f ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/dashboard/\1$TAB$DEST/templates/dashboard/\1|"
    ( cd "$REPO/templates/dashboard" && find . -type f ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/dashboard/\1$TAB$DEST/templates/cm-dashboard/\1|"
  fi
  if [ -f "$REPO/templates/statusline/cm-statusline.sh" ]; then
    echo "$REPO/templates/statusline/cm-statusline.sh$TAB$DEST/templates/cm-statusline.sh"
  fi
  if [ -d "$REPO/templates/pixel" ]; then
    ( cd "$REPO/templates/pixel" && find . -type f -not -path './dev/*' ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/pixel/\1$TAB$DEST/templates/pixel/\1|"
    ( cd "$REPO/templates/pixel" && find . -type f -not -path './dev/*' ) \
      | sed "s|^\./\(.*\)$|$REPO/templates/pixel/\1$TAB$DEST/templates/cm-pixel/\1|"
  fi
  if [ -f "$REPO/templates/hooks/pre-commit-cm-task-check" ]; then
    echo "$REPO/templates/hooks/pre-commit-cm-task-check$TAB$DEST/templates/hooks/pre-commit-cm-task-check"
    echo "$REPO/templates/hooks/pre-commit-cm-task-check$TAB$DEST/templates/cm-task-check-hook"
  fi
  if [ -f "$REPO/templates/ui-lens/cm-ui-lens-extract.mjs" ]; then
    echo "$REPO/templates/ui-lens/cm-ui-lens-extract.mjs$TAB$DEST/templates/ui-lens/cm-ui-lens-extract.mjs"
    echo "$REPO/templates/ui-lens/cm-ui-lens-extract.mjs$TAB$DEST/templates/cm-ui-lens-extract.mjs"
  fi
  if [ -f "$REPO/templates/refactor/cm-refactor-denies.json" ]; then
    echo "$REPO/templates/refactor/cm-refactor-denies.json$TAB$DEST/templates/refactor/cm-refactor-denies.json"
    echo "$REPO/templates/refactor/cm-refactor-denies.json$TAB$DEST/templates/cm-refactor-denies.json"
  fi
  # 更新器自身也纳入校验与自愈（安装走 tmp+mv 原子替换；清理循环有 $DEST 前缀守卫,不会误删这里）
  if [ -d "$REPO/templates/auto-update" ]; then
    echo "$REPO/templates/auto-update/cm-update.sh$TAB$ROOT/cm-update.sh"
    echo "$REPO/templates/auto-update/cm-announce.sh$TAB$ROOT/cm-announce.sh"
  fi
  # cm-VERSION 由 install.sh 从 VERSION 生成，内容与之逐字节相同，故可直接配对校验
  echo "$REPO/VERSION$TAB$DEST/templates/cm-VERSION"
}

build_manifest() { build_pairs | cut -d"$TAB" -f2; }

# 校验已装文件是否仍与仓库一致；输出漂移清单（空 = 一切正常）
verify_install() {
  build_pairs | while IFS="$TAB" read -r src dest; do
    if [ ! -e "$dest" ]; then
      echo "缺失 ${dest#$DEST/}"
    elif ! cmp -s "$src" "$dest"; then
      echo "被改动 ${dest#$DEST/}"
    fi
  done
}

# ---- 无新提交时：校验完整性，只有被改坏/误删才自愈重装 ----
REPAIR=0
if [ "$local_sha" = "$remote_sha" ] && [ -f "$MANIFEST" ] && [ "$FORCE" = 0 ]; then
  drift="$(verify_install)"
  if [ -z "$drift" ]; then
    exit 0   # 无更新且文件完好，静默退出
  fi
  REPAIR=1
  drift_n="$(echo "$drift" | wc -l | tr -d ' ')"
  log "无新提交，但 $drift_n 个文件与仓库不一致，自愈重装："
  log "$(echo "$drift" | sed 's|^|    |')"
fi

new_commits="$(git log --oneline "HEAD..origin/$BRANCH" 2>/dev/null | head -5)"
git reset --hard --quiet "origin/$BRANCH" || die "reset 到 origin/$BRANCH 失败"
git clean -qfd
VERSION="$(cat "$REPO/VERSION" 2>/dev/null || echo 未知)"
if [ "$REPAIR" = 0 ]; then
  log "发现更新 ${local_sha:0:7} → ${remote_sha:0:7} (v$VERSION)"
  [ -n "$new_commits" ] && log "$(echo "$new_commits" | sed 's/^/    /')"
fi

NEW_MANIFEST="$(mktemp)"
build_manifest | sort -u >"$NEW_MANIFEST"
[ -s "$NEW_MANIFEST" ] || { rm -f "$NEW_MANIFEST"; die "清单为空，中止安装（仓库结构异常？）"; }

# ---- 清理：只删“上一版装过、这一版没有”的文件，绝不碰清单外的东西 ----
removed=0
if [ -f "$MANIFEST" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in "$DEST"/*) ;; *) continue ;; esac   # 安全网：只删 ~/.claude 内
    if [ -e "$f" ]; then
      rm -f "$f" && removed=$((removed + 1)) && log "  - 删除 ${f#$DEST/}"
    fi
  done < <(comm -23 <(sort -u "$MANIFEST") "$NEW_MANIFEST")
fi

# ---- 安装（yes 应答 install.sh 的覆盖确认，避免无人值守卡住）----
# 两处规避，别随手改掉：
#  1) 关 pipefail：install.sh 结束后 yes 会吃到 SIGPIPE(141)，否则被误判为失败
#  2) LC_ALL=C：老版本 install.sh 里 "$part？" 这类写法，在 UTF-8 locale + bash 3.2 下
#     会把全角字符并进变量名，触发 set -u 报错。上游 v0.9.21 (eade178) 已改用 ${part}，
#     这里保留纯属防御：万一回滚到旧提交，或哪天又写回这种形式，更新链路不至于断掉。
set +o pipefail
install_out="$(yes | LC_ALL=C LANG=C bash "$REPO/install.sh" 2>&1)"
install_rc=$?
set -o pipefail
if [ $install_rc -ne 0 ]; then
  log "✗ install.sh 失败 (rc=$install_rc)"
  log "$(echo "$install_out" | tail -15 | sed 's/^/    /')"
  rm -f "$NEW_MANIFEST"
  notify "cm-workflow 更新失败" "install.sh 报错，详见 ~/.cm-workflow/update.log"
  exit 1
fi

mv "$NEW_MANIFEST" "$MANIFEST"

# 清掉清理后可能残留的空目录
find "$DEST/skills" "$DEST/commands" "$DEST/agents" "$DEST/templates" -type d -empty -delete 2>/dev/null || true

installed="$(cat "$DEST/templates/cm-VERSION" 2>/dev/null || echo "$VERSION")"
if [ "$REPAIR" = 1 ]; then
  log "✓ 自愈完成，已恢复到 v$installed (${remote_sha:0:7})"
else
  log "✓ 已更新到 v$installed (${remote_sha:0:7})，清理 $removed 个旧文件"
fi

# 播报走两条路，互不依赖：
#  1) 待播报文件 → 下次 Claude Code 启动时由 cm-announce.sh 报出来。这是主路径：
#     更新本来就要重开 Claude Code 才生效，在启动时说时机正好，且不看系统权限脸色。
#  2) macOS 通知 → 锦上添花。本机 osascript 未在通知中心注册，实测弹不出来，
#     所以绝不能依赖它；哪天授权了会自己开始工作。
if [ "$REPAIR" = 1 ]; then
  {
    echo "cm-workflow 检测到 $drift_n 个文件被改动或误删，已从仓库恢复（v${installed}）："
    echo "$drift" | sed 's/^/  /'
  } >"$ANNOUNCE"
  notify "cm-workflow 已自愈 $drift_n 个文件" "恢复到 v$installed"
else
  {
    echo "cm-workflow 已更新到 v${installed}（${local_sha:0:7} → ${remote_sha:0:7}）"
    [ "$removed" -gt 0 ] && echo "清理了 $removed 个上游已删除的旧文件。"
    [ -n "$new_commits" ] && { echo "新提交："; echo "$new_commits" | sed 's/^/  /'; }
  } >"$ANNOUNCE"
  notify "cm-workflow 已更新到 v$installed" "$( [ "$removed" -gt 0 ] && echo "清理 $removed 个旧文件；" )重开 Claude Code 生效"
fi
