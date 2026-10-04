@echo off
if "%~1"=="" (
  echo Supply the installation profile path. No default state or credentials will be loaded.
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Profile "%~1"
