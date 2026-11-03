@echo off
rem Windows: start the Drums -> MIDI web app at http://127.0.0.1:5055 and open it in the browser.
rem First run installs everything (Python, PyTorch, ffmpeg, deno) into .venv via uv.
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
  echo uv is not installed. Install it in PowerShell with:
  echo   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  echo Then open a new terminal and run this file again.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git is required for the first install ^(one dependency is fetched from GitHub^).
  echo Install it with:  winget install --id Git.Git -e
  pause
  exit /b 1
)
set PYTHONUTF8=1
uv run python app.py --open
if errorlevel 1 pause
