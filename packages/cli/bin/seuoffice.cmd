@echo off
rem seuoffice launcher for the packaged Windows app: <install>\resources\cli\seuoffice.cmd
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\SeuOffice.exe" "%~dp0seuoffice.cjs" %*
endlocal
