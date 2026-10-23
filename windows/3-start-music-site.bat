@echo off
setlocal
cd /d "%~dp0.."
if not exist "pyproject.toml" (
  echo.
  echo Can't find the project files next to this window's script.
  echo.
  echo This usually means the .bat file was opened from inside the zip.
  echo   1. Close this window.
  echo   2. Right-click music-library-windows.zip and choose "Extract All...", then click Extract.
  echo   3. Open the extracted music-library folder, then the windows folder,
  echo      and double-click this file again.
  echo.
  echo Script location: %~dp0
  pause
  exit /b 1
)
title Music library - website (close this window to stop it)
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
uv run app.py
echo.
pause
