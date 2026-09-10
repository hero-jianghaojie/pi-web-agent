@echo off
setlocal
title Pi Web Agent
cd /d "%~dp0"

rem --- check Node.js ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js is not installed or not in PATH.
  echo  Install it from: https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem --- check pi -------------------------------------------------------------
where pi >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] The "pi" command was not found.
  echo  Install it with:
  echo    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  echo  Then log in with:  pi /login
  echo.
  pause
  exit /b 1
)

echo.
echo  ===================================================
echo    Pi Web Agent is starting...
echo    Browser will open at http://127.0.0.1:8420
echo    Keep this window open. Close it to stop.
echo  ===================================================
echo.

node server.js --open %*

echo.
echo  Server stopped.
pause
