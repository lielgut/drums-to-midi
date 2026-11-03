# 🥁 Drums → MIDI

Turn the drum part of any song into MIDI, a printable drum sheet, and a play-along view.

Paste a YouTube link (or upload a MIDI file) and the app:

1. downloads the audio as MP3 ([yt-dlp](https://github.com/yt-dlp/yt-dlp)),
2. isolates the drums ([Demucs](https://github.com/facebookresearch/demucs) `htdemucs`),
3. transcribes them to MIDI ([ADTOF-pytorch](https://github.com/xavriley/ADTOF-pytorch): kick, snare, toms, hi-hat, cymbals) and tracks the tempo and beats ([librosa](https://librosa.org)).

Everything runs locally in your browser at `http://127.0.0.1:5055`.

## Features

- **Four views** of the drum part, switchable with tabs:
  - **Drum roll**: one lane per instrument with a bar/beat grid. Click to seek, drag or scroll to browse, zoom.
  - **Drum sheet**: standard drum notation quantized to 16th notes. The current bar is highlighted during playback; click a bar to jump there.
  - **Drum view**: a 2D kit with notes falling onto each drum, Guitar Hero style.
  - **3D view**: the same idea with a 3D kit you can rotate in any direction, with camera presets and auto-rotate.
- **Game mode**: play the drums on your keyboard in full screen, using the Drum view or 3D view. See [Game mode](#game-mode).
- **Playback**: the drum stem or the original song, layered with built-in drum sounds playing the MIDI (separate volumes).
- **Slow motion**: 0.25× to 1.5× without changing pitch; the MIDI and every view follow.
- **Sensitivity sliders** per instrument re-detect hits instantly, without re-processing.
- **MIDI upload**: use an existing MIDI file's drum track (channel 10) instead of a YouTube link. Playback then uses only the built-in drum sounds.
- **Downloads**: MP3, drum stem WAV, `drums.mid` (original timing), `drums_quantized.mid` (grid-aligned at a constant tempo, best for MuseScore or a DAW), and the sheet as PDF.

## Download (no installation)

Ready-to-run apps are on the [Releases page](https://github.com/lielgut/drums-to-midi/releases/latest). Everything is included (Python, PyTorch, ffmpeg and the Demucs model), so there's nothing else to install. The download is about 350 MB, and the unzipped app takes about 800 MB.

### macOS (Apple Silicon)

1. Download `DrumsToMIDI-macOS-arm64.zip` and double-click it to unzip.
2. Drag **Drums to MIDI.app** into your **Applications** folder.
3. The app isn't signed by Apple, so the first launch is blocked. Open it once, click **Done**, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to "Drums to MIDI". You only do this once.

### Windows (64-bit)

1. Download `DrumsToMIDI-Windows-x64.zip`, right-click it and choose **Extract All**. Don't run it from inside the zip.
2. Open the extracted `DrumsToMIDI` folder and double-click **DrumsToMIDI.exe**.
3. If Windows shows "Windows protected your PC", click **More info → Run anyway**. The app isn't code-signed, so this appears the first time.

### Using the app

A small **Drums to MIDI** window opens and your browser opens the app. Keep the small window open while you use the app; click **Quit** in it to close it. The first launch takes a little longer.

Results are saved in `~/Library/Application Support/DrumsToMIDI` on macOS and `%LOCALAPPDATA%\DrumsToMIDI` on Windows. If the app doesn't start, check `log.txt` in that folder.

## Run from source

Use this if you want to change the code, or if you're on a system without a prebuilt app.

### Requirements

| | macOS | Windows |
|---|---|---|
| System | Apple Silicon (M1 or later), macOS 12+ | Windows 10/11, 64-bit (x64) |
| Tools | [uv](https://docs.astral.sh/uv/) and Git | [uv](https://docs.astral.sh/uv/) and Git |
| Disk | about 3 GB (Python packages + models) | about 3 GB |

uv installs the right Python version, PyTorch, ffmpeg and a JavaScript runtime for yt-dlp into the project folder, so you don't need to install those yourself. The first run downloads everything (a few minutes); later starts are fast.

Intel Macs aren't supported: the PyTorch version used here has no Intel Mac build.

The page loads a few JavaScript libraries (three.js, VexFlow, jsPDF) from a CDN, so you need an internet connection while using it.

### Installation

#### macOS

1. Open **Terminal**.
2. Install Git (skip if `git --version` already works). This installs Apple's command line tools:

   ```bash
   xcode-select --install
   ```

3. Install uv, then close and reopen Terminal:

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

4. Download the project and start it:

   ```bash
   git clone https://github.com/lielgut/drums-to-midi.git
   cd drums-to-midi
   ./run.sh
   ```

#### Windows

1. Open **PowerShell**.
2. Install Git (skip if `git --version` already works):

   ```powershell
   winget install --id Git.Git -e
   ```

3. Install uv:

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

4. Close and reopen PowerShell, then download the project and start it:

   ```powershell
   git clone https://github.com/lielgut/drums-to-midi.git
   cd drums-to-midi
   .\run.bat
   ```

   You can also double-click `run.bat` in File Explorer.

## Usage

Open the downloaded app, or start from source with `./run.sh` (macOS) or `run.bat` (Windows). Your browser opens `http://127.0.0.1:5055`. Keep the app's small window (or the terminal, when running from source) open while you use it. To stop, click **Quit** or press `Ctrl+C` in the terminal.

### From a YouTube link

1. Paste a YouTube URL and click **Convert**.
2. Watch the three steps: download, isolate drums, transcribe. A 4-minute song takes about 20 seconds on an Apple Silicon Mac and a few minutes on a Windows PC (processing runs on the CPU there).
3. When it's done, press ▶ and switch between the **Drum roll**, **Drum sheet**, **Drum view** and **3D view** tabs.

### From a MIDI file

Click **Upload MIDI** (or drop a `.mid` file onto the top card). The drum track must be on MIDI channel 10, which is the standard for drums. Its notes are grouped into the five kit pieces:

| Kit piece | General MIDI notes |
|---|---|
| Kick | 35, 36 |
| Snare | 37–40 (includes side stick and clap) |
| Toms | 41, 43, 45, 47, 48, 50 |
| Hi-hat | 42, 44, 46 (closed, pedal, open) |
| Cymbals | 49, 51, 52, 53, 55, 57, 59 (crash, ride, china, splash) |

Other percussion and non-drum instruments are ignored. Tempo and bar lines come from the file.

### Controls

| Control | What it does |
|---|---|
| **Audio** | Hear the drum stem, the original song, or only the MIDI drum sounds |
| **Speed** | Slow motion (0.25×–1.5×) without changing pitch |
| **Sensitivity** | Lower a slider to detect more hits for that instrument, raise it for fewer |
| **Bar starts on beat** | Shift the bar lines if bar 1 was detected on the wrong beat |
| **Look-ahead** | How far ahead you see notes coming in the Drum view and 3D view |
| **3D camera** | Drag to rotate, right-drag to pan, scroll to zoom, double-click to reset. Buttons jump to Drummer / Front / Top / Side |

Previous results are listed under **Previous jobs** and stored in the `jobs/` folder (one subfolder per song).

### Game mode

Click **🎮 Game mode** next to the play button. The game opens full screen; press **Esc** to close it at any time.

1. Pick the **view** (Drum view or 3D view), the **mode**, the backing audio and the speed, then press **Enter** or **Start**.
2. After a 3-second countdown, hit the key shown above each drum as its note lands:

   | Drum | Key |
   |---|---|
   | Hi-hat | D |
   | Snare | F |
   | Kick | Space |
   | Toms | J |
   | Cymbals | K |

   Keys are matched by position, so they work with any keyboard layout.
3. Each hit is judged on the spot: **Perfect** (within 50 ms), **Good** (within 100 ms), **Early / Late** with the offset in ms (within 180 ms), **Miss** when a note passes without a hit, and **✕ no note** for a key pressed when nothing was due.

| Mode | How it plays |
|---|---|
| **Play along** | The song keeps going. Combos raise a score multiplier (up to ×4); misses and stray hits reset the combo |
| **Wait for me** | Practice: the song pauses at each note (or chord) and shows which keys to press, then continues when you hit them |

Your key presses make the drum sounds; the automatic MIDI drums are muted. For the backing track, choose the original song, the drum stem, or nothing. At the end you get a score, accuracy, max combo, a grade (S–D) and a breakdown of every judgment.

### Command line (no UI)

```bash
uv run python -m drums2midi.pipeline "https://www.youtube.com/watch?v=..." out
```

This writes `song.mp3`, `drums.wav`, `drums.mid` and `drums_quantized.mid` to the `out` folder. It works the same on macOS and Windows.

## Troubleshooting

| Problem | Fix |
|---|---|
| `uv: command not found` / `'uv' is not recognized` | Close and reopen the terminal after installing uv |
| Port 5055 is already in use | Start on another port: `PORT=5056 uv run python app.py --open` (macOS) or `$env:PORT=5056; .\run.bat` (Windows PowerShell) |
| YouTube downloads start failing | YouTube changes often; update yt-dlp with `uv lock --upgrade-package yt-dlp` then `uv sync` |
| The first run seems stuck | It's downloading PyTorch and, on the first song, the Demucs model (~80 MB). Watch the terminal |
| Bar lines are off by a beat | Use **Bar starts on beat** above the drum sheet |

## Accuracy and limitations

- The transcription knows five classes. It can't tell open from closed hi-hat, crash from ride, or one tom from another.
- The sheet is automatically quantized to 16th notes in 4/4 time. It doesn't add ghost notes, accents, flams or other articulations.
- Velocities are estimated from the model's confidence, not measured loudness.
- Busy mixes, heavy effects or electronic drums transcribe less reliably than acoustic kits.

## Project structure

```
app.py                  Flask web server and API
drums2midi/
  download.py           YouTube → MP3 (yt-dlp, bundled ffmpeg/deno)
  separate.py           drum stem with Demucs (Apple GPU, NVIDIA GPU or CPU)
  transcribe.py         ADTOF model, beat tracking, quantization, MIDI export
  midi_import.py        MIDI file upload → same result format
  pipeline.py           runs all steps; also the command line entry point
static/
  index.html, style.css
  app.js                jobs, playback, drum roll, sheet, PDF, 2D drum view
  kit3d.js              3D view (three.js)
launcher.py             desktop entry point (small control window + server)
packaging/              PyInstaller spec and build script for the desktop apps
run.sh / run.bat        start scripts for macOS / Windows
```

### Building the desktop apps

```bash
uv run python packaging/build.py
```

This builds the app for the OS you run it on and zips it into `dist/`. PyInstaller can't cross-compile, so the Windows app has to be built on Windows. The [GitHub Actions workflow](.github/workflows/build.yml) builds both. Run it from the Actions tab, or push a tag like `v1.0.0` to publish a release.

## Credits

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Demucs](https://github.com/facebookresearch/demucs), [ADTOF](https://github.com/MZehren/ADTOF) / [ADTOF-pytorch](https://github.com/xavriley/ADTOF-pytorch), [librosa](https://librosa.org), [pretty_midi](https://github.com/craffel/pretty-midi), [Flask](https://flask.palletsprojects.com), [three.js](https://threejs.org), [VexFlow](https://www.vexflow.com) and [jsPDF](https://github.com/parallax/jsPDF). See each project for its license.

Only download and process audio you have the right to use.

## License

[MIT](LICENSE) for this project's code. The libraries and models it uses keep their own licenses.
