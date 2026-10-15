@echo off
rem Sync local signals card from cloud snapshot
rem Usage: sync-signals.bat   (git pull + backfill card)
rem        sync-signals.bat --no-pull
rem        sync-signals.bat --dry-run
cd /d "%~dp0"
node scripts\sync_signals_local.js %*
