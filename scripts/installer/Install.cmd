@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
set "AIPET_RESULT=%ERRORLEVEL%"
echo.
if not "%AIPET_RESULT%"=="0" echo Installation did not finish. Read the message above.
pause
exit /b %AIPET_RESULT%
