param(
    [switch]$Force
)

# CM Workflow Claude Code compatibility installer for Windows.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-Force]
$ErrorActionPreference = "Stop"

$Src = $PSScriptRoot
$Dest = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $env:USERPROFILE ".claude" }
$DestParent = Split-Path $Dest -Parent
$Version = if (Test-Path "$Src\VERSION") { (Get-Content "$Src\VERSION" -Raw).Trim() } else { "未知" }
$Stage = Join-Path $DestParent ".cm-claude.stage.$PID"
$Backup = Join-Path $DestParent ".cm-claude.backup.$PID"
$InstallComplete = $false
$DestTouched = $false
$ManagedFiles = @()

function Stage-Tree {
    param([string]$Source, [string]$Relative)
    if (-not (Test-Path $Source -PathType Container)) { return }
    $target = Join-Path $Stage $Relative
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $target -Recurse -Force
}

function Stage-File {
    param([string]$Source, [string]$Relative)
    if (-not (Test-Path $Source -PathType Leaf)) { return }
    $target = Join-Path $Stage $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $target -Force
}

function Restore-Install {
    foreach ($relative in $ManagedFiles) {
        $target = Join-Path $Dest $relative
        $saved = Join-Path $Backup $relative
        if (Test-Path $saved -PathType Leaf) {
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -LiteralPath $saved -Destination $target -Force
        } elseif (Test-Path $target -PathType Leaf) {
            Remove-Item -LiteralPath $target -Force
        }
    }
}

function Assert-SafeTarget {
    param([string]$Relative)

    if (Test-Path -LiteralPath $Dest) {
        $destItem = Get-Item -LiteralPath $Dest -Force
        if ($destItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "拒绝写入重解析点/符号链接安装目录: $Dest"
        }
        if (-not $destItem.PSIsContainer) {
            throw "安装目录必须是普通目录: $Dest"
        }
    }

    $parentRelative = Split-Path $Relative -Parent
    $current = $Dest
    if ($parentRelative) {
        foreach ($component in ($parentRelative -split '[\\/]+')) {
            if (-not $component) { continue }
            $current = Join-Path $current $component
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "拒绝写入重解析点/符号链接父目录: $current"
                }
                if (-not $item.PSIsContainer) {
                    throw "安装目标父路径不是目录: $current"
                }
            }
        }
    }

    $target = Join-Path $Dest $Relative
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "拒绝覆盖重解析点/符号链接目标: $target"
        }
        if ($item.PSIsContainer) {
            throw "安装目标必须是普通文件: $target"
        }
    }
}

Write-Host "CM Workflow Claude Code 兼容安装  v$Version"
Write-Host "  来源: $Src"
Write-Host "  目标: $Dest`n"

New-Item -ItemType Directory -Force -Path $DestParent, $Stage | Out-Null

try {
    foreach ($part in "skills", "agents", "runtime", "scripts", "compat") {
        Stage-Tree (Join-Path $Src $part) $part
    }
    Stage-Tree (Join-Path $Src "docs") "cm-workflow\docs"
    Stage-Tree (Join-Path $Src "assets") "cm-workflow\assets"
    Stage-File (Join-Path $Src "README.md") "cm-workflow\README.md"

    foreach ($pair in @(
        @("dashboard", "dashboard"),
        @("dashboard", "cm-dashboard"),
        @("pixel", "pixel"),
        @("pixel", "cm-pixel"),
        @("rules", "rules"),
        @("rules", "cm-rules"),
        @("hooks", "hooks"),
        @("refactor", "refactor"),
        @("ui-lens", "ui-lens")
    )) {
        Stage-Tree (Join-Path $Src "templates\$($pair[0])") "templates\$($pair[1])"
    }
    Stage-File "$Src\templates\arch-reference.md" "templates\arch-reference.md"
    Stage-File "$Src\templates\cm-workflow.yml" "templates\cm-workflow.yml"
    Stage-File "$Src\templates\statusline\cm-statusline.sh" "templates\cm-statusline.sh"
    Stage-File "$Src\templates\hooks\pre-commit-cm-task-check" "templates\cm-task-check-hook"
    Stage-File "$Src\templates\refactor\cm-refactor-denies.json" "templates\cm-refactor-denies.json"
    Stage-File "$Src\templates\ui-lens\cm-ui-lens-extract.mjs" "templates\cm-ui-lens-extract.mjs"
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "templates") | Out-Null
    Set-Content -Path (Join-Path $Stage "templates\cm-VERSION") -Value $Version

    $ManagedFiles = @(
        Get-ChildItem $Stage -Recurse -File -Force | ForEach-Object {
            $_.FullName.Substring($Stage.Length).TrimStart([char[]]"\/")
        } | Sort-Object
    )
    $Conflicts = @()
    foreach ($relative in $ManagedFiles) {
        Assert-SafeTarget $relative
        $target = Join-Path $Dest $relative
        if (Test-Path $target) {
            $Conflicts += $relative
        }
    }
    if ($Conflicts.Count -gt 0 -and -not $Force) {
        Write-Host "⚠ 以下 CM 文件已存在，将作为一个整体更新："
        $Conflicts | ForEach-Object { Write-Host "    $_" }
        $answer = Read-Host "继续原子更新全部 CM 文件？[y/N]"
        if ($answer -notin @("y", "Y")) {
            Write-Host "安装已取消，未修改现有运行时。"
            return
        }
    }

    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    foreach ($relative in $ManagedFiles) {
        $target = Join-Path $Dest $relative
        if (Test-Path $target -PathType Leaf) {
            $saved = Join-Path $Backup $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent) | Out-Null
            Copy-Item -LiteralPath $target -Destination $saved -Force
        }
    }

    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $DestTouched = $true
    foreach ($relative in $ManagedFiles) {
        $source = Join-Path $Stage $relative
        $target = Join-Path $Dest $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }

    & (Join-Path $Dest "scripts\cm-check-runtime.ps1") --project $Src
    if ($LASTEXITCODE -ne 0) {
        throw "CM Workflow 安装后自检失败（退出码 $LASTEXITCODE）"
    }
    $InstallComplete = $true
} catch {
    if ($DestTouched -and -not $InstallComplete) {
        Restore-Install
        Write-Error "安装失败，已回滚本次写入。$($_.Exception.Message)"
    }
    throw
} finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
}

if ($InstallComplete) {
    Write-Host "`n完成（已安装版本: v$Version）。请在 Claude Code 中运行 /cm-check 校验。"
    Write-Host "使用手册: $(Join-Path $Dest 'cm-workflow\docs\user-guide.md')"
    Write-Host @"

Windows 注意事项:
  · 核心工作流是 Markdown；/cm-check 通过 Git for Windows 的 Bash 执行共享自检
  · 也可在 WSL 内直接运行 scripts/cm-check-runtime.sh
  · 状态条 / 终端像素版 / 看板与像素 serve.sh 是 bash+python3 脚本:
      - 推荐在 WSL 或 Git Bash 中使用(Claude Code 终端选 Git Bash 即可)
      - 浏览器像素版页面本身(cm-pixel.html)双击即可打开看 ?demo,只有实时跟踪需要 serve.sh
"@
}
