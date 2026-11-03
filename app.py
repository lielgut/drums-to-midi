"""Small web UI: paste a YouTube URL, get a drum MIDI + sheet."""
import json
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

import numpy as np
from flask import Flask, abort, jsonify, request, send_from_directory

from drums2midi import pipeline
from drums2midi.midi_import import import_midi
from drums2midi.transcribe import render_outputs, track_beats, write_quantized_midi

ROOT = Path(__file__).parent
JOBS = ROOT / "jobs"
JOBS.mkdir(exist_ok=True)
ALLOWED_FILES = {"song.mp3", "drums.wav", "drums.mid", "drums_quantized.mid", "result.json", "clock.wav", "original.mid"}

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # MIDI uploads are tiny
_work_lock = threading.Lock()  # one heavy job at a time
_status: dict[str, dict] = {}


def _job_dir(job_id: str) -> Path:
    if not job_id.isalnum():
        abort(404)
    d = JOBS / job_id
    if not d.is_dir():
        abort(404)
    return d


def _save_status(job_id: str) -> None:
    (JOBS / job_id / "status.json").write_text(json.dumps(_status[job_id]))


def _worker(job_id: str, url: str) -> None:
    st = _status[job_id]

    def report(step, frac, msg):
        st.update(step=step, progress=frac, message=msg)
        st["log"].append(f"{time.strftime('%H:%M:%S')} [{step}] {msg}")
        _save_status(job_id)

    st.update(state="queued", message="Waiting for the previous job to finish…")
    with _work_lock:
        st["state"] = "running"
        try:
            result = pipeline.run(url, JOBS / job_id, report)
            st.update(state="done", title=result["title"])
        except Exception as e:
            traceback.print_exc()
            st.update(state="error", message=str(e))
            st["log"].append(f"ERROR: {e}")
        _save_status(job_id)


@app.get("/")
def index():
    return send_from_directory(ROOT / "static", "index.html")


@app.post("/api/jobs")
def create_job():
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not url.startswith(("http://", "https://")):
        return jsonify(error="Please paste a full YouTube URL"), 400
    job_id = uuid.uuid4().hex[:12]
    (JOBS / job_id).mkdir()
    _status[job_id] = {"id": job_id, "url": url, "state": "queued", "step": "download",
                       "progress": 0.0, "message": "Queued", "log": [], "created": time.time()}
    _save_status(job_id)
    threading.Thread(target=_worker, args=(job_id, url), daemon=True).start()
    return jsonify(id=job_id)


@app.post("/api/upload")
def upload_midi():
    """Create a finished job straight from an uploaded MIDI file (no audio processing)."""
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith((".mid", ".midi")):
        return jsonify(error="Please choose a .mid or .midi file"), 400
    job_id = uuid.uuid4().hex[:12]
    d = JOBS / job_id
    d.mkdir()
    f.save(d / "original.mid")
    title = Path(f.filename).stem or "MIDI file"
    try:
        result = import_midi(d / "original.mid", d, title)
    except ValueError as e:
        shutil.rmtree(d, ignore_errors=True)
        return jsonify(error=str(e)), 400
    _status[job_id] = {"id": job_id, "url": None, "state": "done", "step": "transcribe", "progress": 1.0,
                       "message": f"Imported {len(result['notes'])} drum hits from MIDI", "log": [],
                       "title": title, "created": time.time(), "source": "midi"}
    _save_status(job_id)
    return jsonify(id=job_id)


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="File too large (max 5 MB)"), 413


@app.get("/api/jobs")
def list_jobs():
    jobs = []
    for d in JOBS.iterdir():
        sf = d / "status.json"
        if sf.exists():
            s = _status.get(d.name) or json.loads(sf.read_text())
            jobs.append({k: s.get(k) for k in ("id", "url", "state", "title", "created")})
    jobs.sort(key=lambda j: j.get("created") or 0, reverse=True)
    return jsonify(jobs)


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    d = _job_dir(job_id)
    s = _status.get(job_id)
    if s is None:
        s = json.loads((d / "status.json").read_text())
        if s.get("state") in ("queued", "running"):  # server restarted mid-job
            s.update(state="error", message="Interrupted (server restarted)")
    return jsonify(s)


@app.get("/api/jobs/<job_id>/files/<name>")
def job_file(job_id, name):
    if name not in ALLOWED_FILES:
        abort(404)
    resp = send_from_directory(_job_dir(job_id), name, as_attachment=name.endswith(".mid"))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/jobs/<job_id>/retune")
def retune(job_id):
    """Re-pick notes with new per-instrument thresholds / bar offset without re-running the models."""
    d = _job_dir(job_id)
    body = request.get_json(silent=True) or {}
    old = json.loads((d / "result.json").read_text())
    if old.get("source") == "midi":  # notes come from the file: only the bar offset can change
        old["bar_offset"] = int(body.get("bar_offset", old.get("bar_offset", 0))) % 4
        write_quantized_midi(old["quantized"], d / "drums_quantized.mid", old["tempo"], old["bar_offset"])
        (d / "result.json").write_text(json.dumps(old))
        return jsonify(old)
    thresholds = [float(np.clip(t, 0.02, 0.98)) for t in body.get("thresholds", old["thresholds"])][:5]
    bar_offset = int(body.get("bar_offset", old.get("bar_offset", 0))) % 4
    acts = np.load(d / "activations.npy")
    beat_info = track_beats(d / "drums.wav")
    result = render_outputs(acts, beat_info, d, thresholds, bar_offset)
    result.update({k: old[k] for k in ("title", "url", "elapsed") if k in old})
    (d / "result.json").write_text(json.dumps(result))
    return jsonify(result)


if __name__ == "__main__":
    import os
    import sys
    import webbrowser

    # Windows consoles default to a legacy code page; song titles and log text may contain any Unicode.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    port = int(os.environ.get("PORT", 5055))
    url = f"http://127.0.0.1:{port}"
    print(f"Drums → MIDI running at {url}")
    if "--open" in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True)
