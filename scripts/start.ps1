param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceFile = Join-Path $projectRoot 'data/runtime/service.json'
if (Test-Path -LiteralPath $serviceFile) {
    $serviceState = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($serviceState.pid)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains((Join-Path $projectRoot 'business/server.mjs'))) {
        $serviceUrl = "http://127.0.0.1:$($serviceState.port)"
        Write-Host "Already running: $serviceUrl"
        if (-not $NoBrowser) { Start-Process $serviceUrl }
        exit 0
    }
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $projectRoot 'data/logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$entryFile = Join-Path $projectRoot 'business/server.mjs'
$nodeArgs = '--env-file-if-exists=.env "' + $entryFile + '"'
$process = Start-Process -FilePath $nodePath -ArgumentList $nodeArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'service.out.log') -RedirectStandardError (Join-Path $logDir 'service.err.log') -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw "Startup failed. See $logDir\service.err.log" }
    if (Test-Path -LiteralPath $serviceFile) {
        $serviceState = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json
        if ($serviceState.pid -eq $process.Id) { $ready = $true; break }
    }
}
if (-not $ready) { throw "Startup is still pending. Inspect logs in $logDir before retrying." }
$serviceUrl = "http://127.0.0.1:$($serviceState.port)"
Write-Host "Running: $serviceUrl"
if (-not $NoBrowser) { Start-Process $serviceUrl }
