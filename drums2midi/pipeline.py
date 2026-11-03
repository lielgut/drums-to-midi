"""YouTube URL -> song.mp3 -> drums.wav -> drums.mid. Usable from the web app or the command line."""
import json
import sys
import time
from pathlib import Path
from typing import Callable, Optional

from .download import download_mp3
from .separate import separate_drums
from .transcribe import transcribe

STEPS = ["download", "separate", "transcribe"]


def run(url: str, job_dir: Path, report: Optional[Callable[[str, float, str], None]] = None) -> dict:
    """Run all steps. `report(step, fraction, message)` is called with progress updates."""
    report = report or (lambda step, frac, msg: print(f"[{step}] {msg}", flush=True))
    job_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()

    meta = download_mp3(url, job_dir, lambda f, m: report("download", f, m))
    report("download", 1.0, f"Downloaded “{meta['title']}”")

    drums = separate_drums(meta["path"], job_dir / "drums.wav", lambda f, m: report("separate", f, m))

    result = transcribe(drums, job_dir, lambda f, m: report("transcribe", f, m))
    result.update(title=meta["title"], url=url, elapsed=round(time.time() - started, 1))
    (job_dir / "result.json").write_text(json.dumps(result))
    report("transcribe", 1.0, f"Done — {len(result['notes'])} drum hits at ~{result['tempo']:.0f} BPM")
    return result


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):  # Unicode-safe output on Windows consoles
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if len(sys.argv) < 2:
        sys.exit("usage: python -m drums2midi.pipeline <youtube-url> [output-dir]")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("jobs/cli")
    run(sys.argv[1], out)
    print(f"Outputs written to {out.resolve()}")
