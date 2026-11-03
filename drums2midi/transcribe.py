"""Step 3: transcribe the drum stem into MIDI using the pretrained ADTOF Frame-RNN model."""
import warnings
from pathlib import Path
from typing import Callable, Optional, Sequence

import librosa
import numpy as np
import pretty_midi
import torch
from adtof_pytorch import (
    FRAME_RNN_THRESHOLDS,
    LABELS_5,
    PeakPicker,
    calculate_n_bins,
    create_frame_rnn_model,
    get_default_weights_path,
    load_audio_for_model,
    load_pytorch_weights,
)

# numpy+Accelerate on macOS emits spurious matmul warnings inside ADTOF's filterbank.
warnings.filterwarnings("ignore", message=".*encountered in matmul", category=RuntimeWarning)

FPS = 100
# General MIDI drum pitches the model predicts, in model output order.
INSTRUMENTS = [
    {"pitch": 35, "name": "Kick"},
    {"pitch": 38, "name": "Snare"},
    {"pitch": 47, "name": "Toms"},
    {"pitch": 42, "name": "Hi-hat"},
    {"pitch": 49, "name": "Cymbals"},
]
DEFAULT_THRESHOLDS = list(FRAME_RNN_THRESHOLDS)
SUBDIV = 4  # 16th-note grid

_model = None


def _get_model():
    global _model
    if _model is None:
        m = create_frame_rnn_model(calculate_n_bins())
        m = load_pytorch_weights(m, get_default_weights_path(), strict=False)
        m.eval()
        _model = m
    return _model


def compute_activations(drums_path: Path) -> np.ndarray:
    """Per-frame (100 fps) onset probabilities, shape (frames, 5)."""
    x = load_audio_for_model(str(drums_path))
    with torch.no_grad():
        return _get_model()(x).cpu().numpy()[0]


def pick_notes(acts: np.ndarray, thresholds: Sequence[float] = DEFAULT_THRESHOLDS) -> list[dict]:
    """Peak-pick activations into notes [{time, pitch, velocity}], velocity from peak strength."""
    picker = PeakPicker(thresholds=[float(t) for t in thresholds], fps=FPS)
    peaks = picker.pick(acts[None], labels=LABELS_5, label_offset=0)[0]
    notes = []
    for col, pitch in enumerate(LABELS_5):
        for t in peaks.get(pitch, []):
            frame = min(int(round(t * FPS)), len(acts) - 1)
            strength = float(acts[max(frame - 1, 0): frame + 2, col].max())
            velocity = int(np.clip(45 + strength * 90, 30, 127))
            notes.append({"time": round(float(t), 3), "pitch": pitch, "velocity": velocity})
    notes.sort(key=lambda n: (n["time"], n["pitch"]))
    return notes


