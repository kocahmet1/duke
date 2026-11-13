@echo off
rem  NUKE ZONE 3D - local multiplayer server (see MULTIPLAYER.md). Needs Node.js on PATH.
cd /d "%~dp0"
echo Starting the multiplayer server on http://127.0.0.1:4173/ ...
start "NUKE ZONE 3D multiplayer server" cmd /k node server/mp-server.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/"
exit /b 0
