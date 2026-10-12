' ReadBack panel launcher. WMI owns the server so closing the calling app
' or terminal cannot terminate the panel through an inherited Windows job.
Option Explicit
Dim fso, shell, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptDir & "\launch-panel.ps1""", 0, False