def track_beats(drums_path: Path) -> dict:
    """Estimate tempo and beat times from the drum stem."""
    y, sr = librosa.load(str(drums_path), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    beats = np.asarray(beats, dtype=float)
    tempo = float(np.atleast_1d(tempo)[0])
    if len(beats) >= 2:
        tempo = 60.0 / float(np.median(np.diff(beats)))
    return {"tempo": round(tempo, 2), "beats": [round(float(b), 3) for b in beats], "duration": len(y) / sr}


def build_grid(beats: Sequence[float], tempo: float, duration: float) -> np.ndarray:
    """16th-note grid times following the tracked beats; index 0 == first tracked beat."""
    period = 60.0 / tempo
    beats = list(beats) or [0.0]
    # Extrapolate before the first and after the last tracked beat so every note has a slot.
    pre = []
    t = beats[0] - period
    while t > -period:
        pre.insert(0, t)
        t -= period
    post = []
    t = beats[-1] + period
    while t < duration + period:
        post.append(t)
        t += period
    all_beats = pre + beats + post
    grid = []
    for a, b in zip(all_beats[:-1], all_beats[1:]):
        grid.extend(a + (b - a) * k / SUBDIV for k in range(SUBDIV))
    grid.append(all_beats[-1])
    return np.asarray(grid), len(pre) * SUBDIV


def quantize(notes: list[dict], beat_info: dict) -> list[dict]:
    """Snap notes to the beat-following 16th grid. Returns [{slot, pitch, velocity}] (slot 0 == first beat)."""
    grid, zero = build_grid(beat_info["beats"], beat_info["tempo"], beat_info["duration"])
    seen = {}
    for n in notes:
        idx = int(np.argmin(np.abs(grid - n["time"])))
        key = (idx - zero, n["pitch"])
        seen[key] = max(seen.get(key, 0), n["velocity"])
    return [{"slot": s, "pitch": p, "velocity": v} for (s, p), v in sorted(seen.items())]


def guess_bar_offset(qnotes: list[dict]) -> int:
    """Pick the beat shift (0-3) that best puts kicks on beats 1/3 and snares on beats 2/4."""
    best, best_score = 0, -1e9
    for off in range(4):
        score = 0.0
        for q in qnotes:
            pos = (q["slot"] + off * SUBDIV) % 16
            if q["pitch"] == 35:
                score += {0: 2.0, 8: 1.0}.get(pos, 0.0)
            elif q["pitch"] == 38:
                score += {4: 1.0, 12: 1.0, 0: -1.0}.get(pos, 0.0)
            elif q["pitch"] == 49 and pos == 0:
                score += 1.0
        if score > best_score:
            best, best_score = off, score
    return best


def write_midi(notes: list[dict], path: Path, tempo: float) -> None:
    """MIDI with the original (performance) timing."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for n in notes:
        inst.notes.append(pretty_midi.Note(n["velocity"], n["pitch"], n["time"], n["time"] + 0.1))
    pm.instruments.append(inst)
    pm.write(str(path))


def write_quantized_midi(qnotes: list[dict], path: Path, tempo: float, bar_offset_beats: int = 0) -> None:
    """Grid-aligned MIDI at a constant tempo — import this into MuseScore/a DAW for clean notation."""
    sixteenth = 60.0 / tempo / SUBDIV
    if not qnotes:
        first = 0
    else:
        # Start at the beginning of the bar containing the earliest note.
        shifted = min(q["slot"] for q in qnotes) + bar_offset_beats * SUBDIV
        first = (shifted // 16) * 16 - bar_offset_beats * SUBDIV
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for q in qnotes:
        start = (q["slot"] - first) * sixteenth
        inst.notes.append(pretty_midi.Note(q["velocity"], q["pitch"], start, start + sixteenth * 0.9))
    pm.instruments.append(inst)
    pm.write(str(path))


def transcribe(
    drums_path: Path,
    out_dir: Path,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> dict:
    if on_progress:
        on_progress(0.1, "Running drum transcription model…")
    acts = compute_activations(drums_path)
    np.save(out_dir / "activations.npy", acts)
    if on_progress:
        on_progress(0.7, "Tracking tempo & beats…")
    beat_info = track_beats(drums_path)
    return render_outputs(acts, beat_info, out_dir, DEFAULT_THRESHOLDS)


def render_outputs(
    acts: np.ndarray, beat_info: dict, out_dir: Path, thresholds: Sequence[float], bar_offset: Optional[int] = None
) -> dict:
    """bar_offset=None means auto-detect where bar 1 starts."""
    notes = pick_notes(acts, thresholds)
    qnotes = quantize(notes, beat_info)
    if bar_offset is None:
        bar_offset = guess_bar_offset(qnotes)
    write_midi(notes, out_dir / "drums.mid", beat_info["tempo"])
    write_quantized_midi(qnotes, out_dir / "drums_quantized.mid", beat_info["tempo"], bar_offset)
    return {
        "instruments": INSTRUMENTS,
        "thresholds": [float(t) for t in thresholds],
        "tempo": beat_info["tempo"],
        "beats": beat_info["beats"],
        "notes": notes,
        "quantized": qnotes,
        "bar_offset": bar_offset,
    }
