@echo off
rem Extract signals from local briefing json into the knowledge card.
rem Pure local, no LLM, no GitHub. Idempotent.
rem Usage: sync-signals.bat            (latest briefing)
rem        sync-signals.bat 2026-10-15
rem        sync-signals.bat --all
rem        sync-signals.bat --dry-run
cd /d "%~dp0"
"%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" scripts\sync_signals_local.py %*
