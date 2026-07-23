param(
    [switch]$Force
)

# CM Workflow Claude Code compatibility installer for Windows.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-Force]
$ErrorActionPreference = "Stop"

$Src  = $PSScriptRoot
$Dest = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $env:USERPROFILE ".claude" }
$Version = if (Test-Path "$Src\VERSION") { (Get-Content "$Src\VERSION" -Raw).Trim() } else { "未知" }

Write-Host "cm 工作流安装  v$Version"
Write-Host "  来源: $Src"
Write-Host "  目标: $Dest`n"

function Copy-TreeSafely {
    param([string]$Source, [string]$Target, [string]$Label)

    if (-not (Test-Path $Source)) {
        Write-Host "跳过 $Label（源目录不存在）"
        return
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    $conflicts = @()
    foreach ($file in Get-ChildItem $Source -Recurse -File) {
        $relative = $file.FullName.Substring($Source.Length).TrimStart([char[]]"\/")
        $candidate = Join-Path $Target $relative
        if (Test-Path $candidate) { $conflicts += $relative }
    }

    if ($conflicts.Count -gt 0 -and -not $Force) {
        Write-Host "⚠ $Label 下以下文件已存在，将被覆盖："
        $conflicts | ForEach-Object { Write-Host "    $_" }
        $answer = Read-Host "继续覆盖 $Label？[y/N]"
        if ($answer -notin @("y", "Y")) {
            Write-Host "跳过 $Label"
            return
        }
    }

    Copy-Item "$Source\*" $Target -Recurse -Force
    $count = (Get-ChildItem $Source -Recurse -File).Count
    Write-Host "√ $Label 已安装（$count 个文件）"
}

function Copy-FileSafely {
    param([string]$Source, [string]$Target, [string]$Label)

    if (-not (Test-Path $Source)) { return }
    if ((Test-Path $Target) -and -not $Force) {
        $answer = Read-Host "⚠ $Label 已存在，继续覆盖？[y/N]"
        if ($answer -notin @("y", "Y")) {
            Write-Host "跳过 $Label"
            return
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
    Copy-Item $Source $Target -Force
    Write-Host "√ $Label 已安装"
}

foreach ($part in "skills", "agents", "runtime", "scripts", "compat") {
    Copy-TreeSafely (Join-Path $Src $part) (Join-Path $Dest $part) $part
}

$tpl = Join-Path $Dest "templates"
New-Item -ItemType Directory -Force -Path $tpl | Out-Null
foreach ($pair in @(@("dashboard", "dashboard"), @("dashboard", "cm-dashboard"), @("pixel", "pixel"), @("pixel", "cm-pixel"))) {
    Copy-TreeSafely (Join-Path $Src "templates\$($pair[0])") (Join-Path $tpl $pair[1]) "templates/$($pair[1])"
}
foreach ($part in "rules", "hooks", "refactor", "ui-lens") {
    Copy-TreeSafely (Join-Path $Src "templates\$part") (Join-Path $tpl $part) "templates/$part"
}
Copy-TreeSafely (Join-Path $Src "templates\rules") (Join-Path $tpl "cm-rules") "templates/cm-rules"

Copy-FileSafely "$Src\templates\arch-reference.md" "$tpl\arch-reference.md" "templates/arch-reference.md"
Copy-FileSafely "$Src\templates\statusline\cm-statusline.sh" "$tpl\cm-statusline.sh" "templates/cm-statusline.sh"
Set-Content -Path "$tpl\cm-VERSION" -Value $Version

Write-Host "`n完成（已安装版本: v$Version）。请在 Claude Code 中运行 /cm-check 校验。"
Write-Host @"

Windows 注意事项:
  · 核心工作流(skills/agents/runtime)是纯 Markdown,Windows 原生可用,无额外依赖
  · 状态条 / 终端像素版 / 看板与像素 serve.sh 是 bash+python3 脚本:
      - 推荐在 WSL 或 Git Bash 中使用(Claude Code 终端选 Git Bash 即可)
      - 浏览器像素版页面本身(cm-pixel.html)双击即可打开看 ?demo,只有实时跟踪需要 serve.sh
"@
