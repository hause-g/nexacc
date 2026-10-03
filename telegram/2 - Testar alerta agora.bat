@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Enviando um alerta de teste agora...
echo.
python enviar_alerta.py
echo.
pause
