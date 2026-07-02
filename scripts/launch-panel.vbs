' Readback panel launcher — no console window.
' If the panel server is already running, open the browser to it.
' Otherwise start the server hidden (it opens the browser itself once ready).

Option Explicit
Dim fso, shell, scriptDir, projDir, port, baseUrl, running, http

port = 7717
baseUrl = "http://localhost:" & port & "/"

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projDir = fso.GetParentFolderName(scriptDir)

running = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.open "GET", baseUrl & "health", False
http.send
If Err.Number = 0 Then
  If http.Status = 200 Then running = True
End If
On Error GoTo 0

If running Then
  ' Already up — just show it.
  shell.Run baseUrl, 1, False
Else
  ' Start the server hidden; panel-server.js opens the browser when ready.
  shell.CurrentDirectory = projDir
  shell.Run "node """ & projDir & "\src\panel-server.js""", 0, False
End If
