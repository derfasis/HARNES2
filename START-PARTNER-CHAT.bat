@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\partner-chat.ps1" -Action Start
if errorlevel 1 pause
