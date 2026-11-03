#!/usr/bin/env python3
"""Local voice copy. Chatterbox Turbo on CPU, conditioned on one recording."""

import io
import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path

import numpy as np
import soundfile as sf

PORT = int(os.environ.get("LIKENESS_VOICE_PORT", "9396"))
VOICE_WAV = Path(os.environ.get("LIKENESS_VOICE_WAV", ""))

model = None
voice_ready = False
ready_error = ""
work_lock = threading.Lock()


def load_model():
    global model
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    model = ChatterboxTurboTTS.from_pretrained(device="cpu")
    print("VOICE_MODEL_READY", flush=True)


def train_from_disk():
    global voice_ready
    if model is None:
        raise RuntimeError("model_loading")
    if not VOICE_WAV.is_file() or VOICE_WAV.stat().st_size < 1000:
        raise RuntimeError("no_recording")
    model.prepare_conditionals(str(VOICE_WAV))
    voice_ready = True
    print("VOICE_CLONE_READY", flush=True)


def speak_wav(text):
    if not voice_ready:
        raise RuntimeError("voice_not_trained")
    audio = model.generate(text)
    samples = audio.detach().cpu().float().numpy()
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    buf = io.BytesIO()
    sf.write(buf, samples, int(model.sr), format="WAV")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path != "/health":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, {
            "model": model is not None,
            "trained": voice_ready,
            "error": ready_error
        })

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > 8000:
            self._json(413, {"error": "too_large"})
            return
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "bad_json"})
            return
        try:
            if path == "/train":
                with work_lock:
                    train_from_disk()
                self._json(200, {"trained": True})
                return
            if path == "/speak":
                text = " ".join(str(data.get("text") or "").split())[:360]
                if len(text) < 2:
                    self._json(400, {"error": "empty"})
                    return
                with work_lock:
                    wav = speak_wav(text)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
                return
            self._json(404, {"error": "not_found"})
        except Exception as err:
            print(f"VOICE_FAIL {type(err).__name__}: {err}", flush=True)
            traceback.print_exc()
            self._json(500, {"error": str(err)[:180]})


if __name__ == "__main__":
    try:
        load_model()
    except Exception as err:
        ready_error = f"{type(err).__name__}: {err}"
        print(f"VOICE_LOAD_FAIL {ready_error}", flush=True)
    if VOICE_WAV.is_file() and model is not None:
        try:
            train_from_disk()
        except Exception as err:
            print(f"VOICE_TRAIN_FAIL {type(err).__name__}: {err}", flush=True)
    class Server(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = Server(("127.0.0.1", PORT), Handler)
    print(f"VOICE_READY port={PORT}", flush=True)
    server.serve_forever()
