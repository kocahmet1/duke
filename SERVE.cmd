@echo off
rem  NUKE ZONE 3D - local dev server launcher.  Needs Node.js on PATH.
cd /d "%~dp0"
echo Starting the Nuke Zone 3D dev server on http://127.0.0.1:4173/ ...
start "NUKE ZONE 3D server" cmd /k node scripts/serve-game.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/NUKEM.html#level=4"
exit /b 0
