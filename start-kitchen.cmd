@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is required. Install Node.js 24.14 or later in the 24.x series.
  pause
  exit /b 1
)
node server.mjs --kitchen
if errorlevel 1 pause

