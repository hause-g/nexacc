@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agentum - Servidor local
where python >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Python nao encontrado. Instale Python com a opcao Add to PATH.
  pause
  exit /b 1
)
echo Abrindo o painel. Seus dados permanecem na mesma origem.
start "" http://localhost:8765/index.html
echo Servidor local. Porta ocupada nao encerra outros processos.
python "%~dp0servidor.py"
if errorlevel 1 (
  echo O servidor nao iniciou. Se o painel ja esta aberto, confira o indicador de conexao.
  pause
  exit /b 1
)
