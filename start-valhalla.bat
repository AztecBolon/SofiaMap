@echo off
setlocal enabledelayedexpansion
title SofiaMap - valhalla
echo ============================================
echo   SofiaMap: starting Valhalla (isochrone engine)...
echo ============================================

rem See claude/next-steps-walkability-isochrone.md for background. The Node
rem server's server/src/routes/isochrone.js proxies /api/isochrone to this
rem process on localhost:8082. Fire-and-forget, same pattern as
rem start-motis.bat -- the Node server does NOT wait for this at startup, a
rem "Зона доступности" request just fails with a clear error until this is
rem up (and returns its own clear "tiles_not_built" error if
rem setup-valhalla.bat was never run).
rem
rem No multi-line parenthesized if-blocks with anything beyond ASCII inside
rem -- see restart-server.bat's own comment on why.

set VDIR=%~dp0routing-proto\valhalla
set VENV=%VDIR%\venv
set PY=%VENV%\Scripts\python.exe

echo Stopping any Valhalla already using port 8082...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8082"') do (
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "!FOUND!"=="1" echo Stopped previous Valhalla process.
if not "!FOUND!"=="1" echo No Valhalla was running on port 8082.
timeout /t 1 /nobreak >nul

if not exist "%PY%" goto :missing_venv
if not exist "%VDIR%\tiles" goto :missing_tiles

echo Starting Valhalla (log: %~dp0routing-proto\logs\valhalla-server.log)...
start "SofiaMap valhalla" "%VDIR%\_run-valhalla.bat"
goto :eof

:missing_venv
echo.
echo [!] Python venv not found at %VENV% -- skipping Valhalla startup.
echo     "Зона доступности" will not work until setup-valhalla.bat has been
echo     run once (see claude/next-steps-walkability-isochrone.md).
echo.
goto :eof

:missing_tiles
echo.
echo [!] Graph tiles not found in %VDIR%\tiles -- skipping Valhalla startup.
echo     Run setup-valhalla.bat first (builds the graph from
echo     raw\sofia.osm.pbf).
echo.
goto :eof
