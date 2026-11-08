@echo off
rem ieumoffice launcher for the packaged Windows app: <install>\resources\cli\ieumoffice.cmd
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\IeumOffice.exe" "%~dp0genoffice.cjs" %*
endlocal
