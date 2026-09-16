@echo off
setlocal enabledelayedexpansion
title SofiaMap - motis
echo ============================================
echo   SofiaMap: starting Motis (routing engine)...
echo ============================================

rem See claude/next-steps-routing.md for background. The Node server's
rem server/src/routes/routing.js proxies /api/route-plan and
rem /api/route-geocode to this process on localhost:8081. Fire-and-forget,
rem same pattern as start-meilisearch.bat, except the Node server does NOT
rem wait for Motis at startup -- a route request just fails with a clear
rem error until Motis is up.
rem
rem Depends on C:\SofiaMap\routing-proto\motis\config.yml already existing
rem with a working "server: host/port" block and imported data (created by
rem routing-proto.ps1's Motis section during engine testing). If that
rem folder is ever deleted, this script has nothing to start.
rem
rem NOTE (2026-09-16): this file was rewritten from scratch after tracking
rem down a nasty cmd.exe parsing bug -- a multi-line parenthesized `if
rem not exist (...)` block whose echoed text mixed escaped parens (^( ^))
rem with Cyrillic characters corrupted cmd's parsing of the REST of the
rem file, including the `start` line near the end: the spawned window
rem opened and died before executing a single line of the target script,
rem with no visible error anywhere (not Defender, not a Mark-of-the-Web
rem block -- both checked and ruled out). Confirmed by isolated testing.
rem Fix / going-forward rule for THIS file: no multi-line parenthesized
rem `if (...)` / `if (...) else (...)` blocks with anything beyond plain
rem ASCII inside -- use single-line `if ... goto :label` instead. A FOR
rem loop's own `do ( ... )` block is fine as long as its body stays plain
rem ASCII (proven safe by testing).

set MOTIS_DIR=%~dp0routing-proto\motis

echo Stopping any Motis already using port 8081...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8081"') do (
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "!FOUND!"=="1" echo Stopped previous Motis process.
if not "!FOUND!"=="1" echo No Motis was running on port 8081.
timeout /t 1 /nobreak >nul

if not exist "%MOTIS_DIR%\motis.exe" goto :missing_exe
if not exist "%MOTIS_DIR%\config.yml" goto :missing_config

echo Starting Motis (log: %~dp0routing-proto\logs\motis-server.log)...
start "SofiaMap motis" "%MOTIS_DIR%\_run-motis.bat"
goto :eof

:missing_exe
echo.
echo [!] motis.exe not found in %MOTIS_DIR% -- skipping Motis startup.
echo     Route planning will not work until Motis is set up there
echo     (see routing-proto.ps1 / next-steps-routing.md).
echo.
goto :eof

:missing_config
echo.
echo [!] config.yml not found in %MOTIS_DIR% -- skipping Motis startup.
echo     Run routing-proto.ps1's Motis section (config+import) first.
echo.
goto :eof
