@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
node server.cjs --open
pause
