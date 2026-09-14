@echo off
setlocal enabledelayedexpansion
title SofiaMap - restart
echo ============================================
echo   SofiaMap: restarting server...
echo ============================================

rem 2026-09-14 (Meilisearch migration): /api/search now depends entirely on
rem Meilisearch (no more SQL fallback — see server/src/routes/search.js's
rem top comment), so it has to be up before the Node server is. Starting it
rem here is fire-and-forget (its own window, its own startup time) — the
rem Node server's src/index.js polls Meilisearch's health endpoint and runs
rem a full reindex itself before it starts listening on 5173, so the wait
rem for "actually ready" below still works correctly even if Meilisearch is
rem still booting when this line returns.
call "%~dp0start-meilisearch.bat"

echo Stopping any server already using port 5173...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173"') do (
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "!FOUND!"=="1" (
    echo Stopped previous server process.
) else (
    echo No server was running on port 5173.
)
timeout /t 1 /nobreak >nul

echo Starting server - this also waits for Meilisearch plus a full reindex,
echo so "up" can take longer than before. Log: C:\SofiaMap\server.log
start "SofiaMap server" cmd /k "C:\SofiaMap\server\_run-server.bat"

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
echo Server is up, opening browser...
start "" http://localhost:5173/
goto :end

:timeout_msg
echo.
echo Сервер не ответил за %MAX_WAIT% секунд.
echo Посмотрите окна "SofiaMap server" и "SofiaMap meilisearch" - там должна быть причина ошибки.
echo Эти окна останутся открытыми.
pause
goto :end

:end
timeout /t 1 /nobreak >nul
exit
