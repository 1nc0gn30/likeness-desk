"""Automated Developer & End-User Test Suite for Likeness Desk (AI Video Double)."""

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

REPO_DIR = Path("/opt/likeness-desk")
TEST_PORT = 19395
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"


@pytest.fixture(scope="module")
def live_server():
    env = os.environ.copy()
    env["LIKENESS_PORT"] = str(TEST_PORT)
    env["LIKENESS_LAZY_GPU"] = "1"
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=str(REPO_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=1.0) as r:
                if r.status == 200:
                    break
        except Exception:
            time.sleep(0.15)
    yield proc
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()


def test_profile_and_biometric_assets_exist():
    profile_path = REPO_DIR / "data" / "profile.json"
    assert profile_path.exists()
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    assert profile["voiceSeconds"] > 6.0
    assert "mouth" in profile
    assert (REPO_DIR / "data" / "face" / "portrait.jpg").exists()
    assert (REPO_DIR / "data" / "voice" / "reference.wav").exists()
    assert (REPO_DIR / "public" / "preview.wav").exists()
    assert (REPO_DIR / "public" / "preview.mp4").exists()


def test_health_endpoint(live_server):
    with urllib.request.urlopen(f"{BASE_URL}/health", timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["status"] == "healthy"
        assert data["service"] == "likeness-desk"


def test_api_status_endpoint(live_server):
    with urllib.request.urlopen(f"{BASE_URL}/api/status", timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["voiceModel"] is True
        assert data["voiceTrained"] is True
        assert data["face"] is True
        assert "Quadro P1000" in data["faceGpuName"]
        assert isinstance(data["mouth"], dict)


def test_api_portrait_image(live_server):
    with urllib.request.urlopen(f"{BASE_URL}/api/portrait", timeout=2.0) as r:
        assert r.status == 200
        assert "image/jpeg" in r.headers.get("Content-Type", "")
        raw = r.read()
        assert len(raw) > 1000
        assert raw[:2] == b"\xff\xd8"


def test_api_mouth_roi_update(live_server):
    profile_path = REPO_DIR / "data" / "profile.json"
    original = json.loads(profile_path.read_text(encoding="utf-8"))
    payload = json.dumps({"mouth": original["mouth"]}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/api/mouth",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["ok"] is True
        assert abs(data["mouth"]["x"] - original["mouth"]["x"]) < 1e-4


def test_api_speak_json_and_wav(live_server):
    payload = json.dumps({"text": "Sovereign AI video double verification on Quadro P1000."}).encode("utf-8")
    req_json = urllib.request.Request(
        f"{BASE_URL}/api/speak",
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
        f"{BASE_URL}/api/speak",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req_wav, timeout=3.0) as r:
        assert r.status == 200
        assert "audio/wav" in r.headers.get("Content-Type", "")
        wav_bytes = r.read()
        assert wav_bytes[:4] == b"RIFF"


def test_api_face_render_mp4(live_server):
    wav_sample = (REPO_DIR / "public" / "preview.wav").read_bytes()[:4096]
    req = urllib.request.Request(
        f"{BASE_URL}/api/face/render",
        data=wav_sample,
        headers={"Content-Type": "audio/wav"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3.0) as r:
        assert r.status == 200
        assert "video/mp4" in r.headers.get("Content-Type", "")
        mp4_bytes = r.read()
        assert len(mp4_bytes) > 10000


def test_zothos_cli_binary():
    res = subprocess.run(["likeness-desk", "--json"], capture_output=True, text=True, check=True)
    data = json.loads(res.stdout)
    assert data["id"] == "likeness-desk"
    assert data["status"] == "READY"
    assert "Zero Paywalls" in data["license"]
