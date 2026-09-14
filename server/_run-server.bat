@echo off
rem Actual Node server launch logic, kept in its own file for the same
rem reason as meilisearch\_run-meilisearch.bat — see that file's comment.
cd /d "%~dp0"
call meili-env.bat
node src\index.js > C:\SofiaMap\server.log 2>&1
