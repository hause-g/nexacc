@echo off
rem Supervisor do servidor local. Se o python cair sozinho (erro, falta de memoria,
rem Windows matando o processo), sobe de novo em 3s — sem precisar abrir a pasta.
rem "Parar Dashboard" cria .servidor-parado ANTES de encerrar; enquanto existir, nao relanca.
cd /d "%~dp0"
del "%~dp0.servidor-parado" >nul 2>nul
:loop
python "%~dp0servidor.py"
if exist "%~dp0.servidor-parado" goto fim
echo [%date% %time%] servidor caiu; religando em 3s >> "%~dp0logs\supervisor.log"
timeout /t 3 /nobreak >nul
goto loop
:fim
del "%~dp0.servidor-parado" >nul 2>nul
