@echo off
rem ===================================================================
rem  fiber-briefing  auto-sync: append today's signals from the LOCAL
rem  briefing json to the knowledge card. Pure local, no LLM, no network.
rem  Safe to run repeatedly (idempotent).
rem
rem  Data source is LOCAL: data\<date>.json is produced on THIS machine
rem  by the briefing flow (agent_prepare.ps1 -> local LLM -> json).
rem  We never pull anything back from GitHub.
rem ===================================================================
setlocal
cd /d "%~dp0"

set PY="%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
set LOG=logs\auto-sync.log
if not exist logs mkdir logs

echo. >> "%LOG%"
echo ===== %DATE% %TIME% ===== >> "%LOG%"

rem --- run the local signal sync (reads local data\, idempotent) ---
%PY% scripts\sync_signals_local.py %* >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

echo [auto-sync] done rc=%RC% >> "%LOG%"
endlocal
exit /b %RC%
