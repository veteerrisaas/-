param([Parameter(Mandatory = $true)][int]$TargetProcessId)

$ErrorActionPreference = 'Stop'
$statusFile = Join-Path $PSScriptRoot 'logs\keep-awake.log'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProjectPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@

try {
    $result = [ProjectPower]::SetThreadExecutionState([uint32]2147483649)
    if ($result -eq 0) { throw 'Windows recusou a solicitacao para impedir suspensao.' }
    "$(Get-Date -Format o) ATIVO: impedindo suspensao enquanto o processo $TargetProcessId existir." | Set-Content -LiteralPath $statusFile -Encoding UTF8
    while (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds 15
    }
} catch {
    "$(Get-Date -Format o) ERRO: $_" | Add-Content -LiteralPath $statusFile -Encoding UTF8
    throw
} finally {
    [void][ProjectPower]::SetThreadExecutionState([uint32]2147483648)
    "$(Get-Date -Format o) ENCERRADO: suspensao normal restaurada." | Add-Content -LiteralPath $statusFile -Encoding UTF8
}
