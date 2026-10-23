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
title Music library - upload to Telegram
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
echo Checking what still needs uploading...
echo.
uv run telegram_upload.py --dry-run %*
if errorlevel 1 goto failed
echo.
choice /M "Upload these to Telegram now"
if errorlevel 2 goto end
uv run telegram_upload.py %*
if errorlevel 1 goto failed
goto end
:failed
echo.
echo Something went wrong. Scroll up to see the message.
:end
echo.
pause
