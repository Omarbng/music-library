@echo off
setlocal
cd /d "%~dp0.."
if not exist "pyproject.toml" (
  echo.
  echo Can't find the project files next to this window's script.
  echo Extract the zip first: right-click it, choose "Extract All...", then run this
  echo from the extracted music-library\windows folder.
  pause
  exit /b 1
)
title Music library - website from Telegram (close this window to stop it)
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "MUSIC_STORAGE=telegram"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
echo The first time, the website signs in to Telegram on its own:
echo enter the phone number, then the 5-digit code from the Telegram app.
echo.
uv run app.py
echo.
pause
