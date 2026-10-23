@echo off
cd /d "%~dp0.."
if not exist "pyproject.toml" (
  echo Extract the zip first: right-click it, choose "Extract All...", then run this from the extracted windows folder.
  pause
  exit /b 1
)
if not exist ".env" type nul > ".env"
notepad ".env"
