#!/bin/sh
# macOS / Linux: start the Drums -> MIDI web app at http://127.0.0.1:5055 and open it in the browser.
# First run installs everything (Python, PyTorch, ffmpeg, deno) into .venv via uv.
cd "$(dirname "$0")" || exit 1
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is not installed. Install it with:"
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi
exec uv run python app.py --open
