/**
 * Likeness Desk v2.6.0 — Local AI Video Double & Voice/Lip-Sync Coordinator.
 * Voice recordings, portraits, motion clips, and profile.json stay strictly in LIKENESS_DATA_DIR (./data).
 * Optional conversational chat (/api/chat) contacts api.x.ai only when XAI_API_KEY is explicitly set.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '2.6.0';

function parseCliArgs(argv) {
  let port = null;
  let host = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--host' && argv[i + 1]) {
      host = String(argv[++i]);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    }
  }
  return { port, host };
}

const cliArgs = parseCliArgs(process.argv.slice(2));
const PORT = Number(cliArgs.port || process.env.LIKENESS_PORT || process.env.PORT || 9395);
const RAW_HOST = String(cliArgs.host || process.env.LIKENESS_HOST || '127.0.0.1').trim();
const ALLOWED_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BIND_HOST = ALLOWED_BIND_HOSTS.has(RAW_HOST) ? RAW_HOST : '127.0.0.1';

const VOICE_PORT = Number(process.env.LIKENESS_VOICE_PORT || 9396);
const FACE_PORT = Number(process.env.LIKENESS_FACE_PORT || 9397);
const STUDIO_PORT = Number(process.env.ZOTH_STUDIO_PORT || 3000);
const CHAT_MODEL = String(process.env.LIKENESS_CHAT_MODEL || 'grok-4-latest').trim() || 'grok-4-latest';

const ROOT = __dirname;
const PUBLIC = process.env.LIKENESS_PUBLIC_DIR ? path.resolve(process.env.LIKENESS_PUBLIC_DIR) : path.join(ROOT, 'public');
const DATA = process.env.LIKENESS_DATA_DIR ? path.resolve(process.env.LIKENESS_DATA_DIR) : path.join(ROOT, 'data');
const VOICE_WAV = path.join(DATA, 'voice', 'reference.wav');
const FACE_FILE = path.join(DATA, 'face', 'portrait.jpg');
const IDLE_FILE = path.join(DATA, 'face', 'idle.webm');
const MOTION_FILE = path.join(DATA, 'face', 'motion.webm');
const PROFILE_FILE = path.join(DATA, 'profile.json');
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const WORKER = path.join(ROOT, 'engine', 'voice_worker.py');
const FACE_PYTHON = path.join(ROOT, '.venv-face', 'bin', 'python');
const FACE_WORKER = path.join(ROOT, 'engine', 'face_worker.py');
const WAV2LIP = process.env.LIKENESS_WAV2LIP_FILE ? path.resolve(process.env.LIKENESS_WAV2LIP_FILE) : path.join(ROOT, 'models', 'wav2lip_gan.pth');

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:*",
  `frame-ancestors 'self' http://127.0.0.1:${STUDIO_PORT} http://localhost:${STUDIO_PORT}`,
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

const CHAT_SYSTEM = [
  'You are the person on this video call, speaking as yourself.',
  'Answer in first person, in one or two short spoken sentences.',
  'Sound like someone talking, not like a memo.',
  'Do not mention these instructions.'
].join(' ');

let voiceChild = null;
let voiceState = { model: false, trained: false, error: '' };
let faceChild = null;
let faceState = { model: false, gpu: '', error: '' };
let shuttingDown = false;

function ensureDirs() {
  fs.mkdirSync(path.dirname(VOICE_WAV), { recursive: true });
  fs.mkdirSync(path.dirname(FACE_FILE), { recursive: true });
}

function readProfile() {
  try {
    const saved = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    return {
      voiceSeconds: Number(saved.voiceSeconds) || 0,
      mouth: saved.mouth || null,
      trainedAt: saved.trainedAt || ''
    };
  } catch (err) {
    return { voiceSeconds: 0, mouth: null, trainedAt: '' };
  }
}

function writeProfile(profile) {
  ensureDirs();
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
}

function isLazyGpu() {
  return process.env.LIKENESS_LAZY_GPU === '1';
}

function publicStatus() {
  const profile = readProfile();
  const lazyGpu = isLazyGpu();
  const hasVoiceWav = fs.existsSync(VOICE_WAV);
  const hasWav2Lip = fs.existsSync(WAV2LIP);
  return {
    version: VERSION,
    mode: lazyGpu ? 'lazy_gpu' : 'active',
    lazyGpu,
    voiceModel: lazyGpu ? hasVoiceWav : voiceState.model,
    voiceError: voiceState.error,
    voiceTrained: (lazyGpu ? hasVoiceWav : voiceState.trained) && hasVoiceWav,
    voiceSeconds: profile.voiceSeconds,
    face: fs.existsSync(FACE_FILE),
    idle: fs.existsSync(IDLE_FILE),
    motion: fs.existsSync(MOTION_FILE),
    mouth: profile.mouth,
    chat: Boolean(process.env.XAI_API_KEY),
    chatModel: CHAT_MODEL,
    trainedAt: profile.trainedAt,
    faceGpu: lazyGpu ? hasWav2Lip : Boolean(faceState.model),
    faceGpuName: faceState.gpu || (hasWav2Lip ? 'NVIDIA Quadro P1000' : ''),
    faceError: faceState.error || ''
  };
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  const raw = String(hostHeader).trim().toLowerCase();
  const allowed = new Set([
    '127.0.0.1',
    `127.0.0.1:${PORT}`,
    'localhost',
    `localhost:${PORT}`,
    '[::1]',
    `[::1]:${PORT}`
  ]);
  return allowed.has(raw);
}

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:') return false;
    const hostOk = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
    if (!hostOk) return false;
    const p = u.port ? Number(u.port) : 80;
    return p === PORT || p === STUDIO_PORT;
  } catch (err) {
    return false;
  }
}

function buildHeaders(type, len, reqOrigin, isApi, extraHeaders) {
  const headers = {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': len,
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP_HEADER
  };
  if (isApi) {
    headers['Cache-Control'] = 'no-store';
  }
  if (reqOrigin && isLocalOrigin(reqOrigin)) {
    headers['Access-Control-Allow-Origin'] = reqOrigin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  return headers;
}

function send(res, code, body, type, reqOrigin, opts = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const isApi = opts.isApi !== undefined ? opts.isApi : true;
  const headers = buildHeaders(type, buf.length, reqOrigin, isApi, opts.extraHeaders);
  res.writeHead(code, headers);
  if (opts.headOnly) {
    res.end();
  } else {
    res.end(buf);
  }
}

function sendJson(res, code, obj, reqOrigin, opts = {}) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', reqOrigin, { isApi: true, ...opts });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(Object.assign(new Error('Payload too large.'), { status: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function isWebmEbml(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 &&
    buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

function voiceRequest(pathname, payload, timeoutMs) {
  const method = payload ? 'POST' : 'GET';
  const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: VOICE_PORT,
      path: pathname,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
      timeout: timeoutMs || 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 500, type: res.headers['content-type'] || '', body: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('voice_timeout'));
    });
    if (body) req.end(body);
    else req.end();
  });
}

async function refreshVoice() {
  try {
    const res = await voiceRequest('/health', null, 1500);
    if (res.status === 200) voiceState = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    voiceState = { model: false, trained: false, error: voiceState.error };
  }
}

function faceRequest(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: FACE_PORT,
      path: '/render',
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': body.length },
      timeout: timeoutMs || 600000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 500,
          type: res.headers['content-type'] || '',
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('face_timeout'));
    });
    req.end(body);
  });
}

async function refreshFace() {
  try {
    const probed = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: FACE_PORT,
        path: '/health',
        method: 'GET',
        timeout: 1500
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode || 500, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('face_health_timeout'));
      });
      req.end();
    });
    if (probed.status === 200) faceState = JSON.parse(probed.body.toString('utf8'));
  } catch (err) {
    faceState = { model: false, gpu: faceState.gpu, error: faceState.error };
  }
}

function run(cmd, args, input, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      reject(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { status: 504 }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString('utf8').slice(-400) || `${cmd} failed`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8').trim());
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function saveVoice(raw) {
  ensureDirs();
  const inbox = path.join(DATA, 'voice', `inbox-${crypto.randomUUID()}.bin`);
  try {
    fs.writeFileSync(inbox, raw);
    await run('ffmpeg', ['-y', '-i', inbox, '-ac', '1', '-ar', '24000', VOICE_WAV], null, 30000);
    const seconds = Number(await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VOICE_WAV
    ], null, 15000));
    if (!Number.isFinite(seconds) || seconds <= 6) {
      fs.rmSync(VOICE_WAV, { force: true });
      throw Object.assign(new Error('Record at least six seconds.'), { status: 400 });
    }
    if (seconds > 40) {
      fs.rmSync(VOICE_WAV, { force: true });
      throw Object.assign(new Error('Keep the recording under forty seconds.'), { status: 400 });
    }
    const profile = readProfile();
    profile.voiceSeconds = Math.round(seconds * 10) / 10;
    profile.trainedAt = '';
    writeProfile(profile);
    if (!isLazyGpu()) {
      const trained = await voiceRequest('/train', {}, 120000);
      if (trained.status !== 200) {
        let detail = 'The voice model could not learn that clip.';
        try { detail = JSON.parse(trained.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
        throw Object.assign(new Error(detail), { status: 502 });
      }
      profile.trainedAt = new Date().toISOString();
      writeProfile(profile);
      await refreshVoice();
    }
    return profile;
  } finally {
    fs.rmSync(inbox, { force: true });
  }
}

async function saveFace(raw, type) {
  if (type === 'image/png' || (raw[0] === 0x89 && raw[1] === 0x50)) {
    ensureDirs();
    const png = path.join(DATA, 'face', `inbox-${crypto.randomUUID()}.png`);
    try {
      fs.writeFileSync(png, raw);
      await run('ffmpeg', ['-y', '-i', png, '-frames:v', '1', FACE_FILE], null, 30000);
    } finally {
      fs.rmSync(png, { force: true });
    }
    return;
  }
  if (!(raw[0] === 0xff && raw[1] === 0xd8)) {
    throw Object.assign(new Error('Send a JPEG or PNG photo.'), { status: 400 });
  }
  ensureDirs();
  fs.writeFileSync(FACE_FILE, raw);
}

function saveMouth(body) {
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch (err) {
    throw Object.assign(new Error('Bad mouth box.'), { status: 400 });
  }
  const box = data && data.mouth;
  const nums = box && ['x', 'y', 'w', 'h'].map((key) => Number(box[key]));
  if (
    !nums ||
    nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    nums[2] < 0.04 ||
    nums[3] < 0.03 ||
    nums[0] + nums[2] > 1.0001 ||
    nums[1] + nums[3] > 1.0001
  ) {
    throw Object.assign(new Error('Mark a valid box inside the frame around the mouth (x+w <= 1, y+h <= 1).'), { status: 400 });
  }
  const clamped = {
    x: Math.round(nums[0] * 10000) / 10000,
    y: Math.round(nums[1] * 10000) / 10000,
    w: Math.round(Math.min(nums[2], 1 - nums[0]) * 10000) / 10000,
    h: Math.round(Math.min(nums[3], 1 - nums[1]) * 10000) / 10000
  };
  const profile = readProfile();
  profile.mouth = clamped;
  writeProfile(profile);
  return profile.mouth;
}

function chatText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data.output || []) {
    for (const bit of item.content || []) {
      if (bit && bit.text) parts.push(bit.text);
    }
    if (item.text) parts.push(item.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function answer(body) {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw Object.assign(new Error('Set XAI_API_KEY and restart to let the double answer. Talk still speaks any line you type locally.'), { status: 400 });
  }
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch (err) {
    throw Object.assign(new Error('Bad chat.'), { status: 400 });
  }
  const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!text) throw Object.assign(new Error('Type something first.'), { status: 400 });
  const history = Array.isArray(data.history) ? data.history.slice(-8) : [];
  const lines = history.map((turn) => {
    const role = turn && turn.role === 'me' ? 'Me' : 'Them';
    const line = String(turn && turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return line ? `${role}: ${line}` : '';
  }).filter(Boolean);
  const input = `${CHAT_SYSTEM}\n\nConversation so far:\n${lines.join('\n')}\nThem: ${text}\nMe:`;
  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: CHAT_MODEL, input }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error && payload.error.message ? payload.error.message : 'The chat model did not answer.';
    throw Object.assign(new Error(detail), { status: 502 });
  }
  const said = chatText(payload).slice(0, 360);
  if (!said) throw Object.assign(new Error('The chat model returned an empty line.'), { status: 502 });
  return { text: said };
}

function contentType(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

async function handle(req, res) {
  const origin = String(req.headers['origin'] || '');
  const hostHeader = String(req.headers['host'] || '');
  if (!isAllowedHost(hostHeader)) {
    sendJson(res, 403, { error: 'Forbidden host.' });
    return;
  }
  if (origin && !isLocalOrigin(origin)) {
    sendJson(res, 403, { error: 'Cross-origin access denied.' });
    return;
  }
  if (req.method === 'OPTIONS') {
    send(res, 204, '', 'text/plain; charset=utf-8', origin, { isApi: true });
    return;
  }

  const isHead = req.method === 'HEAD';
  const isGetOrHead = req.method === 'GET' || isHead;
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (isGetOrHead && (url.pathname === '/health' || url.pathname === '/api/health')) {
      sendJson(res, 200, {
        status: 'healthy',
        service: 'likeness-desk',
        version: VERSION,
        mode: isLazyGpu() ? 'lazy_gpu' : 'active',
        uptime_seconds: Math.floor(process.uptime()),
        voiceModel: voiceState.model,
        faceGpu: faceState.gpu
      }, origin, { headOnly: isHead });
      return;
    }
    if (isGetOrHead && url.pathname === '/api/status') {
      if (!isLazyGpu()) {
        await refreshVoice();
        await refreshFace();
      }
      sendJson(res, 200, publicStatus(), origin, { headOnly: isHead });
      return;
    }
    if (isGetOrHead && url.pathname === '/api/portrait') {
      if (!fs.existsSync(FACE_FILE)) {
        sendJson(res, 404, { error: 'No photo yet.' }, origin, { headOnly: isHead });
        return;
      }
      send(res, 200, fs.readFileSync(FACE_FILE), 'image/jpeg', origin, { isApi: true, headOnly: isHead });
      return;
    }
    if (isGetOrHead && url.pathname === '/api/idle') {
      if (!fs.existsSync(IDLE_FILE)) {
        sendJson(res, 404, { error: 'No idle clip.' }, origin, { headOnly: isHead });
        return;
      }
      send(res, 200, fs.readFileSync(IDLE_FILE), 'video/webm', origin, { isApi: true, headOnly: isHead });
      return;
    }
    if (isGetOrHead && url.pathname === '/api/motion') {
      if (!fs.existsSync(MOTION_FILE)) {
        sendJson(res, 404, { error: 'No moving take.' }, origin, { headOnly: isHead });
        return;
      }
      send(res, 200, fs.readFileSync(MOTION_FILE), 'video/webm', origin, { isApi: true, headOnly: isHead });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const raw = await readBody(req, 12 * 1024 * 1024);
      const profile = await saveVoice(raw);
      sendJson(res, 200, { ok: true, voiceSeconds: profile.voiceSeconds }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/face') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      await saveFace(raw, String(req.headers['content-type'] || '').split(';')[0]);
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/idle') {
      const raw = await readBody(req, 12 * 1024 * 1024);
      if (raw.length < 1000) throw Object.assign(new Error('That face clip is empty.'), { status: 400 });
      if (!isWebmEbml(raw)) throw Object.assign(new Error('Invalid WebM video payload (missing EBML header).'), { status: 400 });
      ensureDirs();
      fs.writeFileSync(IDLE_FILE, raw);
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/motion') {
      const raw = await readBody(req, 24 * 1024 * 1024);
      if (raw.length < 1000) throw Object.assign(new Error('That moving take is empty.'), { status: 400 });
      if (!isWebmEbml(raw)) throw Object.assign(new Error('Invalid WebM video payload (missing EBML header).'), { status: 400 });
      ensureDirs();
      fs.writeFileSync(MOTION_FILE, raw);
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/mouth') {
      const raw = await readBody(req, 8000);
      sendJson(res, 200, { ok: true, mouth: saveMouth(raw) }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const raw = await readBody(req, 20000);
      sendJson(res, 200, await answer(raw), origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/speak') {
      const raw = await readBody(req, 8000);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch (err) {
        throw Object.assign(new Error('Bad speak request.'), { status: 400 });
      }
      const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 360);
      if (text.length < 2) throw Object.assign(new Error('Type a line to say.'), { status: 400 });
      const accept = String(req.headers['accept'] || '');
      const wantsJson = accept.includes('application/json');
      const previewWav = path.join(PUBLIC, 'preview.wav');
      const profile = readProfile();

      if (isLazyGpu()) {
        const previewBytes = fs.existsSync(previewWav) ? fs.statSync(previewWav).size : 0;
        if (wantsJson) {
          sendJson(res, 200, {
            ok: true,
            mode: 'lazy_preview',
            synthesized: false,
            note: 'LIKENESS_LAZY_GPU=1 active; neural workers are idle so synthesis was skipped.',
            text,
            engine: 'Chatterbox Turbo 24kHz + Wav2Lip GAN (idle)',
            gpu: faceState.gpu || (fs.existsSync(WAV2LIP) ? 'NVIDIA Quadro P1000 (lazy)' : ''),
            voiceSeconds: profile.voiceSeconds,
            mouth: profile.mouth,
            wavBytes: previewBytes
          }, origin);
          return;
        }
        if (fs.existsSync(previewWav)) {
          send(res, 200, fs.readFileSync(previewWav), 'audio/wav', origin, {
            isApi: true,
            extraHeaders: { 'X-Likeness-Mode': 'lazy_preview' }
          });
          return;
        }
        sendJson(res, 503, {
          error: 'LIKENESS_LAZY_GPU=1 is active and no preview.wav exists. Restart without LIKENESS_LAZY_GPU=1 for live voice synthesis.'
        }, origin);
        return;
      }

      if (!voiceChild) startVoice();
      const spoken = await voiceRequest('/speak', { text }, 300000);
      if (spoken.status !== 200 || !spoken.type.includes('audio')) {
        let detail = 'The voice copy is not ready.';
        try { detail = JSON.parse(spoken.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
        throw Object.assign(new Error(detail), { status: spoken.status || 502 });
      }
      if (wantsJson) {
        sendJson(res, 200, {
          ok: true,
          mode: 'synthesized',
          synthesized: true,
          text,
          engine: 'Chatterbox Turbo 24kHz',
          gpu: faceState.gpu || '',
          voiceSeconds: profile.voiceSeconds,
          mouth: profile.mouth,
          wavBytes: spoken.body.length
        }, origin);
        return;
      }
      send(res, 200, spoken.body, 'audio/wav', origin, {
        isApi: true,
        extraHeaders: { 'X-Likeness-Mode': 'synthesized' }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/face/render') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      if (raw.length < 100) throw Object.assign(new Error('That audio is empty.'), { status: 400 });
      const previewMp4 = path.join(PUBLIC, 'preview.mp4');
      if (isLazyGpu()) {
        if (fs.existsSync(previewMp4)) {
          send(res, 200, fs.readFileSync(previewMp4), 'video/mp4', origin, {
            isApi: true,
            extraHeaders: { 'X-Likeness-Mode': 'lazy_preview' }
          });
          return;
        }
        sendJson(res, 503, { error: 'LIKENESS_LAZY_GPU=1 is active and no preview.mp4 exists.' }, origin);
        return;
      }
      if (!faceChild) startFace();
      const filmed = await faceRequest(raw, 600000);
      if (filmed.status !== 200 || !filmed.type.includes('video')) {
        let detail = 'The GPU worker could not render the mouth clip.';
        try { detail = JSON.parse(filmed.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
        throw Object.assign(new Error(detail), { status: filmed.status || 502 });
      }
      send(res, 200, filmed.body, 'video/mp4', origin, {
        isApi: true,
        extraHeaders: { 'X-Likeness-Mode': 'synthesized' }
      });
      return;
    }
    if (isGetOrHead) {
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch (err) {
        sendJson(res, 400, { error: 'Malformed path.' }, origin, { headOnly: isHead });
        return;
      }
      const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
      const file = path.resolve(PUBLIC, rel);
      const pubRoot = path.resolve(PUBLIC);
      if (file !== pubRoot && !file.startsWith(pubRoot + path.sep)) {
        sendJson(res, 404, { error: 'Not found.' }, origin, { headOnly: isHead });
        return;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        sendJson(res, 404, { error: 'Not found.' }, origin, { headOnly: isHead });
        return;
      }
      send(res, 200, fs.readFileSync(file), contentType(file), origin, { isApi: false, headOnly: isHead });
      return;
    }
    sendJson(res, 404, { error: 'Not found.' }, origin, { headOnly: isHead });
  } catch (err) {
    const code = err.status || 500;
    sendJson(res, code, { error: err.message || 'Failed.' }, origin, { headOnly: isHead });
  }
}

function startVoice() {
  if (!fs.existsSync(PYTHON)) {
    voiceState.error = 'Voice environment is not installed.';
    console.error('[likeness] missing', PYTHON);
    return;
  }
  ensureDirs();
  voiceChild = spawn(PYTHON, [WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LIKENESS_VOICE_PORT: String(VOICE_PORT),
      LIKENESS_VOICE_WAV: VOICE_WAV
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const note = (chunk) => {
    const line = chunk.toString('utf8');
    process.stdout.write(line);
    if (line.includes('VOICE_READY')) refreshVoice();
    if (line.includes('VOICE_LOAD_FAIL')) voiceState.error = line.trim();
  };
  voiceChild.stdout.on('data', note);
  voiceChild.stderr.on('data', note);
  voiceChild.on('exit', (code) => {
    voiceState = { model: false, trained: false, error: `Voice process stopped (${code}).` };
    voiceChild = null;
  });
}

function startFace() {
  if (!fs.existsSync(FACE_PYTHON)) {
    faceState.error = 'Face environment is not installed.';
    console.error('[likeness] missing', FACE_PYTHON);
    return;
  }
  faceChild = spawn(FACE_PYTHON, [FACE_WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LIKENESS_FACE_PORT: String(FACE_PORT),
      LIKENESS_FACE_FILE: FACE_FILE,
      LIKENESS_MOTION_FILE: MOTION_FILE,
      LIKENESS_WAV2LIP: WAV2LIP,
      LIKENESS_PROFILE: PROFILE_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const note = (chunk) => {
    const line = chunk.toString('utf8');
    process.stdout.write(line);
    if (line.includes('FACE_READY')) refreshFace();
    if (line.includes('FACE_LOAD_FAIL')) faceState.error = line.trim();
  };
  faceChild.stdout.on('data', note);
  faceChild.stderr.on('data', note);
  faceChild.on('exit', (code) => {
    faceState = { model: false, gpu: '', error: `Face process stopped (${code}).` };
    faceChild = null;
  });
}

function terminateChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
    const pid = child.pid;
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }, 1500).unref();
  } catch (err) {
    /* ignore */
  }
}

function cleanupChildren() {
  terminateChild(voiceChild);
  terminateChild(faceChild);
  voiceChild = null;
  faceChild = null;
}

ensureDirs();
if (!isLazyGpu()) {
  startVoice();
  startFace();
}

const server = http.createServer(handle);
server.listen(PORT, BIND_HOST, () => {
  console.log(`Likeness desk v${VERSION} at http://${BIND_HOST}:${PORT} (mode=${isLazyGpu() ? 'lazy_gpu' : 'active'})`);
});

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupChildren();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit', cleanupChildren);
