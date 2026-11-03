#!/usr/bin/env python3
"""Lip sync on the local NVIDIA GPU. The photo and the audio stay on this machine."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

import cv2
import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
WAV2LIP_ROOT = Path(__file__).resolve().parent / "third_party" / "Wav2Lip"
sys.path.insert(0, str(WAV2LIP_ROOT))

PORT = int(os.environ.get("LIKENESS_FACE_PORT", "9397"))
PORTRAIT = Path(os.environ.get("LIKENESS_FACE_FILE", ROOT / "data" / "face" / "portrait.jpg"))
MOTION = Path(os.environ.get("LIKENESS_MOTION_FILE", ROOT / "data" / "face" / "motion.webm"))
CHECKPOINT = Path(os.environ.get("LIKENESS_WAV2LIP", ROOT / "models" / "wav2lip_gan.pth"))
PROFILE = Path(os.environ.get("LIKENESS_PROFILE", ROOT / "data" / "profile.json"))
FPS = 25
BATCH = 8
IMG = 96

model = None
gpu_name = ""
ready_error = ""
work_lock = threading.Lock()


def load_model():
    global model, gpu_name
    if not torch.cuda.is_available():
        raise RuntimeError("cuda_unavailable")
    probe = torch.ones(8, 8, device="cuda")
    probed = (probe @ probe).sum().item()
    if probed < 1:
        raise RuntimeError("cuda_matmul_failed")
    del probe
    gpu_name = torch.cuda.get_device_name(0)
    torch.backends.cudnn.benchmark = True
    from models import Wav2Lip
    net = Wav2Lip()
    blob = torch.load(str(CHECKPOINT), map_location="cpu", weights_only=False)
    state = blob["state_dict"] if isinstance(blob, dict) and "state_dict" in blob else blob
    net.load_state_dict({key.replace("module.", ""): value for key, value in state.items()})
    model = net.to("cuda").eval()
    print(f"FACE_MODEL_READY gpu={gpu_name} vram={torch.cuda.memory_allocated() // (1024 * 1024)}MiB", flush=True)


def mouth_box(width, height):
    try:
        mouth = json.loads(PROFILE.read_text("utf-8")).get("mouth") or {}
        mx = float(mouth["x"]) * width
        my = float(mouth["y"]) * height
        mw = float(mouth["w"]) * width
        mh = float(mouth["h"]) * height
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if mw < 8 or mh < 4:
        return None
    cx = mx + mw / 2
    face_w = max(mw * 3.4, width * 0.28)
    face_h = max(mh * 7.5, height * 0.38)
    x1 = int(max(0, cx - face_w / 2))
    x2 = int(min(width, cx + face_w / 2))
    y2 = int(min(height, my + mh * 2.2))
    y1 = int(max(0, y2 - face_h))
    if x2 - x1 < 48 or y2 - y1 < 48:
        return None
    return x1, y1, x2, y2


def clip_box(found, width, height):
    if found is None:
        return None
    x1, y1, x2, y2 = found
    y2 = min(height, int(y2) + 10)
    x1 = max(0, int(x1))
    y1 = max(0, int(y1))
    x2 = min(width, int(x2))
    if x2 - x1 < 48 or y2 - y1 < 48:
        return None
    return x1, y1, x2, y2


def detect_box(frame):
    boxes = detect_boxes([frame])
    return boxes[0] if boxes else None


def detect_boxes(frames):
    import face_detection
    detector = face_detection.FaceAlignment(
        face_detection.LandmarksType._2D, flip_input=False, device="cuda"
    )
    found = []
    try:
        for start in range(0, len(frames), 2):
            batch = frames[start:start + 2]
            preds = detector.get_detections_for_batch(np.array(batch))
            height, width = batch[0].shape[:2]
            found.extend(clip_box(pred, width, height) for pred in preds)
    finally:
        del detector
        torch.cuda.empty_cache()
    return smooth_boxes(found)


def smooth_boxes(boxes):
    smoothed = []
    last = None
    for index, box in enumerate(boxes):
        window = [item for item in boxes[max(0, index - 2):index + 3] if item]
        if not window:
            smoothed.append(last)
            continue
        averaged = tuple(int(sum(item[axis] for item in window) / len(window)) for axis in range(4))
        last = averaged
        smoothed.append(averaged)
    return smoothed


def load_motion_frames(path):
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)
        ],
        capture_output=True, text=True, check=True
    )
    width, height = [int(part) for part in probe.stdout.strip().split(",")]
    width -= width % 2
    height -= height % 2
    if width < 2 or height < 2:
        return []
    decoded = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(path),
            "-vf", f"hflip,fps={FPS},scale={width}:{height}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"
        ],
        capture_output=True, check=True
    )
    frame_bytes = width * height * 3
    count = min(len(decoded.stdout) // frame_bytes, 400)
    if count < 8:
        return []
    frames = []
    for index in range(count):
        start = index * frame_bytes
        frames.append(np.frombuffer(
            decoded.stdout[start:start + frame_bytes], dtype=np.uint8
        ).reshape(height, width, 3).copy())
    return frames


def plate_index(count, index):
    if count <= 1:
        return 0
    span = count * 2 - 2
    pos = index % span
    if pos >= count:
        pos = span - pos
    return pos


def mel_chunks(wav_path):
    import audio
    wav = audio.load_wav(str(wav_path), 16000)
    wav = np.asarray(wav, dtype=np.float32)
    if wav.size < 16000 // 4:
        wav = np.pad(wav, (0, 16000 // 4 - wav.size))
    mel = audio.melspectrogram(wav)
    if np.isnan(mel).any():
        wav = wav + np.random.randn(*wav.shape).astype(np.float32) * 1e-4
        mel = audio.melspectrogram(wav)
    if mel.shape[1] < 16:
        mel = np.pad(mel, ((0, 0), (0, 16 - mel.shape[1])))
    step = 80.0 / FPS
    chunks = []
    index = 0
    while True:
        start = int(index * step)
        if start + 16 > mel.shape[1]:
            chunks.append(mel[:, mel.shape[1] - 16:])
            break
        chunks.append(mel[:, start:start + 16])
        index += 1
    return chunks


def predict(faces, mels):
    masked = faces.copy()
    masked[:, IMG // 2:] = 0
    image = np.concatenate((masked, faces), axis=3) / 255.0
    image = torch.FloatTensor(np.transpose(image, (0, 3, 1, 2))).to("cuda")
    audio_in = np.reshape(mels, (len(mels), mels.shape[1], mels.shape[2], 1))
    audio_in = torch.FloatTensor(np.transpose(audio_in, (0, 3, 1, 2))).to("cuda")
    with torch.inference_mode():
        pred = model(audio_in, image)
    return (pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.0).astype(np.uint8)


def render_mp4(wav_bytes):
    if model is None:
        raise RuntimeError(ready_error or "face_model_not_ready")
    plates = []
    source = "portrait"
    if MOTION.is_file() and MOTION.stat().st_size > 1000:
        try:
            plates = load_motion_frames(MOTION)
        except (subprocess.CalledProcessError, ValueError):
            plates = []
        if plates:
            source = "motion"
    if not plates:
        if not PORTRAIT.is_file():
            raise RuntimeError("no_portrait")
        frame = cv2.imread(str(PORTRAIT))
        if frame is None:
            raise RuntimeError("portrait_unreadable")
        plates = [frame]
    height, width = plates[0].shape[:2]
    boxes = detect_boxes(plates)
    fallback = mouth_box(width, height)
    filled = []
    last = fallback
    for box in boxes:
        last = box or last
        filled.append(last)
    first = next((box for box in filled if box), None)
    boxes = [box or first for box in filled]
    if not first:
        raise RuntimeError("face_not_found")
    with tempfile.TemporaryDirectory(prefix="likeness-face-") as folder:
        folder = Path(folder)
        wav_path = folder / "line.wav"
        out_path = folder / "line.mp4"
        wav_path.write_bytes(wav_bytes)
        chunks = mel_chunks(wav_path)
        print(f"FACE_RENDER frames={len(chunks)} plates={len(plates)} via={source}", flush=True)
        err_path = folder / "ffmpeg.err"
        with err_path.open("wb") as err_file:
            encoder = subprocess.Popen(
                [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-f", "rawvideo", "-pix_fmt", "bgr24",
                    "-s", f"{width}x{height}", "-r", str(FPS),
                    "-i", "pipe:0",
                    "-i", str(wav_path),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
                    "-c:a", "aac", "-b:a", "128k",
                    "-shortest", "-movflags", "+faststart",
                    str(out_path)
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=err_file
            )
            try:
                for start in range(0, len(chunks), BATCH):
                    batch_mel = chunks[start:start + BATCH]
                    chosen = []
                    chosen_boxes = []
                    for offset in range(len(batch_mel)):
                        slot = plate_index(len(plates), start + offset)
                        chosen.append(plates[slot])
                        chosen_boxes.append(boxes[slot] or fallback)
                    faces = np.asarray([
                        cv2.resize(frame[y1:y2, x1:x2], (IMG, IMG))
                        for frame, (x1, y1, x2, y2) in zip(chosen, chosen_boxes)
                    ])
                    painted = predict(faces, np.asarray(batch_mel))
                    for patch, frame, box in zip(painted, chosen, chosen_boxes):
                        x1, y1, x2, y2 = box
                        canvas = frame.copy()
                        canvas[y1:y2, x1:x2] = cv2.resize(patch, (x2 - x1, y2 - y1))
                        encoder.stdin.write(np.ascontiguousarray(canvas).tobytes())
                    print(f"FACE_PROGRESS {min(start + BATCH, len(chunks))}/{len(chunks)}", flush=True)
                encoder.stdin.close()
                code = encoder.wait(timeout=180)
            except Exception:
                encoder.kill()
                raise
        if code != 0 or not out_path.is_file() or out_path.stat().st_size < 1000:
            detail = err_path.read_text("utf-8", errors="replace")[-300:]
            raise RuntimeError(detail or "ffmpeg_failed")
        used = torch.cuda.max_memory_allocated() // (1024 * 1024)
        print(f"FACE_DONE bytes={out_path.stat().st_size} vram_peak={used}MiB", flush=True)
        return out_path.read_bytes()


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
        if self.path.split("?", 1)[0] != "/health":
            self._json(404, {"error": "not_found"})
            return
        free = 0
        if torch.cuda.is_available():
            free = torch.cuda.mem_get_info()[0] // (1024 * 1024)
        self._json(200, {
            "model": model is not None,
            "gpu": gpu_name,
            "freeMiB": int(free),
            "error": ready_error
        })

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/render":
            self._json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 100 or length > 8 * 1024 * 1024:
            self._json(400, {"error": "Send a short wav."})
            return
        raw = self.rfile.read(length)
        if not work_lock.acquire(blocking=False):
            self._json(409, {"error": "The Quadro is still drawing the last line."})
            return
        try:
            mp4 = render_mp4(raw)
        except Exception as err:
            traceback.print_exc()
            self._json(500, {"error": str(err)})
            return
        finally:
            work_lock.release()
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(mp4)))
        self.end_headers()
        self.wfile.write(mp4)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    global ready_error
    try:
        if not CHECKPOINT.is_file() or CHECKPOINT.stat().st_size < 1_000_000:
            raise RuntimeError("wav2lip_checkpoint_missing")
        load_model()
    except Exception as err:
        ready_error = str(err)
        print("FACE_LOAD_FAIL", ready_error, flush=True)
        traceback.print_exc()
    httpd = Server(("127.0.0.1", PORT), Handler)
    print(f"FACE_READY port={PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
