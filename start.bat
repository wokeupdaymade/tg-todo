@echo off
rem Big green start button: double-click to run the bot. Close this window to stop it.
title Telegram To-Do  -  close this window to stop the bot
color 0A
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org and run start.bat again.
  echo.
  pause
  exit /b 1
)
node scripts\launcher.mjs
echo.
echo   The bot is stopped.
pause
