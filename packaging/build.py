"""Build the self-contained app for the current OS and zip it into dist/.

    uv run python packaging/build.py

macOS → dist/DrumsToMIDI-macOS-arm64.zip (contains "Drums to MIDI.app")
Windows → dist/DrumsToMIDI-Windows-x64.zip (contains a DrumsToMIDI folder with DrumsToMIDI.exe)
PyInstaller can't cross-compile: build each one on its own OS (CI does both, see .github/workflows/build.yml).
"""
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "packaging" / "models"
DIST = ROOT / "dist"


def fetch_model():
    """Download the Demucs htdemucs weights into packaging/models (same layout as the torch hub cache)."""
    os.environ["TORCH_HOME"] = str(MODELS)
    from demucs.pretrained import get_model

    get_model("htdemucs")
    print("Demucs model ready:", [p.name for p in (MODELS / "hub" / "checkpoints").iterdir()])


def main():
    fetch_model()
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
         "--distpath", str(DIST), "--workpath", str(ROOT / "build"), str(ROOT / "packaging" / "drums2midi.spec")],
        check=True,
    )
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(platform.machine(), platform.machine())
    if sys.platform == "darwin":
        name, target = f"DrumsToMIDI-macOS-{arch}.zip", DIST / "Drums to MIDI.app"
        out = DIST / name
        out.unlink(missing_ok=True)
        # ditto keeps the app bundle's symlinks and permissions intact
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(target), str(out)], check=True)
    else:
        name, target = f"DrumsToMIDI-Windows-{arch}", DIST / "DrumsToMIDI"
        out = Path(shutil.make_archive(str(DIST / name), "zip", DIST, target.name))
    print(f"Built {out} ({out.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
