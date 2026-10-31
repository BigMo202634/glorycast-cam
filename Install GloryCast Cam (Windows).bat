@echo off
title Install GloryCast Cam
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0server\server.js" --install
echo.
echo Press any key to close this window.
pause >nul
