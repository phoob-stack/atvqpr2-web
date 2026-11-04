@echo off
rem ATV: Quad Power Racing 2 - build it for the browser from your own game files.
rem   build-atv2.cmd                      asks for your game folder
rem   build-atv2.cmd "D:\Games\ATV2"      the folder with default.xbe, ATV.bah, ATV.bad
rem   build-atv2.cmd --help               all options (work folder, wasi-sdk, port...)
rem Needs Node.js, Python 3.10+ with capstone, Git for Windows (Git Bash); see README.md.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 LTS or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0builder.mjs" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo The builder stopped with an error ^(code %RC%^). See the message above.
  rem Keep the window open when started by double-click.
  echo %CMDCMDLINE% | find /i "/c" >nul && pause
)
exit /b %RC%
