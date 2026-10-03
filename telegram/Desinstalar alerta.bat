@echo off
chcp 65001 >nul
echo Removendo o alerta diario do Telegram...
schtasks /Delete /TN "AlertaOperacoesTelegram" /F
echo.
pause
