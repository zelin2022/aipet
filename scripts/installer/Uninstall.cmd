@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" %*
set "AIPET_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %AIPET_RESULT%
