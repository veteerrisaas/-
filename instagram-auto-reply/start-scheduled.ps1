param(
    [Parameter(Mandatory = $true)][string]$StopAt,
    [switch]$ZeroActionDelays
)
$ErrorActionPreference = 'Stop'
$taskDir = $PSScriptRoot
$taskDeadline = [DateTimeOffset]::Parse($StopAt)
if ($taskDeadline -le [DateTimeOffset]::Now -or ($taskDeadline - [DateTimeOffset]::Now).TotalHours -gt 24) {
    throw 'Horário de encerramento inválido ou vencido.'
}
$taskActive = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match 'src[\\/]start-gbrdastip\.js' -or
    $_.CommandLine -like '*instagram-auto-reply\src\service.js*' -or
    $_.CommandLine -like '*instagram-auto-reply\src\index.js*'
})
if ($taskActive.Count -gt 0) { throw 'Automação já está ativa; inicialização agendada cancelada para evitar duplicação.' }
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskLock = Join-Path $taskDir 'data\replied.json.lock'
if (Test-Path -LiteralPath $taskLock) {
    Move-Item -LiteralPath $taskLock -Destination (Join-Path $taskDir ('data\replied.json.lock.stale-' + $taskStamp))
}
$taskNode = (Get-Command node).Source
$taskArgs = @('src/start-gbrdastip.js', '--username', 'gbrdastip', '--chrome-login', '--stop-at', $StopAt)
if ($ZeroActionDelays) { $taskArgs += '--zero-action-delays' }
$taskOut = Join-Path $taskDir ('logs\gbrdastip-agendado-' + $taskStamp + '.out.log')
$taskErr = Join-Path $taskDir ('logs\gbrdastip-agendado-' + $taskStamp + '.err.log')
Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory $taskDir -WindowStyle Hidden `
    -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr
