"""Automated Developer, Security, CLI, TUI & MCP Test Suite for Likeness Desk v2.6.0.

All tests execute against isolated temporary data/public directories via LIKENESS_DATA_DIR
and LIKENESS_PUBLIC_DIR with LIKENESS_LAZY_GPU=1 so Neal's personal ./data/ directory is
never touched and no heavy CUDA PyTorch / Wav2Lip models are loaded.
"""

import http.client
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


def _raw_http(port: int, method: str, path: str, headers=None, body: bytes = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=4.0)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, dict(resp.getheaders()), data
    finally:
        conn.close()


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
    env.pop("XAI_API_KEY", None)
    env["LIKENESS_PORT"] = str(port)
    env["LIKENESS_LAZY_GPU"] = "1"
    env["LIKENESS_DATA_DIR"] = str(data_dir)
    env["LIKENESS_PUBLIC_DIR"] = str(pub_dir)
    env["LIKENESS_WAV2LIP_FILE"] = str(wav2lip_stub)

    proc = subprocess.Popen(
        ["node", "server.js", "--port", str(port)],
        cwd=str(REPO_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://127.0.0.1:{port}"
    ready = False
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=1.0) as r:
                if r.status == 200:
                    ready = True
                    break
        except Exception:
            time.sleep(0.1)
    assert ready, "sandbox server failed to boot"

    yield {"port": port, "base_url": base_url, "data_dir": data_dir, "pub_dir": pub_dir, "proc": proc}

    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()


def test_repo_privacy_and_packaging_hygiene():
    gitignore = (REPO_DIR / ".gitignore").read_text(encoding="utf-8")
    assert "data/" in gitignore
    for req in ("server.js", "LICENSE", "package.json", "README.md", "likeness-desk.desktop"):
        assert (REPO_DIR / req).is_file(), f"missing {req}"
    for pub_req in ("index.html", "style.css", "app.js", "og-image.png", "icon.png", "robots.txt", "sitemap.xml", "llms.txt"):
        assert (REPO_DIR / "public" / pub_req).is_file(), f"missing public/{pub_req}"
    assert (REPO_DIR / "public" / ".well-known" / "mcp.json").is_file()
    assert not (REPO_DIR / "public" / "assets").exists(), "unused public/assets bloat must stay removed"
    assert not (REPO_DIR / "public" / "og-banner.jpg").exists(), "misnamed og-banner.jpg must stay removed"


def test_health_and_api_health_include_version(sandbox):
    for route in ("/health", "/api/health"):
        status, headers, body = _raw_http(sandbox["port"], "GET", route)
        assert status == 200
        data = json.loads(body.decode("utf-8"))
        assert data["status"] == "healthy"
        assert data["service"] == "likeness-desk"
        assert data["version"] == "2.6.0"
        assert data["mode"] == "lazy_gpu"


def test_head_requests_return_200_with_empty_body(sandbox):
    for route in ("/", "/health", "/api/status", "/robots.txt", "/sitemap.xml", "/og-image.png"):
        status, headers, body = _raw_http(sandbox["port"], "HEAD", route)
        assert status == 200, f"HEAD {route} failed with {status}"
        assert body == b""


def test_all_four_security_headers_on_pages_and_api(sandbox):
    for route, expect_no_store in (("/", False), ("/health", True), ("/api/status", True)):
        status, headers, _ = _raw_http(sandbox["port"], "GET", route)
        assert status == 200
        lower = {k.lower(): v for k, v in headers.items()}
        assert lower.get("x-frame-options") == "SAMEORIGIN"
        assert lower.get("x-content-type-options") == "nosniff"
        assert lower.get("referrer-policy") == "strict-origin-when-cross-origin"
        assert "default-src 'self'" in lower.get("content-security-policy", "")
        assert "frame-ancestors 'self' http://127.0.0.1:3000" in lower.get("content-security-policy", "")
        if expect_no_store:
            assert lower.get("cache-control") == "no-store"


def test_dns_rebinding_host_rejected_403(sandbox):
    status, _, body = _raw_http(sandbox["port"], "GET", "/health", headers={"Host": "evil.example.invalid"})
    assert status == 403
    assert "host" in body.decode("utf-8").lower()

    status2, _, _ = _raw_http(
        sandbox["port"],
        "POST",
        "/api/speak",
        headers={"Host": "evil.example.invalid", "Content-Type": "application/json"},
        body=b'{"text":"hello"}',
    )
    assert status2 == 403


def test_foreign_origin_blocked_403(sandbox):
    for method, route in (("GET", "/api/status"), ("OPTIONS", "/api/status"), ("POST", "/api/speak")):
        status, _, _ = _raw_http(
            sandbox["port"],
            method,
            route,
            headers={"Origin": "https://evil.example", "Content-Type": "application/json"},
            body=b'{"text":"hello"}' if method == "POST" else None,
        )
        assert status == 403


def test_cross_port_loopback_origin_blocked_403(sandbox):
    status, _, _ = _raw_http(
        sandbox["port"],
        "POST",
        "/api/speak",
        headers={"Origin": "http://localhost:9999", "Content-Type": "application/json"},
        body=b'{"text":"hello"}',
    )
    assert status == 403


def test_studio_origin_receives_cors_on_get_post_options(sandbox):
    origin = "http://127.0.0.1:3000"
    for method, route, body in (
        ("OPTIONS", "/api/status", None),
        ("GET", "/api/status", None),
        ("GET", "/api/portrait", None),
        ("POST", "/api/speak", b'{"text":"Studio CORS check"}'),
    ):
        headers = {"Origin": origin, "Accept": "application/json"}
        if body:
            headers["Content-Type"] = "application/json"
        status, resp_headers, _ = _raw_http(sandbox["port"], method, route, headers=headers, body=body)
        assert status in (200, 204), f"{method} {route} -> {status}"
        lower = {k.lower(): v for k, v in resp_headers.items()}
        assert lower.get("access-control-allow-origin") == origin, f"missing ACAO on {method} {route}"
        assert "Origin" in lower.get("vary", "")


def test_oversized_payload_returns_clean_413(sandbox):
    big_body = json.dumps({"text": "A" * 10000}).encode("utf-8")
    status, _, body = _raw_http(
        sandbox["port"],
        "POST",
        "/api/speak",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        body=big_body,
    )
    assert status == 413
    data = json.loads(body.decode("utf-8"))
    assert "large" in data["error"].lower()


def test_malformed_json_returns_400(sandbox):
    for route in ("/api/speak", "/api/mouth"):
        status, _, _ = _raw_http(
            sandbox["port"],
            "POST",
            route,
            headers={"Content-Type": "application/json"},
            body=b"{bad json",
        )
        assert status == 400


def test_path_traversal_contained_404(sandbox):
    for route in ("/../server.js", "/%2e%2e/server.js", "/../data/profile.json", "/nonexistent-404-probe"):
        status, _, _ = _raw_http(sandbox["port"], "GET", route)
        assert status == 404


def test_static_mime_types_complete(sandbox):
    expected = {
        "/robots.txt": "text/plain",
        "/sitemap.xml": "application/xml",
        "/llms.txt": "text/plain",
        "/og-image.png": "image/png",
        "/icon.png": "image/png",
        "/.well-known/mcp.json": "application/json",
    }
    for route, mime in expected.items():
        status, headers, _ = _raw_http(sandbox["port"], "GET", route)
        assert status == 200, f"{route} -> {status}"
        lower = {k.lower(): v for k, v in headers.items()}
        assert mime in lower.get("content-type", ""), f"{route} got {lower.get('content-type')}"


def test_api_status_endpoint(sandbox):
    with urllib.request.urlopen(f"{sandbox['base_url']}/api/status", timeout=2.0) as r:
        assert r.status == 200
        data = json.loads(r.read().decode("utf-8"))
        assert data["version"] == "2.6.0"
        assert data["lazyGpu"] is True
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


def test_api_mouth_roi_valid_and_out_of_bounds_rejected(sandbox):
    profile_path = sandbox["data_dir"] / "profile.json"
    original = json.loads(profile_path.read_text(encoding="utf-8"))

    # Out-of-bounds x+w > 1 must return 400
    for bad in (
        {"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5},
        {"x": -0.1, "y": 0.5, "w": 0.2, "h": 0.1},
        {"x": 0.4, "y": 0.5, "w": 0.01, "h": 0.1},
    ):
        status, _, _ = _raw_http(
            sandbox["port"],
            "POST",
            "/api/mouth",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"mouth": bad}).encode("utf-8"),
        )
        assert status == 400, f"expected 400 for {bad}, got {status}"

    # Valid ROI succeeds
    updated = {"x": 0.40, "y": 0.63, "w": 0.22, "h": 0.13}
    status, _, body = _raw_http(
        sandbox["port"],
        "POST",
        "/api/mouth",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"mouth": updated}).encode("utf-8"),
    )
    assert status == 200
    data = json.loads(body.decode("utf-8"))
    assert data["ok"] is True
    assert abs(data["mouth"]["x"] - updated["x"]) < 1e-4

    profile_path.write_text(json.dumps(original, indent=2), encoding="utf-8")


def test_webm_ebml_magic_validation_on_idle_and_motion(sandbox):
    for route in ("/api/idle", "/api/motion"):
        # Reject arbitrary non-WebM bytes
        status_bad, _, _ = _raw_http(
            sandbox["port"],
            "POST",
            route,
            headers={"Content-Type": "video/webm"},
            body=b"NOT_A_WEBM_FILE_" * 100,
        )
        assert status_bad == 400

        # Accept valid EBML header (>= 1000 bytes)
        valid_ebml = b"\x1a\x45\xdf\xa3" + (b"\x00" * 1200)
        status_ok, _, body = _raw_http(
            sandbox["port"],
            "POST",
            route,
            headers={"Content-Type": "video/webm"},
            body=valid_ebml,
        )
        assert status_ok == 200
        assert json.loads(body.decode("utf-8"))["ok"] is True


def test_api_speak_honest_lazy_preview_json_and_wav(sandbox):
    payload = json.dumps({"text": "Local AI video double verification on loopback."}).encode("utf-8")
    status, _, body = _raw_http(
        sandbox["port"],
        "POST",
        "/api/speak",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        body=payload,
    )
    assert status == 200
    res = json.loads(body.decode("utf-8"))
    assert res["ok"] is True
    assert res["mode"] == "lazy_preview"
    assert res["synthesized"] is False
    assert res.get("status") != "SYNTHESIZED"
    assert res["wavBytes"] > 10000

    status_w, headers_w, wav_bytes = _raw_http(
        sandbox["port"],
        "POST",
        "/api/speak",
        headers={"Content-Type": "application/json"},
        body=payload,
    )
    assert status_w == 200
    lower = {k.lower(): v for k, v in headers_w.items()}
    assert "audio/wav" in lower.get("content-type", "")
    assert lower.get("x-likeness-mode") == "lazy_preview"
    assert wav_bytes[:4] == b"RIFF"


def test_api_face_render_mp4_and_empty_rejection(sandbox):
    status_bad, _, _ = _raw_http(
        sandbox["port"],
        "POST",
        "/api/face/render",
        headers={"Content-Type": "audio/wav"},
        body=b"tiny",
    )
    assert status_bad == 400

    wav_sample = (sandbox["pub_dir"] / "preview.wav").read_bytes()[:4096]
    status, headers, mp4_bytes = _raw_http(
        sandbox["port"],
        "POST",
        "/api/face/render",
        headers={"Content-Type": "audio/wav"},
        body=wav_sample,
    )
    assert status == 200
    lower = {k.lower(): v for k, v in headers.items()}
    assert "video/mp4" in lower.get("content-type", "")
    assert len(mp4_bytes) > 10000


def test_api_chat_gated_without_key(sandbox):
    status, _, body = _raw_http(
        sandbox["port"],
        "POST",
        "/api/chat",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"text": "Hello?"}).encode("utf-8"),
    )
    assert status == 400
    assert "XAI_API_KEY" in body.decode("utf-8")


def test_cli_help_version_ui_and_redacted_json(sandbox):
    cli_bin = REPO_DIR / "bin" / "likeness-desk"
    assert cli_bin.is_file()

    env = os.environ.copy()
    env["LIKENESS_PORT"] = str(sandbox["port"])

    res_help = subprocess.run([str(cli_bin), "--help"], capture_output=True, text=True, check=True, env=env)
    assert "likeness-desk" in res_help.stdout

    res_ver = subprocess.run([str(cli_bin), "--version"], capture_output=True, text=True, check=True, env=env)
    assert "2.6.0" in res_ver.stdout

    res_ui = subprocess.run([str(cli_bin), "--ui"], capture_output=True, text=True, check=True, env=env)
    assert res_ui.stdout.strip() == f"http://127.0.0.1:{sandbox['port']}"

    res_json = subprocess.run([str(cli_bin), "--json"], capture_output=True, text=True, check=True, env=env)
    assert "/home/" not in res_json.stdout, "CLI --json must redact literal /home/<user>"
    data = json.loads(res_json.stdout)
    assert data["id"] == "likeness-desk"
    assert data["version"] == "2.6.0"
    assert data["daemon_active"] is True
    assert "likeness_status" in data["mcp_tools"]


