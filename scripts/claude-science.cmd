@echo off
setlocal
set "DISTRO=Ubuntu"

echo Iniciando Claude Science...

for /f "usebackq tokens=*" %%u in (`wsl.exe -d %DISTRO% -- bash -lc "~/.local/bin/cs-launch.sh"`) do set "CS_URL=%%u"

if not defined CS_URL (
  echo.
  echo ERROR: no se pudo obtener el enlace de acceso.
  echo Revisa los logs con:  wsl -d %DISTRO% -- ~/.local/bin/claude-science logs --tail
  echo.
  pause
  exit /b 1
)

rem El enlace es de un solo uso y expira en ~3 min, por eso se pide uno nuevo en cada arranque.
start "" "%CS_URL%"
exit /b 0
