' Abre o Painel de Operacoes SEM janela preta (servidor oculto) e abre no navegador.
' Usa python e IPv4. Uma porta ocupada não encerra outros processos. Use "Parar Dashboard.bat" pra desligar.
Option Explicit
Dim sh, fso, pasta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
' roda o servidor de forma OCULTA (janela 0). O _servidor.bat inicia o python sem encerrar outros processos.
sh.Run "cmd /c """ & pasta & "\_servidor.bat""", 0, False
' espera o servidor subir e abre no navegador (mesma origem dos dados: localhost)
WScript.Sleep 1800
sh.Run "http://localhost:8765/index.html"
