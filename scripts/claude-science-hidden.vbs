' Lanza Claude Science sin mostrar ventana de consola.
' Mismo patron que start-bot-hidden.vbs.
Set sh = CreateObject("WScript.Shell")
sh.Run """" & Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")) & "claude-science.cmd""", 0, False
