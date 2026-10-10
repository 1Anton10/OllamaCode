' Launch OllamaCode with no console window (Desktop shortcut + Explorer context menu).
Option Explicit
Dim sh, fso, root, ps1, cmd, i, a, pathArg
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = root & "\scripts\launch.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Silent"
pathArg = ""
If WScript.Arguments.Count > 0 Then
  pathArg = WScript.Arguments(0)
End If
If Len(pathArg) > 0 Then
  cmd = cmd & " -Workspace """ & pathArg & """"
End If
sh.Run cmd, 0, False
