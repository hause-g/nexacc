@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Procurando seu chat_id (mande uma mensagem ao bot antes)...
echo.
python pegar_chat_id.py
echo.
pause
