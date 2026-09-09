$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceFile = Join-Path $projectRoot 'data/runtime/service.json'
if (-not (Test-Path -LiteralPath $serviceFile)) { Write-Host 'No recorded service process.'; exit 0 }
$serviceState = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($serviceState.pid)" -ErrorAction SilentlyContinue
if (-not $process) { Write-Host 'Already stopped.'; exit 0 }
if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains((Join-Path $projectRoot 'business/server.mjs'))) { throw 'PID belongs to a different process. Nothing was stopped.' }
# Restrict termination to the service process and its currently recorded direct Hermes children.
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($serviceState.pid)" -ErrorAction SilentlyContinue
foreach ($child in $children) {
    if ($child.Name -eq 'python.exe' -and $child.CommandLine.Contains((Join-Path $projectRoot 'adapters/hermes/runner.py'))) { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
}
Stop-Process -Id $serviceState.pid
Write-Host 'Stopped. Interrupted work will be retained for review on the next start.'
