@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Ativar auto-start do Painel de Operacoes
echo.
echo  Isso faz o SERVIDOR subir sozinho (em segundo plano, sem janela preta)
echo  toda vez que o Windows iniciar. Voce nao precisa mais abrir na mao.
echo.

rem cria um atalho na pasta Inicializar do Windows apontando pro servidor oculto
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Startup') + '\Painel de Operacoes (servidor).lnk');" ^
  "$lnk.TargetPath = 'wscript.exe';" ^
  "$lnk.Arguments = '\"%~dp0Servidor em Background.vbs\"';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.Save()"

if errorlevel 1 (
  echo  [ERRO] Nao consegui criar o atalho de inicializacao.
) else (
  echo  [OK] Auto-start ATIVADO.
)

echo.
echo  Iniciando o servidor agora (em segundo plano)...
start "" wscript.exe "%~dp0Servidor em Background.vbs"

echo.
echo  Pronto. Abra o painel quando quiser em: http://localhost:8765
echo  Para desativar o auto-start, rode "Desativar Auto-Start.bat".
echo.
timeout /t 5 >nul
