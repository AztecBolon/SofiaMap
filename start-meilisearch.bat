@echo off
setlocal enabledelayedexpansion
title SofiaMap - meilisearch
echo ============================================
echo   SofiaMap: starting Meilisearch...
echo ============================================

echo Stopping any Meilisearch already using port 7700...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":7700"') do (
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "!FOUND!"=="1" (
    echo Stopped previous Meilisearch process.
) else (
    echo No Meilisearch was running on port 7700.
)
timeout /t 1 /nobreak >nul

if not exist "%~dp0meilisearch\data" mkdir "%~dp0meilisearch\data"

echo Starting Meilisearch (log: %~dp0meilisearch.log)...
start "SofiaMap meilisearch" cmd /k "%~dp0meilisearch\_run-meilisearch.bat"
