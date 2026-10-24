@echo off
rem Runs scripts\flutter-windows.ps1 from cmd, a double-click or PowerShell
rem with scripts blocked: flutter-windows.cmd [doctor|run|test|build|onefile] [file] [-Release]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0flutter-windows.ps1" %*
exit /b %ERRORLEVEL%
