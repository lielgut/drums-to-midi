"""Desktop entry point for the packaged app: starts the web server and shows a small control window.

Also works from source: `uv run python launcher.py`.
"""
import multiprocessing
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

APP_NAME = "Drums to MIDI"


def data_dir() -> Path:
    """Writable per-user folder for results, logs and caches (the app bundle itself may be read-only)."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    d = base / "DrumsToMIDI"
    d.mkdir(parents=True, exist_ok=True)
    return d


def pick_port(preferred: int = 5055) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port")


def configure_environment() -> None:
    data = data_dir()
    bundle = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    os.environ.setdefault("DRUMS2MIDI_JOBS", str(data / "jobs"))
    # librosa's numba functions cache compiled code; inside a bundle that needs a writable location.
    os.environ.setdefault("NUMBA_CACHE_DIR", str(data / "numba-cache"))
    # Use the Demucs model shipped in the bundle instead of downloading it.
    if (bundle / "models" / "hub" / "checkpoints").is_dir():
        os.environ.setdefault("TORCH_HOME", str(bundle / "models"))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    # Windowed apps have no console: send output to a log file.
    if sys.stdout is None or sys.stderr is None:
        log = open(data / "log.txt", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log


def main() -> None:
    multiprocessing.freeze_support()
    configure_environment()
    port = pick_port(int(os.environ.get("PORT", 5055)))
    url = f"http://127.0.0.1:{port}"
    state = {"error": None, "ready": False}

    def serve():
        try:
            from werkzeug.serving import make_server

            from app import app  # heavy: imports PyTorch

            server = make_server("127.0.0.1", port, app, threaded=True)
            state["ready"] = True
            webbrowser.open(url)
            server.serve_forever()
        except Exception as e:  # surface startup failures in the window
            state["error"] = repr(e)
            print(f"Startup failed: {e!r}", flush=True)

    threading.Thread(target=serve, daemon=True).start()

    try:
        import tkinter as tk
    except ImportError:  # no GUI toolkit: plain console mode
        print(f"{APP_NAME} is starting at {url} — press Ctrl+C to quit.")
        threading.Event().wait()
        return

    root = tk.Tk()
    root.title(APP_NAME)
    root.geometry("360x150")
    root.resizable(False, False)
    tk.Label(root, text=APP_NAME, font=("Helvetica", 16, "bold")).pack(pady=(14, 4))
    status = tk.Label(root, text="Starting… (the first launch can take a minute)")
    status.pack()
    buttons = tk.Frame(root)
    buttons.pack(pady=12)
    open_btn = tk.Button(buttons, text="Open in browser", state="disabled", command=lambda: webbrowser.open(url))
    open_btn.pack(side="left", padx=6)
    tk.Button(buttons, text="Quit", command=lambda: os._exit(0)).pack(side="left", padx=6)
    root.protocol("WM_DELETE_WINDOW", lambda: os._exit(0))

    def poll():
        if state["error"]:
            status.config(text=f"Couldn't start. See log.txt in\n{data_dir()}", fg="red")
        elif state["ready"]:
            status.config(text=f"Running at {url}\nKeep this window open while you use the app.")
            open_btn.config(state="normal")
        else:
            root.after(300, poll)

    poll()
    root.mainloop()
    os._exit(0)


if __name__ == "__main__":
    main()
