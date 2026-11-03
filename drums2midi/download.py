"""Step 1: download a YouTube video's audio as MP3 using yt-dlp."""
import os
import shutil
import sys
from pathlib import Path
from typing import Callable, Optional

import yt_dlp


def _js_runtimes() -> dict:
    # YouTube needs a JS runtime to solve its player challenges. Prefer the deno bundled via
    # `yt-dlp[deno]` (works on macOS and Windows without a separate install), else any installed one.
    runtimes = {}
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "bin" / ("deno.exe" if os.name == "nt" else "deno")
    if getattr(sys, "frozen", False) and bundled.exists():  # packaged app
        runtimes["deno"] = {"path": str(bundled)}
    else:
        try:
            import deno

            runtimes["deno"] = {"path": deno.find_deno_bin()}
        except Exception:
            pass
    for name in ("deno", "node", "bun"):
        path = shutil.which(name)
        if path and name not in runtimes:
            runtimes[name] = {"path": path}
    return runtimes or {"deno": {}}


def ffmpeg_exe() -> str:
    """System ffmpeg if installed, else the static build shipped with imageio-ffmpeg (macOS/Windows/Linux)."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def download_mp3(url: str, out_dir: Path, on_progress: Optional[Callable[[float, str], None]] = None) -> dict:
    """Download `url` to `out_dir/song.mp3`. Returns {"path", "title", "duration"}."""
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if not on_progress:
            return
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = d.get("downloaded_bytes", 0) / total if total else 0.0
            on_progress(frac, f"Downloading… {frac * 100:.0f}%")
        elif d["status"] == "finished":
            on_progress(1.0, "Converting to MP3…")

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "song.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "js_runtimes": _js_runtimes(),
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
        ],
    }
    opts["ffmpeg_location"] = ffmpeg_exe()

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    mp3 = out_dir / "song.mp3"
    if not mp3.exists():
        raise RuntimeError("yt-dlp finished but song.mp3 was not created")
    return {"path": mp3, "title": info.get("title") or "Unknown", "duration": info.get("duration")}
