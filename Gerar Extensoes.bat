@echo off
cd /d "%~dp0"
python "%~dp0build_extensoes.py"
if errorlevel 1 (echo Falha ao gerar os pacotes. & exit /b 1)
echo Pacotes e manifesto de integridade atualizados.
pause
