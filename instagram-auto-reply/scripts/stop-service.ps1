param([switch]$ListOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectEntry = [regex]::Escape($projectRoot) + '[\\/]src[\\/](index|watch-all|service)\.js(?:\s|"|$)'
$processes = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'")
$workers = @($processes | Where-Object {
    $_.CommandLine -match $projectEntry -and $_.CommandLine -match '[\\/]index\.js(?:\s|"|$)'
})
$supervisors = @($processes | Where-Object {
    ($_.CommandLine -match $projectEntry -and $_.CommandLine -match '[\\/]watch-all\.js(?:\s|"|$)') -or
    ($_.CommandLine -match '(?:^|\s|")src[\\/]watch-all\.js(?:\s|"|$)' -and
        ($_.CommandLine -match '(?:^|\s)--account-failover(?:\s|$)' -or $_.ProcessId -in $workers.ParentProcessId))
})
$serviceRunners = @($processes | Where-Object {
    ($_.CommandLine -match $projectEntry -and $_.CommandLine -match '[\\/]service\.js(?:\s|"|$)') -or
    $_.CommandLine -match '(?:^|\s|")src[\\/]service\.js(?:\s|"|$)'
})
$resumeEntry = '-File\s+"?' + [regex]::Escape((Join-Path $PSScriptRoot 'resume-service.ps1')) + '(?:"|\s|$)'
$pendingResumes = @(Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" | Where-Object {
    $_.CommandLine -match $resumeEntry
})

if ($ListOnly) {
    $serviceRunners | Select-Object ProcessId, ParentProcessId, @{Name='Role'; Expression={'automatic-restart'}}
    $supervisors | Select-Object ProcessId, ParentProcessId, @{Name='Role'; Expression={'supervisor'}}
    $workers | Select-Object ProcessId, ParentProcessId, @{Name='Role'; Expression={'worker'}}
    $pendingResumes | Select-Object ProcessId, ParentProcessId, @{Name='Role'; Expression={'pending-resume'}}
    return
}

$logDirectory = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory 'scheduled-stop.log'
function Write-StopLog([string]$Message) {
    Add-Content -LiteralPath $logFile -Value ('[{0}] {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message) -Encoding UTF8
}

Write-StopLog ('Parada solicitada: {0} acompanhamento(s), {1} instancia(s), {2} retomada(s) automatica(s).' -f $supervisors.Count, $workers.Count, $serviceRunners.Count)
foreach ($resumeProcess in $pendingResumes) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $resumeProcess.ProcessId)
    if ($current -and $current.CreationDate -eq $resumeProcess.CreationDate) {
        Stop-Process -Id $resumeProcess.ProcessId -ErrorAction SilentlyContinue
        Write-StopLog ('Retomada agendada cancelada: processo {0}.' -f $resumeProcess.ProcessId)
    }
}
# Primeiro cancela o processo externo, inclusive quando so esta aguardando a retomada.
foreach ($serviceProcess in @($serviceRunners) + @($supervisors)) {
    # A perda do canal IPC faz as instancias fecharem o Chromium e salvarem a sessao.
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $serviceProcess.ProcessId)
    if ($current -and $current.CreationDate -eq $serviceProcess.CreationDate) {
        Stop-Process -Id $serviceProcess.ProcessId -ErrorAction SilentlyContinue
    }
}

$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $remaining = @($workers | Where-Object {
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $_.ProcessId)
        $current -and $current.CreationDate -eq $_.CreationDate
    })
    if (-not $remaining.Count) { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

foreach ($serviceProcess in $remaining) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $serviceProcess.ProcessId)
    if ($current -and $current.CreationDate -eq $serviceProcess.CreationDate) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $serviceProcess.ProcessId /T /F | Out-Null
        Write-StopLog ('Instancia {0} encerrada apos espera de fechamento.' -f $serviceProcess.ProcessId)
    }
}
Write-StopLog 'Parada concluida; acompanhamento automatico encerrado.'
