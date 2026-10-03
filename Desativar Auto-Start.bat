@echo off
chcp 65001 >nul
title Desativar auto-start do Painel de Operacoes
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Painel de Operacoes (servidor).lnk" >nul 2>&1
echo.
echo  [OK] Auto-start DESATIVADO (o servidor nao sobe mais sozinho no boot).
echo  O servidor que estiver rodando agora continua ate voce fechar
echo  ou rodar "Parar Dashboard.bat".
echo.
timeout /t 4 >nul
