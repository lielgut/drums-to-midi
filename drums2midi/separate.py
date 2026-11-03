"""Step 2: isolate the drum stem with Demucs (htdemucs)."""
import os
from pathlib import Path
from typing import Callable, Optional

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import librosa
import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

MODEL_NAME = "htdemucs"
_model = None


def _get_model():
    global _model
    if _model is None:
        _model = get_model(MODEL_NAME)
        _model.eval()
    return _model


def _devices():
    if torch.cuda.is_available():
        return ["cuda", "cpu"]
    if torch.backends.mps.is_available():
        return ["mps", "cpu"]
    return ["cpu"]


def separate_drums(
    audio_path: Path,
    out_path: Path,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> Path:
    """Write the drum stem of `audio_path` to `out_path` (WAV)."""
    model = _get_model()
    sr = model.samplerate

    if on_progress:
        on_progress(0.05, "Loading audio…")
    y, _ = librosa.load(str(audio_path), sr=sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    wav = torch.from_numpy(y[: model.audio_channels]).float()

    # Demucs expects normalized input; undo it afterwards.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    last_err = None
    for device in _devices():
        try:
            if on_progress:
                on_progress(0.1, f"Separating drums with Demucs on {device.upper()}… (this is the slow part)")
            with torch.no_grad():
                sources = apply_model(model, wav[None], device=device, split=True, overlap=0.25, progress=False)[0]
            break
        except Exception as e:  # e.g. an op missing on MPS — fall back to CPU
            last_err = e
    else:
        raise RuntimeError(f"Demucs failed: {last_err}")

    sources = sources * std + mean
    drums = sources[model.sources.index("drums")].cpu().numpy().T  # (samples, channels)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), drums, sr)
    if on_progress:
        on_progress(1.0, "Drum stem ready")
    return out_path
