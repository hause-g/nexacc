@echo off
cd /d "%~dp0"
python "%~dp0run_tests.py"
set "TASKRESULT=%errorlevel%"
if not "%TASKRESULT%"=="0" echo Ha testes reprovados. Nao publicar este pacote.
pause
exit /b %TASKRESULT%
