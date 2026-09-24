@echo off
rem Arranca (o relanza) SOLO el dashboard, a mano, con el Node correcto.
rem
rem Por que existe: bot.js SI usa siempre el Node correcto al autoarrancar el
rem panel (spawn(process.execPath, ...), ver bot.js:startDashboard) porque
rem hereda su propio interprete. Pero un arranque MANUAL con "node ..." a
rem secas en una terminal sin NODE_HOME resuelve a C:\nvm4w\nodejs, que
rem apunta al perfil del OTRO usuario de Windows y puede tener una version
rem distinta a la que better-sqlite3 (nativo) fue compilado — ver el mismo
rem comentario en run-bot.cmd. Ese fue el origen de los procesos de dashboard
rem duplicados encontrados el 2026-09-08/10.
rem
rem Uso: scripts\start-dashboard.cmd
cd /d C:\Users\Invitadow\playdoit-monitor

set "NODE_HOME=C:\Users\Invitadow\node"
set "PATH=%NODE_HOME%;%PATH%"

if not exist "%NODE_HOME%\node.exe" (
  echo FATAL: no se encontro node.exe en %NODE_HOME%
  exit /b 1
)

if not exist "dist\server\dashboardApi.js" (
  echo FATAL: no existe dist\server\dashboardApi.js -- compila con "npx tsc" primero.
  exit /b 1
)

node dist\server\dashboardApi.js
