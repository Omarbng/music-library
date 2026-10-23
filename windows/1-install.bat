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
title Music library - install
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 (
  echo Installing uv, the Python tool this project uses...
  powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
where uv >nul 2>nul
if errorlevel 1 (
  echo.
  echo Could not install uv. Install it from https://docs.astral.sh/uv/ and run this again.
  pause
  exit /b 1
)
echo Setting up Python and the project's packages. The first time takes a few minutes...
uv sync
if errorlevel 1 (
  echo.
  echo Setup failed. Scroll up to see the error.
  pause
  exit /b 1
)
echo.
echo Done. Next: double-click 2-upload-to-telegram.bat
pause
