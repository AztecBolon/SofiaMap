@echo off
setlocal enabledelayedexpansion
set LOG=%~dp0setup-meilisearch.log
echo ============================================ > "%LOG%"
echo   SofiaMap: one-time Meilisearch setup >> "%LOG%"
echo   %DATE% %TIME% >> "%LOG%"
echo ============================================ >> "%LOG%"

set MEILI_VERSION=v1.53.2
set MEILI_DIR=%~dp0meilisearch
set MEILI_EXE=%MEILI_DIR%\meilisearch.exe
set MEILI_URL=https://github.com/meilisearch/meilisearch/releases/download/%MEILI_VERSION%/meilisearch-windows-amd64.exe

if not exist "%MEILI_DIR%" mkdir "%MEILI_DIR%"

rem Always re-check the existing file's size/signature before trusting it -
rem a previous run may have saved a truncated or corrupted (e.g. an HTML
rem error page instead of the binary) download under the right name.
if exist "%MEILI_EXE%" (
    echo Found existing file at %MEILI_EXE% - checking it... >> "%LOG%"
    powershell -NoProfile -Command ^
      "$f = Get-Item '%MEILI_EXE%'; Write-Host ('size: ' + $f.Length + ' bytes'); $fs = [System.IO.File]::OpenRead('%MEILI_EXE%'); $b = New-Object byte[] 2; $fs.Read($b,0,2) | Out-Null; $fs.Close(); $sig = [System.Text.Encoding]::ASCII.GetString($b); Write-Host ('signature: ' + $sig); if ($sig -ne 'MZ') { Write-Host 'INVALID - not a Windows executable (probably a corrupted/incomplete download)'; exit 1 }" >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo Existing file is invalid - deleting it so it gets re-downloaded. >> "%LOG%"
        del /f /q "%MEILI_EXE%"
    ) else (
        echo Existing file looks like a valid .exe - keeping it. >> "%LOG%"
    )
)

if exist "%MEILI_EXE%" (
    echo Skipping download - valid file already present. >> "%LOG%"
) else (
    echo. >> "%LOG%"
    echo Downloading Meilisearch %MEILI_VERSION% from: >> "%LOG%"
    echo   %MEILI_URL% >> "%LOG%"
    echo to: %MEILI_EXE% >> "%LOG%"
    powershell -NoProfile -Command ^
      "$ProgressPreference='SilentlyContinue'; try { $resp = Invoke-WebRequest -Uri '%MEILI_URL%' -OutFile '%MEILI_EXE%' -UseBasicParsing -PassThru; Write-Host ('HTTP status: ' + $resp.StatusCode) } catch { Write-Host ('DOWNLOAD FAILED: ' + $_.Exception.Message); exit 1 }" >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo DOWNLOAD FAILED - see messages above. Stopping. >> "%LOG%"
        goto :done
    )
    if not exist "%MEILI_EXE%" (
        echo Download did not produce the expected file. Stopping. >> "%LOG%"
        goto :done
    )
    echo. >> "%LOG%"
    echo Verifying the downloaded file... >> "%LOG%"
    powershell -NoProfile -Command ^
      "$f = Get-Item '%MEILI_EXE%'; Write-Host ('size: ' + $f.Length + ' bytes'); $fs = [System.IO.File]::OpenRead('%MEILI_EXE%'); $b = New-Object byte[] 2; $fs.Read($b,0,2) | Out-Null; $fs.Close(); $sig = [System.Text.Encoding]::ASCII.GetString($b); Write-Host ('signature: ' + $sig); if ($sig -ne 'MZ') { Write-Host 'INVALID - downloaded file is not a Windows executable'; exit 1 }" >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo Downloaded file failed verification - see messages above. Stopping. >> "%LOG%"
        goto :done
    )
    echo Download OK. >> "%LOG%"
)

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   Installing/updating npm dependencies... >> "%LOG%"
echo ============================================ >> "%LOG%"
cd /d "%~dp0server"
call npm install >> "%LOG%" 2>&1
if errorlevel 1 (
    echo. >> "%LOG%"
    echo NPM INSTALL FAILED - see messages above. >> "%LOG%"
    goto :done
)

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   SETUP COMPLETE >> "%LOG%"
echo ============================================ >> "%LOG%"
echo Meilisearch binary: %MEILI_EXE% >> "%LOG%"
echo npm dependencies installed in: %~dp0server >> "%LOG%"
echo Next step: run restart-server.bat >> "%LOG%"

:done
echo.
echo Finished. Full details were written to:
echo   %LOG%
echo (this window will stay open - press any key to close it)
pause
