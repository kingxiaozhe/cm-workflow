param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

# PowerShell entry for the shared CM runtime check.
# Native Claude Code on Windows relies on Git for Windows, so prefer its Bash.
$ErrorActionPreference = "Stop"
$CheckScript = Join-Path $PSScriptRoot "cm-check-runtime.sh"

if (-not (Test-Path $CheckScript -PathType Leaf)) {
    Write-Error "CM runtime checker not found: $CheckScript"
    exit 1
}

$Bash = $null
if ($env:CLAUDE_CODE_GIT_BASH_PATH -and
    (Test-Path $env:CLAUDE_CODE_GIT_BASH_PATH -PathType Leaf)) {
    $Bash = $env:CLAUDE_CODE_GIT_BASH_PATH
}

if (-not $Bash) {
    $Candidates = @()
    if ($env:ProgramFiles) {
        $Candidates += (Join-Path $env:ProgramFiles "Git\bin\bash.exe")
    }
    if (${env:ProgramFiles(x86)}) {
        $Candidates += (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe")
    }
    $GitCommand = Get-Command "git.exe" -ErrorAction SilentlyContinue
    if ($GitCommand -and $GitCommand.Path) {
        $GitRoot = Split-Path (Split-Path $GitCommand.Path -Parent) -Parent
        $Candidates += (Join-Path $GitRoot "bin\bash.exe")
    }
    foreach ($Candidate in $Candidates) {
        if (Test-Path $Candidate -PathType Leaf) {
            $Bash = $Candidate
            break
        }
    }
}

if (-not $Bash) {
    foreach ($Name in @("bash.exe", "bash")) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command) {
            $CommandPath = if ($Command.Path) { $Command.Path } else { $Command.Source }
            # Windows' System32 bash.exe is the WSL launcher. It cannot consume
            # the C:/ path passed below, so do not mistake it for Git Bash.
            if ($CommandPath -and $CommandPath -notmatch "\\Windows\\System32\\bash\.exe$") {
                $Bash = $CommandPath
                break
            }
        }
    }
}

if (-not $Bash) {
    Write-Error @"
CM Workflow needs Bash for its shared runtime check.
Install Git for Windows, set CLAUDE_CODE_GIT_BASH_PATH, or run
scripts/cm-check-runtime.sh inside WSL.
"@
    exit 1
}

$CheckScriptArg = $CheckScript -replace "\\", "/"
& $Bash $CheckScriptArg @RemainingArgs
exit $LASTEXITCODE
