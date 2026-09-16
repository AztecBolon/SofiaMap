@echo off
setlocal enabledelayedexpansion

rem SofiaMap: one-time cleanup — stop tracking the runtime log files
rem (server.log/meilisearch.log/setup-meilisearch.log) that .gitignore now
rem excludes. Adding them to .gitignore alone does NOT stop git from
rem tracking changes to files it already has in the index — `git rm
rem --cached` removes them from tracking WITHOUT deleting the actual files
rem on disk, so the server keeps writing to them as before.
rem
rem Safe to run more than once: `git rm --cached` on a file that isn't
rem tracked just prints a harmless "did not match any files" and continues
rem (errors from that command are suppressed below for exactly this case).

cd /d "%~dp0"

set "GIT_PAGER=cat"

echo === SofiaMap: перестать отслеживать лог-файлы в git ===
echo Репозиторий: %cd%
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo Эта папка не git-репозиторий: %cd%
    goto :end
)

git rm --cached server.log meilisearch.log setup-meilisearch.log >nul 2>&1

git diff --cached --quiet
if not errorlevel 1 (
    echo Эти файлы и так уже не отслеживались — делать нечего.
    goto :end
)

echo Убираю из git ^(файлы на диске остаются как есть^):
git --no-pager diff --cached --stat
echo.

git commit -m "Stop tracking local runtime logs (server.log/meilisearch.log/setup-meilisearch.log)"
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
    echo Готово: лог-файлы больше не отслеживаются git'ом.
)

:end
echo.
pause
