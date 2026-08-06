@echo off
rem Runner del bot con auto-reinicio: si bot.js crashea, espera 10 s y relanza.
rem Rota el log anterior en cada arranque para que no crezca sin límite.
cd /d C:\Users\Invitadow\playdoit-monitor

if exist bot.log (
  if exist bot.log.old del /f bot.log.old
  ren bot.log bot.log.old
)

:loop
echo [%date% %time%] arrancando bot.js >> bot.log
node bot.js >> bot.log 2>&1
echo [%date% %time%] bot.js termino con codigo %errorlevel%, reinicio en 10 s >> bot.log
timeout /t 10 /nobreak >nul
goto loop
