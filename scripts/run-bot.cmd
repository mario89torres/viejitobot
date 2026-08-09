@echo off
rem Runner del bot con auto-reinicio: si bot.js crashea, espera 10 s y relanza.
rem Rota el log anterior en cada arranque para que no crezca sin límite.
cd /d C:\Users\Invitadow\playdoit-monitor

rem Node propio de la cuenta Invitadow (copia de v22.23.2, 2026-08-08).
rem Antes se usaba C:\nvm4w\nodejs, pero ese symlink apunta al perfil del OTRO
rem usuario (C:\Users\PC\AppData\Local\nvm) y lo mueve cualquier "nvm use": con
rem v25 instalada tambien ahi, un cambio de version romperia better-sqlite3, que
rem es nativo y esta compilado contra el ABI de Node 22.
rem La tarea programada tampoco hereda el PATH de usuario, de ahi el error 9009.
rem Se antepone al PATH para que lo vean tambien los procesos hijo (execFile).
set "NODE_HOME=C:\Users\Invitadow\node"
set "PATH=%NODE_HOME%;%PATH%"

if not exist "%NODE_HOME%\node.exe" (
  echo [%date% %time%] FATAL: no se encontro node.exe en %NODE_HOME% >> bot.log
  exit /b 1
)

if exist bot.log (
  if exist bot.log.old del /f bot.log.old
  ren bot.log bot.log.old
)

rem Marca que el bot corre BAJO ESTE SUPERVISOR. Lo lee /reboot en Telegram: sin
rem esto no hay quien relance el proceso y el comando se niega a salir en vez de
rem dejar el bot muerto hasta el siguiente inicio de sesion (la tarea programada
rem solo dispara al hacer logon, no vigila el proceso).
set "BOT_SUPERVISED=1"

:loop
echo [%date% %time%] arrancando bot.js >> bot.log
node bot.js >> bot.log 2>&1
echo [%date% %time%] bot.js termino con codigo %errorlevel%, reinicio en 10 s >> bot.log
timeout /t 10 /nobreak >nul
goto loop
