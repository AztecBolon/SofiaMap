@echo off
setlocal enabledelayedexpansion
set LOG=%~dp0setup-valhalla.log
echo ============================================ > "%LOG%"
echo   SofiaMap: one-time Valhalla (isochrone) setup >> "%LOG%"
echo   %DATE% %TIME% >> "%LOG%"
echo ============================================ >> "%LOG%"

rem See claude/next-steps-walkability-isochrone.md for the background.
rem "Зона доступности" needs a routing graph + engine that can answer
rem "isochrone" queries over the real pedestrian street network -- Valhalla,
rem via its Python bindings (pyvalhalla) rather than the official Docker
rem image, because lx15pro has no Docker/Docker Desktop installed and every
rem other satellite process here (Motis, Meilisearch) already runs as a
rem plain native Windows process, not a container. pyvalhalla ships
rem prebuilt Windows wheels, so this is "pip install" + a one-time graph
rem build, not a source build.
rem
rem Same "rewrite from scratch, no multi-line parenthesized if-blocks with
rem anything beyond ASCII inside" rule as the other setup/start .bat files
rem in this repo applies here too (see restart-server.bat's own long
rem comment on the cmd.exe parsing bug that rule works around).

set VDIR=%~dp0routing-proto\valhalla
set VENV=%VDIR%\venv
set PBF=%~dp0raw\sofia.osm.pbf

if not exist "%VDIR%" mkdir "%VDIR%"

if not exist "%PBF%" (
    echo [!] %PBF% not found -- nothing to build the graph from. Stopping. >> "%LOG%"
    goto :done
)

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   Creating/checking Python venv at %VENV% >> "%LOG%"
echo ============================================ >> "%LOG%"
if exist "%VENV%\Scripts\python.exe" goto :venv_exists
python -m venv "%VENV%" >> "%LOG%" 2>&1
if errorlevel 1 (
    echo VENV CREATION FAILED -- is "python" on PATH? See messages above. >> "%LOG%"
    goto :done
)
goto :venv_ready
:venv_exists
echo Found existing venv -- keeping it. >> "%LOG%"
:venv_ready

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   Installing pyvalhalla + flask into the venv >> "%LOG%"
echo ============================================ >> "%LOG%"
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip >> "%LOG%" 2>&1
"%VENV%\Scripts\python.exe" -m pip install pyvalhalla flask >> "%LOG%" 2>&1
if errorlevel 1 (
    echo PIP INSTALL FAILED -- see messages above. Stopping. >> "%LOG%"
    goto :done
)

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   Building the routing graph from %PBF% >> "%LOG%"
echo   (this rebuilds from scratch every time -- a few minutes on a >> "%LOG%"
echo   city-sized extract; re-run this whole script whenever >> "%LOG%"
echo   raw\sofia.osm.pbf is refreshed) >> "%LOG%"
echo ============================================ >> "%LOG%"
"%VENV%\Scripts\python.exe" "%VDIR%\build_graph.py" >> "%LOG%" 2>&1
if errorlevel 1 (
    echo GRAPH BUILD FAILED -- see messages above. Stopping. >> "%LOG%"
    goto :done
)

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo   SETUP COMPLETE >> "%LOG%"
echo ============================================ >> "%LOG%"
echo Venv: %VENV% >> "%LOG%"
echo Graph tiles: %VDIR%\tiles >> "%LOG%"
echo Next step: run restart-server.bat (starts Valhalla alongside everything else) >> "%LOG%"

:done
echo.
echo Finished. Full details were written to:
echo   %LOG%
echo (this window will stay open - press any key to close it)
pause
