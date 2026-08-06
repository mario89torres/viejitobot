@echo off
rem ============================================================================
rem  Registra pmbtc como tarea programada de Windows.
rem  CLIC DERECHO SOBRE ESTE ARCHIVO -> "Ejecutar como administrador".
rem
rem  Sin elevacion el sistema devuelve "Acceso denegado" al escribir en el
rem  Programador de tareas. Mientras tanto pmbtc ya arranca por la carpeta de
rem  Inicio, asi que esto es una mejora, no un requisito: aporta reinicio
rem  automatico gestionado por Windows (10 intentos, 1 min) ademas del que ya
rem  hacen el supervisor y run-pmbtc.cmd.
rem ============================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: esto necesita permisos de administrador.
  echo   Cierra esta ventana, haz CLIC DERECHO en install-pmbtc-task.cmd
  echo   y elige "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)

schtasks /Create /TN "PmbtcCollector" /XML "%~dp0pmbtc-task.xml" /F
if errorlevel 1 (
  echo.
  echo   Fallo el registro de la tarea.
  pause
  exit /b 1
)

echo.
echo   Tarea "PmbtcCollector" registrada.
echo.
echo   Como ahora la tarea se encarga del arranque, se quita el lanzador
echo   duplicado de la carpeta de Inicio para no levantar dos instancias.
del /f "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pmbtc.vbs" 2>nul

echo   Listo. Se arrancara solo en cada inicio de sesion.
echo.
pause
