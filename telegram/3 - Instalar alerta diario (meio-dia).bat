@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar_alerta.ps1"
if errorlevel 1 (echo Falha ao configurar o agendamento. & pause & exit /b 1)
echo O horario do alerta e o do painel: Ajustes ^> Alerta diario. Nao precisa rodar este arquivo de novo ao muda-lo.
pause
