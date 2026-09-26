@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  npm install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Claude MultiAgent Manager...
npm start

echo.
echo App exited.
pause
