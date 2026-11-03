# PyInstaller spec for the self-contained desktop app. Build with:  uv run python packaging/build.py
import sys
from pathlib import Path

import deno
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
APP = "Drums to MIDI"

datas = [
    (str(ROOT / "static"), "static"),
    (str(ROOT / "packaging" / "models"), "models"),  # Demucs weights, fetched by build.py
]
for pkg in ("demucs", "adtof_pytorch", "yt_dlp_ejs", "pretty_midi", "librosa"):
    datas += collect_data_files(pkg)

binaries = [(deno.find_deno_bin(), "bin")]  # JS runtime yt-dlp uses for YouTube

hiddenimports = collect_submodules("demucs") + collect_submodules("adtof_pytorch") + ["drums2midi.midi_import"]

a = Analysis(
    [str(ROOT / "launcher.py")],
    pathex=[str(ROOT)],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    excludes=["matplotlib", "IPython", "pytest", "tensorboard", "torchvision", "notebook"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DrumsToMIDI",
    console=False,  # the launcher shows its own small window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="DrumsToMIDI")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name=f"{APP}.app",
        bundle_identifier="io.github.lielgut.drums-to-midi",
        info_plist={
            "CFBundleDisplayName": APP,
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "12.0",
        },
    )
