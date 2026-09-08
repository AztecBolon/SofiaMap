@echo off
setlocal enabledelayedexpansion

rem SofiaMap: commit and push all pending changes.
rem Lives in the repo root (same place as restart-server.bat) so double-click
rem or `commit-and-push.bat` from a terminal both work regardless of the
rem current directory.
rem
rem Usage:
rem   commit-and-push.bat                -> commits with an auto timestamp message
rem   commit-and-push.bat My message here -> commits with that message instead

cd /d "%~dp0"

rem Force git to print straight to the console instead of piping through a
rem pager (less.exe on Windows) — a pager blocks the script waiting for a
rem keypress ("q" to continue), which looks like a hang when this runs
rem non-interactively or the user isn't expecting it.
set "GIT_PAGER=cat"

echo === SofiaMap: git commit ^& push ===
echo Repo: %cd%
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo Эта папка не git-репозиторий: %cd%
    goto :end
)

git add -A

git diff --cached --quiet
if not errorlevel 1 (
    echo Нет изменений для коммита.
    goto :end
)

if "%~1"=="" (
    set "MSG=Auto-commit %date% %time%"
) else (
    set "MSG=%*"
)

echo Изменения к коммиту:
git --no-pager diff --cached --stat
echo.
echo Коммит: !MSG!
git commit -m "!MSG!"
if errorlevel 1 (
    echo Коммит не удался, смотрите вывод выше.
    goto :end
)

echo.
echo Пуш в origin...
git push
if errorlevel 1 (
    echo Push не удался — смотрите вывод выше ^(например, нужна повторная авторизация^).
) else (
    echo Готово: изменения закоммичены и запушены.
)

:end
echo.
pause
