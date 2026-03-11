@echo off
setlocal

REM Windows wrapper for the local Linear trigger HTTP server.
REM This mirrors start-linear-trigger-server.sh but uses native cmd.exe syntax.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "REPO_ROOT=%%~fI"

if "%LINEAR_TRIGGER_ENV_FILE%"=="" (
  set "ENV_FILE=%REPO_ROOT%\.env"
) else (
  set "ENV_FILE=%LINEAR_TRIGGER_ENV_FILE%"
)

if "%LINEAR_TRIGGER_SERVER_SCRIPT%"=="" (
  set "SERVER_SCRIPT=%SCRIPT_DIR%\linear-trigger-server.mjs"
) else (
  set "SERVER_SCRIPT=%LINEAR_TRIGGER_SERVER_SCRIPT%"
)

if not exist "%ENV_FILE%" (
  echo Missing env file: %ENV_FILE%
  exit /b 1
)

if not exist "%SERVER_SCRIPT%" (
  echo Missing trigger server script: %SERVER_SCRIPT%
  exit /b 1
)

if not exist "%REPO_ROOT%\logs" mkdir "%REPO_ROOT%\logs"
if not exist "%REPO_ROOT%\.automation-state" mkdir "%REPO_ROOT%\.automation-state"

cd /d "%SCRIPT_DIR%"
set "DOTENV_CONFIG_PATH=%ENV_FILE%"
node "%SERVER_SCRIPT%"
