@echo off
setlocal enabledelayedexpansion
title SofiaMap - restart
echo ============================================
echo   SofiaMap: restarting server...
echo ============================================

rem NOTE (2026-09-16): this file was rewritten from scratch after tracking
rem down a nasty cmd.exe parsing bug -- a multi-line parenthesized `if
rem (...) else (...)` block whose echoed text mixed escaped parens
rem (^( ^)) with Cyrillic characters corrupted cmd's parsing of the rest
rem of the file, including a `start "Title" "path.bat"` line elsewhere in
rem the same file: the spawned window opened and died before executing a
rem single line of the target script, with no visible error anywhere (not
rem Defender, not a Mark-of-the-Web block -- both checked and ruled out).
rem Confirmed by isolated testing (see claude/next-steps-routing.md).
rem Going-forward rule for THIS file: no multi-line parenthesized
rem `if (...)` / `if (...) else (...)` blocks with anything beyond plain
rem ASCII inside -- use single-line `if ... goto :label` instead. A FOR
rem loop's own `do ( ... )` block is fine as long as its body stays plain
rem ASCII (proven safe by testing). Plain `echo` lines with Cyrillic are
rem fine anywhere OUTSIDE a parenthesized block (e.g. under a :label).

rem /api/search depends entirely on Meilisearch (see
rem server/src/routes/search.js's top comment), so it has to be up before
rem the Node server is. Starting it here is fire-and-forget (its own
rem window, its own startup time) -- the Node server's src/index.js polls
rem Meilisearch's health endpoint and runs a full reindex itself before it
rem starts listening on 5173, so the wait loop below still works correctly
rem even if Meilisearch is still booting when this line returns.
call "%~dp0start-meilisearch.bat"
rem start-meilisearch.bat sets its own console `title` -- since it runs
rem via `call` (same window, not a separate process), that overwrites
rem THIS window's title too. Restore it so this window's own output stays
rem clearly attributed.
title SofiaMap - restart

rem Motis (route-planning engine, separate process, port 8081) -- same
rem fire-and-forget pattern as Meilisearch above, except the Node server
rem does NOT wait for it at startup (routing.js just returns a clear error
rem per-request until Motis answers). See start-motis.bat for what it
rem depends on.
call "%~dp0start-motis.bat"
title SofiaMap - restart

rem Valhalla (isochrone engine for "Зона доступности", separate process,
rem port 8082) -- same fire-and-forget pattern as Motis above, except the
rem Node server does NOT wait for it at startup either (isochrone.js just
rem returns a clear error per-request until it answers). See
rem start-valhalla.bat for what it depends on (a one-time
rem setup-valhalla.bat run).
call "%~dp0start-valhalla.bat"
title SofiaMap - restart

echo Stopping any server already using port 5173...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173"') do (
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "!FOUND!"=="1" echo Stopped previous server process.
if not "!FOUND!"=="1" echo No server was running on port 5173.
timeout /t 1 /nobreak >nul

echo Starting server - this also waits for Meilisearch plus a full reindex,
echo so "up" can take longer than before. Log: C:\SofiaMap\server.log
start "SofiaMap server" "C:\SofiaMap\server\_run-server.bat"

echo Waiting for the server to come up...
set MAX_WAIT=90
set WAITED=0

:waitloop
for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient('localhost',5173); $c.Close(); 'up' } catch { 'down' }"') do set PORT_STATE=%%R
if "!PORT_STATE!"=="up" goto :serverready
set /a WAITED+=1
if !WAITED! GEQ %MAX_WAIT% goto :timeout_msg
timeout /t 1 /nobreak >nul
goto :waitloop

:serverready
echo Server is up. Checking Motis (routing engine, port 8081)...
for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient('localhost',8081); $c.Close(); 'up' } catch { 'down' }"') do set MOTIS_STATE=%%R
if "!MOTIS_STATE!"=="up" goto :motis_up
echo Motis is not responding yet on port 8081 - route planning may show
echo an error until it finishes starting. Check the "SofiaMap motis" window.
goto :open_browser

:motis_up
echo Motis is up - route planning is available.

echo Checking Valhalla (isochrone engine, port 8082)...
for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient('localhost',8082); $c.Close(); 'up' } catch { 'down' }"') do set VALHALLA_STATE=%%R
if "!VALHALLA_STATE!"=="up" goto :valhalla_up
echo Valhalla is not responding yet on port 8082 - "Зона доступности" may show
echo an error until it finishes starting (or until setup-valhalla.bat has
echo been run at least once). Check the "SofiaMap valhalla" window.
goto :open_browser

:valhalla_up
echo Valhalla is up - "Зона доступности" is available.

:open_browser
echo Opening browser...
start "" http://localhost:5173/
goto :end

:timeout_msg
echo.
echo Server did not respond within %MAX_WAIT% seconds.
echo Check the "SofiaMap server", "SofiaMap meilisearch", "SofiaMap motis" and
echo "SofiaMap valhalla" windows - the cause should be visible there. These
echo windows stay open.
pause
goto :end

:end
timeout /t 1 /nobreak >nul
exit
