"""Automated Developer & End-User Test Suite for Likeness Desk (AI Video Double).

Uses isolated ephemeral data/public directories with synthetic audio/image/video
fixtures so zero personal biometric files are required in git or CI runners.
"""

import json
import math
import os
import shutil
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import pytest

REPO_DIR = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _write_synthetic_wav(dest: Path, duration_sec: float = 1.0, sample_rate: int = 24000) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    n_samples = int(duration_sec * sample_rate)
    frames = bytearray()
    for i in range(n_samples):
        val = int(12000 * math.sin(2.0 * math.pi * 220.0 * (i / sample_rate)))
        frames += struct.pack("<h", val)
    with wave.open(str(dest), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(frames))


def _write_synthetic_jpeg(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Minimal valid SOI..EOI JPEG frame padded > 1024 bytes for HTTP streaming tests
    minimal_jpeg = (
        bytes.fromhex(
            "ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c"
            "140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27"
            "393d38323c2e333432ffc0000b080001000101011100ffc400140001000000000000000000000000"
            "00000008ffc40014100100000000000000000000000000000000ffda0008010100003f007f00"
        )
        + (b"\x00" * 1200)
        + bytes.fromhex("ffd9")
    )
    dest.write_bytes(minimal_jpeg)


def _write_synthetic_mp4(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ftyp = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    mdat_payload = b"\x00" * 12000
    mdat = struct.pack(">I", len(mdat_payload) + 8) + b"mdat" + mdat_payload
    dest.write_bytes(ftyp + mdat)


@pytest.fixture(scope="module")
def sandbox(tmp_path_factory):
    root = tmp_path_factory.mktemp("likeness_sandbox")
    data_dir = root / "data"
    pub_dir = root / "public"
    shutil.copytree(REPO_DIR / "public", pub_dir, dirs_exist_ok=True)

    _write_synthetic_jpeg(data_dir / "face" / "portrait.jpg")
    _write_synthetic_wav(data_dir / "voice" / "reference.wav", duration_sec=7.2)
    _write_synthetic_wav(pub_dir / "preview.wav", duration_sec=0.8)
    _write_synthetic_mp4(pub_dir / "preview.mp4")

    wav2lip_stub = root / "wav2lip_gan.pth"
    wav2lip_stub.write_bytes(b"WAV2LIP_WEIGHTS_STUB")

    profile = {
        "voiceSeconds": 7.2,
        "mouth": {"x": 0.38, "y": 0.62, "w": 0.24, "h": 0.14},
        "trainedAt": "2026-01-01T00:00:00.000Z",
    }
    (data_dir / "profile.json").write_text(json.dumps(profile, indent=2), encoding="utf-8")

    port = _free_port()
    env = os.environ.copy()
    env["LIKENESS_PORT"] = str(port)
    env["LIKENESS_LAZY_GPU"] = "1"
    env["LIKENESS_DATA_DIR"] = str(data_dir)
    env["LIKENESS_PUBLIC_DIR"] = str(pub_dir)
    env["LIKENESS_WAV2LIP_FILE"] = str(wav2lip_stub)

    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=str(REPO_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://127.0.0.1:{port}"
    for _ in range(35):
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=1.0) as r:
                if r.status == 200:
                    break
        except Exception:
            time.sleep(0.12)

    yield {"base_url": base_url, "data_dir": data_dir, "pub_dir": pub_dir, "proc": proc}

    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()


def test_repo_privacy_hygiene():
    gitignore = (REPO_DIR / ".gitignore").read_text(encoding="utf-8")
    assert "data/" in gitignore or "data" in gitignore
    assert (REPO_DIR / "server.js").exists()
    assert (REPO_DIR / "public" / "index.html").exists()


def test_health_endpoint(sandbox):
    with urllib.request.urlopen(f"{sandbox['base_url']}/health", timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["status"] == "healthy"
        assert data["service"] == "likeness-desk"


def test_cross_origin_blocked(sandbox):
    req = urllib.request.Request(
        f"{sandbox['base_url']}/api/status",
        headers={"Origin": "https://evil.example.com"},
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2.0)
    assert exc.value.code == 403


def test_api_status_endpoint(sandbox):
    with urllib.request.urlopen(f"{sandbox['base_url']}/api/status", timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["voiceModel"] is True
        assert data["voiceTrained"] is True
        assert data["face"] is True
        assert "Quadro P1000" in data["faceGpuName"]
        assert isinstance(data["mouth"], dict)


def test_api_portrait_image(sandbox):
    with urllib.request.urlopen(f"{sandbox['base_url']}/api/portrait", timeout=2.0) as r:
        assert r.status == 200
        assert "image/jpeg" in r.headers.get("Content-Type", "")
        raw = r.read()
        assert len(raw) > 1000
        assert raw[:2] == b"\xff\xd8"


def test_api_mouth_roi_update(sandbox):
    profile_path = sandbox["data_dir"] / "profile.json"
    original = json.loads(profile_path.read_text(encoding="utf-8"))
    updated_mouth = {"x": 0.40, "y": 0.63, "w": 0.22, "h": 0.13}
    payload = json.dumps({"mouth": updated_mouth}).encode("utf-8")
    req = urllib.request.Request(
        f"{sandbox['base_url']}/api/mouth",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["ok"] is True
        assert abs(data["mouth"]["x"] - updated_mouth["x"]) < 1e-4
    # Restore original
    (sandbox["data_dir"] / "profile.json").write_text(json.dumps(original, indent=2), encoding="utf-8")


def test_api_speak_json_and_wav(sandbox):
    payload = json.dumps({"text": "Local AI video double verification on loopback enclave."}).encode("utf-8")
    req_json = urllib.request.Request(
        f"{sandbox['base_url']}/api/speak",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req_json, timeout=3.0) as r:
        assert r.status == 200
        res = json.loads(r.read().decode("utf-8"))
        assert res["ok"] is True
        assert res["status"] == "SYNTHESIZED"
        assert res["wavBytes"] > 10000

    req_wav = urllib.request.Request(
        f"{sandbox['base_url']}/api/speak",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req_wav, timeout=3.0) as r:
        assert r.status == 200
        assert "audio/wav" in r.headers.get("Content-Type", "")
        wav_bytes = r.read()
        assert wav_bytes[:4] == b"RIFF"


def test_api_face_render_mp4(sandbox):
    wav_sample = (sandbox["pub_dir"] / "preview.wav").read_bytes()[:4096]
    req = urllib.request.Request(
        f"{sandbox['base_url']}/api/face/render",
        data=wav_sample,
        headers={"Content-Type": "audio/wav"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3.0) as r:
        assert r.status == 200
        assert "video/mp4" in r.headers.get("Content-Type", "")
        mp4_bytes = r.read()
        assert len(mp4_bytes) > 10000


def test_cli_entrypoint():
    cli_bin = REPO_DIR / "bin" / "likeness-desk"
    if cli_bin.exists():
        res = subprocess.run([str(cli_bin), "--json"], capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        assert data["id"] == "likeness-desk"
