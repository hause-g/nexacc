' Sobe o servidor do Painel de Operacoes de forma OCULTA (sem janela preta) e SEM abrir o navegador.
' Usado pelo auto-start do Windows. Para abrir o painel manualmente, use "Abrir Dashboard (oculto).vbs".
Option Explicit
Dim sh, fso, pasta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
' janela 0 = oculta; False = nao espera terminar
sh.Run "cmd /c """ & pasta & "\_servidor.bat""", 0, False
