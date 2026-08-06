@echo off
rem Reinicio limpio: mata cualquier instancia de bot.js (y su runner) y
rem relanza via la tarea programada. Usalo tras cambiar codigo o .env.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bot.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*run-bot.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul
schtasks /Run /TN "PlaydoitMonitorBot"
echo Bot relanzado via tarea programada. Log: bot.log
