' Cria um atalho do Dashboard na area de trabalho (abre o servidor oculto).
Option Explicit
Dim sh, fso, pasta, desktop, lnk
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = sh.SpecialFolders("Desktop")
Set lnk = sh.CreateShortcut(desktop & "\Dashboard de Operacoes.lnk")
lnk.TargetPath = pasta & "\Abrir Dashboard (oculto).vbs"
lnk.WorkingDirectory = pasta
lnk.Description = "Abrir o Painel de Operacoes"
lnk.Save
MsgBox "Atalho 'Dashboard de Operacoes' criado na area de trabalho!", 64, "Dashboard"
