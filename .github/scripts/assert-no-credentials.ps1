# The credential guard, run twice around the install: once before anything reaches the network,
# and once after.
#
# One script, two invocations, so the two cannot drift apart. The pre-install run is the one
# that matters: `npm run setup` fetches the pinned Hermes revision, runs `npm ci` and `uv sync`,
# so a credential already sitting on the runner would otherwise be live on the network before
# anybody looked. A check placed after the install is a report, not a guard.
param(
    # Before install, `.env` is legitimately absent: it is gitignored and setup writes it from
    # the example. After install it must exist, and a run that has no `.env` at that point is
    # a run whose setup did not do what setup does.
    [switch]$RequireEnvFile
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $projectRoot
$problems = @()

# Every real variable the project's own .env.example names. Anything set in the environment is
# a value this run must not be able to see.
foreach ($name in @(
    'PARTNER_MODEL_API_KEY',
    'PARTNER_MODEL_API_KEY_SECONDARY',
    'PARTNER_MODEL_API_KEY_TERTIARY',
    'PARTNER_TELEGRAM_BOT_TOKEN',
    'PARTNER_TELEGRAM_API_ID',
    'PARTNER_TELEGRAM_API_HASH',
    'PARTNER_TELEGRAM_SESSION',
    'PARTNER_TELEGRAM_SESSION_FILE'
)) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $problems += "environment carries $name" }
}

foreach ($path in @('data/secrets', 'data/secrets/telegram.session')) {
    if (Test-Path -LiteralPath $path) { $problems += "secret path present: $path" }
}

# The checkout step asked for no persisted credentials, so the repository's own token must not
# be in the git config that every later step inherits.
$extraHeader = git config --local --get-all http.https://github.com/.extraheader
if ($LASTEXITCODE -eq 0 -and $extraHeader) {
    $problems += 'git config holds a persisted GitHub credential'
}

if (Test-Path -LiteralPath '.env') {
    $example = (Get-Content -Raw -LiteralPath '.env.example') -replace "`r`n", "`n"
    $actual = (Get-Content -Raw -LiteralPath '.env') -replace "`r`n", "`n"
    if ($example.Trim() -ne $actual.Trim()) { $problems += '.env differs from .env.example' }
} elseif ($RequireEnvFile) {
    $problems += '.env is missing; setup should have written it from the example'
}

if ($problems.Count) {
    $problems | ForEach-Object { Write-Error $_ }
    exit 1
}

$phase = if ($RequireEnvFile) { 'after install' } else { 'before install' }
Write-Host "No production credential, model key, Telegram session or persisted token is reachable ($phase)."