def test_cli_speak_exits_nonzero_when_daemon_offline():
    cli_bin = REPO_DIR / "bin" / "likeness-desk"
    dead_port = _free_port()
    res = subprocess.run(
        [str(cli_bin), "speak", "Offline check", "--port", str(dead_port)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert res.returncode != 0


def test_tui_real_telemetry_no_fake_metrics(sandbox):
    tui_bin = REPO_DIR / "bin" / "likeness-desk-tui"
    assert tui_bin.is_file()

    res_status = subprocess.run(
        [str(tui_bin), "--status", "--port", str(sandbox["port"])],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "2.6.0" in res_status.stdout
    assert "ONLINE" in res_status.stdout

    res_json = subprocess.run(
        [str(tui_bin), "--json", "--port", str(sandbox["port"])],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "AST/Engine Latency" not in res_json.stdout
    assert "canvasui-html-effects" not in res_json.stdout
    assert "/home/" not in res_json.stdout
    data = json.loads(res_json.stdout)
    assert data["online"] is True
    assert data["version"] == "2.6.0"


def test_mcp_stdio_jsonrpc_initialize_list_and_call(sandbox):
    mcp_bin = REPO_DIR / "bin" / "likeness-desk-mcp"
    assert mcp_bin.is_file()

    env = os.environ.copy()
    env["LIKENESS_PORT"] = str(sandbox["port"])
    env["LIKENESS_DATA_DIR"] = str(sandbox["data_dir"])

    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "likeness_diagnostics", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "likeness_status", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "likeness_mouth_roi", "arguments": {"action": "get"}}},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "likeness_speak", "arguments": {"text": "MCP tool check"}}},
    ]
    stdin_payload = "\n".join(json.dumps(r) for r in requests) + "\n"
    proc = subprocess.run(
        ["node", str(mcp_bin)],
        input=stdin_payload,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
        check=True,
    )
    lines = [json.loads(line) for line in proc.stdout.strip().splitlines() if line.strip()]
    by_id = {m["id"]: m for m in lines}

    assert by_id[1]["result"]["serverInfo"]["name"] == "likeness-desk"
    assert by_id[1]["result"]["serverInfo"]["version"] == "2.6.0"

    tool_names = [t["name"] for t in by_id[2]["result"]["tools"]]
    assert tool_names == ["likeness_status", "likeness_mouth_roi", "likeness_speak", "likeness_diagnostics"]

    diag = json.loads(by_id[3]["result"]["content"][0]["text"])
    assert diag["daemonOnline"] is True
    assert diag["version"] == "2.6.0"
    assert "/home/" not in diag["dataDir"]

    st = json.loads(by_id[4]["result"]["content"][0]["text"])
    assert st["online"] is True

    roi = json.loads(by_id[5]["result"]["content"][0]["text"])
    assert roi["ok"] is True
    assert isinstance(roi["mouth"], dict)

    spk = json.loads(by_id[6]["result"]["content"][0]["text"])
    assert spk["ok"] is True
    assert spk["result"]["mode"] == "lazy_preview"
    assert spk["result"]["synthesized"] is False


def test_sigterm_graceful_shutdown(tmp_path):
    port = _free_port()
    env = os.environ.copy()
    env["LIKENESS_LAZY_GPU"] = "1"
    env["LIKENESS_DATA_DIR"] = str(tmp_path / "data")
    proc = subprocess.Popen(
        ["node", "server.js", "--port", str(port)],
        cwd=str(REPO_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        for _ in range(30):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.1)
        proc.terminate()
        code = proc.wait(timeout=4)
        assert code == 0
    finally:
        if proc.poll() is None:
            proc.kill()
