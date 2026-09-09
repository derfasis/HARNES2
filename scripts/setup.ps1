$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
foreach ($toolName in @('node','npm.cmd','git','uv')) {
    if (-not (Get-Command $toolName -ErrorAction SilentlyContinue)) { throw "Missing $toolName. Install Node.js 24+, Git and uv, then rerun setup." }
}
$nodeMajor = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($nodeMajor -lt 24) { throw 'Node.js 24 or later is required.' }
$upstream = Get-Content -Raw -LiteralPath 'runtime/upstream.lock.json' | ConvertFrom-Json
$runtimePath = Join-Path $projectRoot $upstream.checkout
if (-not (Test-Path -LiteralPath $runtimePath)) {
    New-Item -ItemType Directory -Path $runtimePath | Out-Null
    & git -C $runtimePath init
    if ($LASTEXITCODE -ne 0) { throw 'Git init failed.' }
    & git -C $runtimePath remote add upstream $upstream.repository
    if ($LASTEXITCODE -ne 0) { throw 'Git remote failed.' }
    & git -C $runtimePath fetch --depth=1 upstream $upstream.commit
    if ($LASTEXITCODE -ne 0) { throw 'Hermes download failed.' }
    & git -C $runtimePath checkout -b partner-main $upstream.commit
    if ($LASTEXITCODE -ne 0) { throw 'Hermes checkout failed.' }
}
$installedCommit = & git -C $runtimePath rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $installedCommit -ne $upstream.commit) { throw 'Hermes revision differs from upstream.lock.json. Existing files were preserved.' }
& npm.cmd ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed.' }
$oldUvEnvironment = $env:UV_PROJECT_ENVIRONMENT
try {
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $projectRoot '.venv'
    & uv sync --project $runtimePath --frozen --no-dev --extra mcp --extra messaging --python $upstream.python
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
} finally { $env:UV_PROJECT_ENVIRONMENT = $oldUvEnvironment }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (-not (Test-Path -LiteralPath 'config/local.json')) { Copy-Item -LiteralPath 'config/local.example.json' -Destination 'config/local.json' }
Write-Host 'Installed. Run START-PARTNER.bat. No tests or model calls were run.'
