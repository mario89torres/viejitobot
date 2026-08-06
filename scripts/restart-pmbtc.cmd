@echo off
rem Reinicio limpio de pmbtc. Usalo tras cambiar codigo.
rem Mata en orden: el bucle cmd, el supervisor y sus hijos. Hay que matar el
rem bucle primero, porque si no relanza el supervisor mientras lo estas matando.

echo Deteniendo pmbtc...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*run-pmbtc.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*pmbtc*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
rem Ruta absoluta a proposito: si esto se lanza desde un shell tipo Git Bash,
rem "timeout" a secas resuelve al de coreutils, que tiene otra sintaxis y falla.
"%SystemRoot%\System32\timeout.exe" /t 3 /nobreak >nul

schtasks /Query /TN "PmbtcCollector" >nul 2>&1
if errorlevel 1 (
  echo Relanzando via carpeta de Inicio...
  wscript.exe "%~dp0start-pmbtc-hidden.vbs"
) else (
  echo Relanzando via tarea programada...
  schtasks /Run /TN "PmbtcCollector"
)

echo Listo. Log: pmbtc\supervise.log ^| Visor: http://localhost:8787
