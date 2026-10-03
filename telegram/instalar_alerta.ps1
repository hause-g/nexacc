# Agenda o alerta do cronograma no Telegram. Roda a cada 15 min: o enviar_alerta.py só manda depois
# do horário escolhido no painel (Ajustes > Alerta diário) e uma vez por dia. Com PC desligado, dormindo
# ou na bateria no horário, manda assim que der, em vez de perder o dia.
$ErrorActionPreference = 'Stop'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $pasta 'enviar_alerta.py'
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { $pyw = (Get-Command python -ErrorAction Stop).Source }
$acao = New-ScheduledTaskAction -Execute $pyw -Argument ('"' + $script + '" --agendado') -WorkingDirectory $pasta
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15)
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'AlertaOperacoesTelegram' -Action $acao -Trigger $gatilho -Settings $ajustes -Force | Out-Null
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$hora = if ($py) { & $py $script --horario } else { '?' }
Write-Output ('Alerta agendado. Horario atual: ' + $hora + ' (muda em Ajustes > Alerta diario do painel).')
