param(
    [ValidateSet('Setup', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Status'
)
# The owner's chat with the partner: Hermes' own Telegram gateway plus its Hindsight memory server.
# See docs/OWNER_CHAT_V1.md. Start is safe to repeat: whatever already runs is left alone.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$gatewayHome = Join-Path $projectRoot 'data\hermes-gateway'
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$launch = Join-Path $projectRoot 'adapters\hermes\owner_gateway\launch.py'
$setup = Join-Path $projectRoot 'adapters\hermes\owner_gateway\setup.py'
$stateFile = Join-Path $gatewayHome 'gateway_state.json'
$pidFile = Join-Path $gatewayHome 'gateway.pid'
$serviceFile = Join-Path $projectRoot 'data\runtime\service.json'
$logDir = Join-Path $projectRoot 'data\logs'
$hindsight = Join-Path $projectRoot 'data\hindsight\venv\Scripts\hindsight-embed.exe'
$memoryProfile = 'harnes2'
$memoryUrl = 'http://127.0.0.1:8890/health'
$launchPattern = 'owner_gateway.launch\.py'

function Test-Listening([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Test-Memory {
    try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $memoryUrl).StatusCode -eq 200 } catch { return $false }
}

function Test-Service {
    if (-not (Test-Path -LiteralPath $serviceFile)) { return $false }
    try { $recorded = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json } catch { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$recorded.pid)" -ErrorAction SilentlyContinue
    return [bool]($process -and $process.Name -eq 'node.exe')
}

function Get-GatewayProcess {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    try { $recorded = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json } catch { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$recorded.pid)" -ErrorAction SilentlyContinue
    if (-not $process -or $process.Name -notmatch '^python(w)?\.exe$' -or $process.CommandLine -notmatch $launchPattern) { return $null }
    return $process
}

function Get-GatewayState {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try { return Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } catch { return $null }
}

function Show-Status {
    $gateway = Get-GatewayProcess
    $state = Get-GatewayState
    $telegram = if ($gateway -and $state -and $state.platforms.telegram) { $state.platforms.telegram.state } else { 'not running' }
    Write-Host ("Partner service:      " + $(if (Test-Service) { 'running' } else { 'NOT running (the chat cannot see the notebook; start it with START-PARTNER.bat)' }))
    Write-Host ("Model proxy (8318):   " + $(if (Test-Listening 8318) { 'running' } else { 'NOT running' }))
    Write-Host ("Memory (Hindsight):   " + $(if (Test-Memory) { 'running' } else { 'NOT running' }))
    Write-Host ("Telegram chat:        " + $(if ($gateway) { "running, Telegram $telegram" } else { 'NOT running' }))
}

if ($Action -eq 'Status') { Show-Status; exit 0 }

if ($Action -eq 'Setup') {
    if (-not (Test-Path -LiteralPath $python)) { throw 'The Hermes environment is missing. Run: npm run setup' }
    $env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
    & $python $setup
    exit $LASTEXITCODE
}

if ($Action -eq 'Stop') {
    $gateway = Get-GatewayProcess
    if ($gateway) {
        # Hermes has no softer stop on Windows either: its own "gateway stop" terminates the process.
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($gateway.ParentProcessId)" -ErrorAction SilentlyContinue
        Stop-Process -Id $gateway.ProcessId -ErrorAction SilentlyContinue
        if ($parent -and $parent.Name -eq 'python.exe' -and $parent.CommandLine -match $launchPattern) { Stop-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue }
        Write-Host 'Telegram chat stopped.'
    } else { Write-Host 'Telegram chat was not running.' }
    if (Test-Memory) {
        $env:PYTHONUTF8 = '1'; $env:NO_COLOR = '1'
        $stopper = Start-Process -FilePath $hindsight -ArgumentList @('-p', $memoryProfile, 'daemon', 'stop') -WindowStyle Hidden -PassThru
        [void]$stopper.WaitForExit(120000)
        Write-Host 'Memory server stopped. What it remembers stays on disk.'
    }
    exit 0
}

# Start
foreach ($required in @($python, $launch, $hindsight, (Join-Path $gatewayHome 'config.yaml'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required. Run: powershell -File scripts\partner-chat.ps1 -Action Setup" }
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$proxyScript = Join-Path $projectRoot 'scripts\cliproxyapi.ps1'
if (-not (Test-Listening 8318) -and (Test-Path -LiteralPath $proxyScript)) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $proxyScript -Action Start
}
if (-not (Test-Memory)) {
    Write-Host 'Starting the memory server (the first minute is model loading)...'
    $env:PYTHONUTF8 = '1'; $env:NO_COLOR = '1'; $env:HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT = '600'
    # Not -Wait: that would also wait for the detached memory server the command leaves running.
    $starter = Start-Process -FilePath $hindsight -ArgumentList @('-p', $memoryProfile, 'daemon', 'start') -WindowStyle Hidden -PassThru
    [void]$starter.WaitForExit(660000)
    if (-not (Test-Memory)) { throw "The memory server did not start. See $env:USERPROFILE\.hindsight\profiles\$memoryProfile.log" }
}
if (Get-GatewayProcess) { Write-Host 'Telegram chat is already running.'; Show-Status; exit 0 }
$env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
$started = Get-Date
$process = Start-Process -FilePath $python -ArgumentList ('"' + $launch + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'hermes-gateway.out.log') -RedirectStandardError (Join-Path $logDir 'hermes-gateway.err.log')
$ready = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "The Telegram chat failed to start. See $logDir\hermes-gateway.err.log" }
    $state = Get-GatewayState
    if ((Get-GatewayProcess) -and $state -and $state.platforms.telegram.state -eq 'connected' -and (Get-Item -LiteralPath $stateFile).LastWriteTime -ge $started) { $ready = $true; break }
}
if (-not $ready) { throw "The Telegram chat is still starting. See $logDir\hermes-gateway.err.log" }
Show-Status
