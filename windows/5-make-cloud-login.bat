@echo off
setlocal
cd /d "%~dp0.."
if not exist "pyproject.toml" (
  echo.
  echo Can't find the project files next to this window's script.
  echo Extract the zip first, then run this from the extracted music-library\windows folder.
  pause
  exit /b 1
)
title Music library - create cloud login
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
uv run make_cloud_login.py
echo.
echo Copy the long session string above into the TG_SESSION secret on Hugging Face.
echo Then close this window. The string is not saved anywhere on this PC.
pause
