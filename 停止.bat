@echo off
setlocal
title Stop Pi Web Agent

set PORT=8420

echo.
echo  Stopping Pi Web Agent (port %PORT%) ...
echo.

for /f %%a in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"') do (
  echo  Stopping PID %%a ...
  taskkill /PID %%a /T /F >nul 2>nul
)

echo.
echo  Done.
ping -n 3 127.0.0.1 >nul
