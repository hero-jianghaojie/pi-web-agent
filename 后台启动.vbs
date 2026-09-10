' Pi Web Agent - silent launcher (no console window)
' Double-click this to start the server in the background and open the browser.
' To stop it, double-click "Stop.bat" (停止.bat).

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir

' 0 = hidden window, False = don't wait
shell.Run "node server.js --open", 0, False
