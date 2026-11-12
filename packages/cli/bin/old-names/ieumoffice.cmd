@echo off
rem The command's name before SeuOffice took its own (old-names.ts, OLD_CLI_COMMANDS).
rem The Windows PATH entry <install>\resources\cli still finds it; it hands every call to seuoffice.cmd beside it.
rem No "call": that would parse the line a second time and double a caret inside a quoted argument.
"%~dp0seuoffice.cmd" %*
