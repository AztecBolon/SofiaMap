@echo off
setlocal enabledelayedexpansion
title SofiaMap - restart
echo ============================================
echo   SofiaMap: restarting server...
echo ============================================

cd /d C:\SofiaMap\server

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

echo Starting server...
start "SofiaMap server" cmd /k "node src\index.js"

echo Waiting for the server to come up...
set MAX_WAIT=20
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
echo Посмотрите окно "SofiaMap server" - там должна быть причина ошибки.
echo Это окно останется открытым.
pause
goto :end

:end
timeout /t 1 /nobreak >nul
exit
