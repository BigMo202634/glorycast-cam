@echo off
title GloryCast Cam
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0server\server.js" --open
echo.
echo GloryCast Cam has stopped. Press any key to close this window.
pause >nul
