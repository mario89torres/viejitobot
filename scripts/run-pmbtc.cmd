@echo off
rem Runner de pmbtc: lanza el supervisor, que a su vez mantiene vivos el colector
rem y el visor web. Si el propio supervisor muere, este bucle lo relanza a los 10 s.
rem Rota el log anterior en cada arranque para que no crezca sin limite.
cd /d C:\Users\Invitadow\playdoit-monitor

if exist pmbtc\supervise.log (
  if exist pmbtc\supervise.log.old del /f pmbtc\supervise.log.old
  ren pmbtc\supervise.log supervise.log.old
)

:loop
echo [%date% %time%] arrancando supervise.js >> pmbtc\supervise.log
node pmbtc\supervise.js >> pmbtc\supervise.log 2>&1
echo [%date% %time%] supervise.js termino con codigo %errorlevel%, reinicio en 10 s >> pmbtc\supervise.log
rem Ruta absoluta: desde un shell tipo Git Bash "timeout" resolveria al de
rem coreutils, que tiene otra sintaxis y romperia el bucle.
"%SystemRoot%\System32\timeout.exe" /t 10 /nobreak >nul
goto loop
