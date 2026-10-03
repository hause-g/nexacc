param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$taskScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'servidor.py'))
$taskListeners = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
if (-not $taskListeners.Count) { Write-Host 'Nenhum servidor ativo na porta 8765.'; exit 0 }
foreach ($taskOwner in @($taskListeners.OwningProcess | Select-Object -Unique)) {
 $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskOwner"
 if (-not $taskProcess -or $taskProcess.Name -notmatch '^python(w)?(.exe)?$' -or -not $taskProcess.CommandLine -or $taskProcess.CommandLine.IndexOf($taskScript,[StringComparison]::OrdinalIgnoreCase) -lt 0) {
  Write-Host 'A porta está ocupada por um processo cuja identidade não foi confirmada. Nenhum processo foi encerrado.'
  exit 1
 }
 if ($Stop) {
  # marca ANTES de encerrar: o supervisor (_servidor.bat) le esta marca e nao relanca.
  New-Item -ItemType File -Path (Join-Path $PSScriptRoot '.servidor-parado') -Force | Out-Null
  Stop-Process -Id $taskOwner -ErrorAction Stop; Write-Host 'Servidor Agentum encerrado.'
 }
 else { Write-Host 'Servidor Agentum ativo.' }
}
