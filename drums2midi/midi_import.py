"""Alternative input: an existing MIDI file. Its drum notes skip download/separation/transcription."""
import json
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

from .transcribe import INSTRUMENTS, quantize, write_midi, write_quantized_midi

# General MIDI percussion → the 5 classes used everywhere else (kick, snare, toms, hi-hat, cymbals).
GM_TO_CLASS = {
    35: 35, 36: 35,                                   # kicks
    37: 38, 38: 38, 39: 38, 40: 38,                   # side stick, snares, clap
    41: 47, 43: 47, 45: 47, 47: 47, 48: 47, 50: 47,   # toms
    42: 42, 44: 42, 46: 42,                           # hi-hat closed / pedal / open
    49: 49, 51: 49, 52: 49, 53: 49, 55: 49, 57: 49, 59: 49,  # crash, ride, china, splash
}
CLOCK_SR = 8000


def import_midi(src: Path, job_dir: Path, title: str) -> dict:
    try:
        pm = pretty_midi.PrettyMIDI(str(src))
    except Exception as e:
        raise ValueError(f"Couldn't read that MIDI file ({e})") from e

    drum_tracks = [i for i in pm.instruments if i.is_drum]
    if not drum_tracks:
        raise ValueError("No drum track found — drums must be on MIDI channel 10")

    # Map to the 5 classes; merge hits of the same class within 15 ms (e.g. kick 35+36 layered).
    raw = sorted(
        ((float(n.start), GM_TO_CLASS[n.pitch], int(n.velocity)) for t in drum_tracks for n in t.notes if n.pitch in GM_TO_CLASS),
        key=lambda x: (x[1], x[0]),
    )
    notes = []
    for t, p, v in raw:
        if notes and notes[-1]["pitch"] == p and t - notes[-1]["time"] < 0.015:
            notes[-1]["velocity"] = max(notes[-1]["velocity"], v)
            continue
        notes.append({"time": round(t, 3), "pitch": p, "velocity": v})
    if not notes:
        raise ValueError("The drum track has no kick/snare/tom/hi-hat/cymbal notes")
    notes.sort(key=lambda n: (n["time"], n["pitch"]))

    # The MIDI file's own tempo map gives exact beats and downbeats.
    duration = float(pm.get_end_time()) + 1.0
    beats = [round(float(b), 3) for b in pm.get_beats()]
    tempo = 60.0 / float(np.median(np.diff(beats))) if len(beats) > 1 else 120.0
    beat_info = {"tempo": round(tempo, 2), "beats": beats, "duration": duration}
    qnotes = quantize(notes, beat_info)
    # Bar phase = the most common downbeat position (robust to a pickup bar or a mid-song time-signature event).
    bar_offset = 0
    if beats and len(pm.get_downbeats()):
        idx = [int(np.argmin(np.abs(np.asarray(beats) - d))) for d in pm.get_downbeats()]
        bar_offset = int(np.bincount([(-i) % 4 for i in idx], minlength=4).argmax())

    write_midi(notes, job_dir / "drums.mid", tempo)
    write_quantized_midi(qnotes, job_dir / "drums_quantized.mid", tempo, bar_offset)
    # Silent track that acts as the playback clock (seek / speed) — the only sound is the MIDI drum synth.
    sf.write(str(job_dir / "clock.wav"), np.zeros(int(CLOCK_SR * duration), dtype=np.int16), CLOCK_SR, subtype="PCM_16")

    result = {
        "source": "midi",
        "instruments": INSTRUMENTS,
        "thresholds": None,
        "tempo": beat_info["tempo"],
        "beats": beats,
        "notes": notes,
        "quantized": qnotes,
        "bar_offset": bar_offset,
        "title": title,
        "url": None,
    }
    (job_dir / "result.json").write_text(json.dumps(result))
    return result
