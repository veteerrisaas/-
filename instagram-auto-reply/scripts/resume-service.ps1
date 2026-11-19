param(
    [Parameter(Mandatory = $true)][DateTimeOffset]$ResumeAt,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$entryFile = Join-Path $projectRoot 'src\service.js'
$serviceArgs = @($entryFile, '--two-accounts', '--shared-history', '--sync-browser-modes',
    '--instance-account-failover', '--mobile-fallback', '--browser-mode', 'desktop', '--no-action-delays')

if ($CheckOnly) {
    Push-Location -LiteralPath $projectRoot
    try { & $nodeExe @serviceArgs --check; $checkCode = $LASTEXITCODE }
    finally { Pop-Location }
    exit $checkCode
}

$logDirectory = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stateFile = Join-Path $logDirectory 'pause-resume.json'
function Write-ResumeState([string]$Status, [string]$Detail = '') {
    [PSCustomObject]@{
        Status = $Status; ResumeAt = $ResumeAt.ToUniversalTime().ToString('o')
        HelperProcessId = $PID; UpdatedAt = [DateTimeOffset]::UtcNow.ToString('o'); Detail = $Detail
    } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

Write-ResumeState 'waiting'
while ([DateTimeOffset]::UtcNow -lt $ResumeAt) {
    $remainingMs = ($ResumeAt - [DateTimeOffset]::UtcNow).TotalMilliseconds
    if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(15000, $remainingMs)) }
}

try {
    $projectEntry = [regex]::Escape($projectRoot) + '[\\/]src[\\/](index|watch-all|service)\.js(?:\s|"|$)'
    $running = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {
        $_.CommandLine -match $projectEntry
    })
    if ($running.Count) { Write-ResumeState 'already-running'; exit 0 }

    $runStamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $outLog = Join-Path $logDirectory ('split_sync_' + $runStamp + '.log')
    $errLog = Join-Path $logDirectory ('split_sync_' + $runStamp + '.err.log')
    $launchArgs = @(('"' + $entryFile + '"')) + $serviceArgs[1..($serviceArgs.Length - 1)]
    $serviceRun = Start-Process -FilePath $nodeExe -ArgumentList $launchArgs -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-ResumeState 'started' ('ProcessId={0}; Log={1}; ErrorLog={2}' -f $serviceRun.Id, $outLog, $errLog)
} catch {
    Write-ResumeState 'failed' $_.Exception.Message
    throw
}
