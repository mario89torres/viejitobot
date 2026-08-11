@echo off
rem Runner de pmbtc: lanza el supervisor, que a su vez mantiene vivos el colector
rem y el visor web. Si el propio supervisor muere, este bucle lo relanza a los 10 s.
rem Rota el log anterior en cada arranque para que no crezca sin limite.
cd /d C:\Users\Invitadow\pmbtc-quant

if exist supervise.log (
  if exist supervise.log.old del /f supervise.log.old
  ren supervise.log supervise.log.old
)

:loop
echo [%date% %time%] arrancando supervise.js >> supervise.log
"C:\nvm4w\nodejs\node.exe" supervise.js >> supervise.log 2>&1
echo [%date% %time%] supervise.js termino con codigo %errorlevel%, reinicio en 10 s >> supervise.log
rem Ruta absoluta: desde un shell tipo Git Bash "timeout" resolveria al de
rem coreutils, que tiene otra sintaxis y romperia el bucle.
"%SystemRoot%\System32\timeout.exe" /t 10 /nobreak >nul
goto loop
