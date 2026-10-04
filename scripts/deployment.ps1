param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop')][string]$Operation,
      [Parameter(Mandatory=$true)][string]$Profile,[switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
$profilePath = (Resolve-Path -LiteralPath $Profile).ProviderPath
$profileState = Get-Content -Raw -LiteralPath $profilePath | ConvertFrom-Json
if ($profileState.version -ne 1 -or [string]$profileState.code_sha -notmatch '^[a-f0-9]{40}$' -or
    [string]$profileState.id -notmatch '^[a-f0-9-]{36}$' -or
    -not [IO.Path]::IsPathRooted([string]$profileState.code_root) -or
    -not [IO.Path]::IsPathRooted([string]$profileState.data_directory)) { throw 'DEPLOYMENT_PROFILE_INVALID' }
$selectedRoot = [IO.Path]::GetFullPath([string]$profileState.code_root).TrimEnd('\','/')
$nodePath = (Get-Command node -ErrorAction Stop).Source
# Node is already required for this launcher. Use its native filesystem identity
# for both roots; GetFullPath alone preserves Windows8.3 names and junction aliases.
$canonicalRoots = & $nodePath -e "const fs=require('node:fs'); process.stdout.write(JSON.stringify(process.argv.slice(1).map(value=>fs.realpathSync.native(value))));" $projectRoot $selectedRoot
if ($LASTEXITCODE -ne 0) { throw 'DEPLOYMENT_CODE_ROOT_MISMATCH' }
$resolvedRoots = $canonicalRoots | ConvertFrom-Json
$projectRoot = [string]$resolvedRoots[0]
$selectedRoot = [string]$resolvedRoots[1]
if ($selectedRoot -ne $projectRoot) { throw 'DEPLOYMENT_CODE_ROOT_MISMATCH' }
$serviceFile = Join-Path $profileState.data_directory 'runtime/service.json'
$entryFile = Join-Path $projectRoot 'scripts/run-deployment.mjs'

function Get-VerifiedInstance {
    if (-not (Test-Path -LiteralPath $serviceFile)) { return $null }
    $record = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json
    if ($record.pid -isnot [int] -and $record.pid -isnot [long]) { throw 'DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS' }
    if ($record.pid -le 0) { throw 'DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS' }
    $recordedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
    if (-not $recordedProcess) { return $null }
    if ($recordedProcess.Name -ne 'node.exe' -or -not $recordedProcess.CommandLine -or
        -not $recordedProcess.CommandLine.Contains($entryFile) -or
        -not $recordedProcess.CommandLine.Contains($profilePath) -or
        $record.code_root -ne $projectRoot -or $record.code_sha -ne $profileState.code_sha -or
        $record.deployment_id -ne $profileState.id -or $record.verified -ne $true -or
        $record.mode -ne $profileState.mode -or $record.partner_id -ne $profileState.partner_id -or
        $record.config_sha256 -ne $profileState.config_sha256 -or
        [string]$record.instance_id -notmatch '^[a-f0-9-]{36}$' -or $record.port -lt 1024 -or $record.port -gt 65535) {
        throw 'DEPLOYMENT_INSTANCE_MISMATCH'
    }
    $baseUrl = "http://127.0.0.1:$($record.port)"
    try { $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 3 } catch { throw 'DEPLOYMENT_INSTANCE_HEALTH_UNVERIFIED' }
    foreach ($field in @('instance_id','pid','port','code_root','code_sha','verified','mode','deployment_id','partner_id','config_sha256','profile_fingerprint')) {
        if ($health.release.$field -ne $record.$field) { throw 'DEPLOYMENT_INSTANCE_MISMATCH' }
    }
    if (($health.status -ne 'running' -and -not ($Operation -eq 'Stop' -and $health.status -eq 'stopping')) -or $health.activation.id -ne $profileState.id -or
        $health.activation.expires_at -ne $profileState.expires_at) { throw 'DEPLOYMENT_INSTANCE_MISMATCH' }
    return @{ record=$record; url=$baseUrl; process=$recordedProcess }
}

if ($Operation -eq 'Stop') {
    $instance = Get-VerifiedInstance
    if (-not $instance) { Write-Host 'Partner is already stopped.'; exit 0 }
    $session = Invoke-RestMethod -Uri "$($instance.url)/api/session" -TimeoutSec 3
    $body = @{instance_id=$instance.record.instance_id} | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Uri "$($instance.url)/api/runtime/stop" -Method Post -ContentType 'application/json' -Headers @{'x-partner-token'=$session.token} -Body $body -TimeoutSec 5
    Write-Host 'Stop accepted. Partner is draining work and preserving receipts.'
    exit 0
}

# These checks are for reusing a running instance; the Node bootstrap independently
# verifies the complete profile before opening state or loading credentials.
Push-Location -LiteralPath $projectRoot
try {
    $actualSha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualSha -ne $profileState.code_sha) { throw 'DEPLOYMENT_CODE_IDENTITY_MISMATCH' }
    $dirty = & git status --porcelain --untracked-files=all
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'DEPLOYMENT_CODE_DIRTY' }
} finally { Pop-Location }
$expiry = [DateTimeOffset]::Parse([string]$profileState.expires_at)
if ($expiry -le [DateTimeOffset]::UtcNow) { throw 'DEPLOYMENT_PROFILE_EXPIRED' }
$sealed = & $nodePath $entryFile --inspect $profilePath
if ($LASTEXITCODE -ne 0) { throw 'DEPLOYMENT_PROFILE_INSPECTION_FAILED' }
$inspected = $sealed | ConvertFrom-Json
$existing = Get-VerifiedInstance
if ($existing) {
    if ($existing.record.profile_fingerprint -ne $inspected.identity.profile_fingerprint) { throw 'DEPLOYMENT_INSTANCE_MISMATCH' }
    Write-Host "Already running: $($existing.url)"
    if (-not $NoBrowser) { Start-Process $existing.url }
    exit 0
}
$logDir = Join-Path (Split-Path -Parent $profilePath) (Join-Path 'logs' $profileState.id)
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$nodeArgs = '"' + $entryFile + '" "' + $profilePath + '"'
$worker = Start-Process -FilePath $nodePath -ArgumentList $nodeArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'deployment.out.log') -RedirectStandardError (Join-Path $logDir 'deployment.err.log') -PassThru
$ready = $null
for ($attempt=0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 250
    $worker.Refresh()
    if ($worker.HasExited) { throw 'DEPLOYMENT_START_FAILED; inspect private deployment.err.log' }
    if (Test-Path -LiteralPath $serviceFile) {
        $record = Get-Content -Raw -LiteralPath $serviceFile | ConvertFrom-Json
        if ($record.pid -eq $worker.Id) { $ready = Get-VerifiedInstance; if ($ready) { break } }
    }
}
if (-not $ready) { throw 'DEPLOYMENT_START_PENDING; inspect the live process before retrying' }
Write-Host "Running: $($ready.url)"
if (-not $NoBrowser) { Start-Process $ready.url }
