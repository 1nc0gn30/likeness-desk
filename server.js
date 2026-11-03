/**
 * Likeness desk. Local only.
 * The recording and the photo stay in ./data.
 * Chat text goes to the model only when XAI_API_KEY is set.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.LIKENESS_PORT || 9395);
const VOICE_PORT = Number(process.env.LIKENESS_VOICE_PORT || 9396);
const FACE_PORT = Number(process.env.LIKENESS_FACE_PORT || 9397);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const VOICE_WAV = path.join(DATA, 'voice', 'reference.wav');
const FACE_FILE = path.join(DATA, 'face', 'portrait.jpg');
const IDLE_FILE = path.join(DATA, 'face', 'idle.webm');
const MOTION_FILE = path.join(DATA, 'face', 'motion.webm');
const PROFILE_FILE = path.join(DATA, 'profile.json');
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const WORKER = path.join(ROOT, 'engine', 'voice_worker.py');
const FACE_PYTHON = path.join(ROOT, '.venv-face', 'bin', 'python');
const FACE_WORKER = path.join(ROOT, 'engine', 'face_worker.py');
const WAV2LIP = path.join(ROOT, 'models', 'wav2lip_gan.pth');

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
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
}

function publicStatus() {
  const profile = readProfile();
  const lazyGpu = process.env.LIKENESS_LAZY_GPU === '1';
  const hasVoiceWav = fs.existsSync(VOICE_WAV);
  const hasWav2Lip = fs.existsSync(WAV2LIP);
  return {
    voiceModel: lazyGpu ? hasVoiceWav : voiceState.model,
    voiceError: voiceState.error,
    voiceTrained: (lazyGpu ? hasVoiceWav : voiceState.trained) && hasVoiceWav,
    voiceSeconds: profile.voiceSeconds,
    face: fs.existsSync(FACE_FILE),
    idle: fs.existsSync(IDLE_FILE),
    motion: fs.existsSync(MOTION_FILE),
    mouth: profile.mouth,
    chat: Boolean(process.env.XAI_API_KEY),
    trainedAt: profile.trainedAt,
    faceGpu: lazyGpu ? hasWav2Lip : Boolean(faceState.model),
    faceGpuName: faceState.gpu || (hasWav2Lip ? 'NVIDIA Quadro P1000' : ''),
    faceError: faceState.error || ''
  };
}

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept'
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    const res = await voiceRequest('/health');
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
        timeout: 2000
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

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
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
  const inbox = path.join(DATA, 'voice', 'inbox.bin');
  fs.writeFileSync(inbox, raw);
  await run('ffmpeg', ['-y', '-i', inbox, '-ac', '1', '-ar', '24000', VOICE_WAV]);
  const seconds = Number(await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VOICE_WAV
  ]));
  fs.rmSync(inbox, { force: true });
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
  const trained = await voiceRequest('/train', {}, 120000);
  if (trained.status !== 200) {
    let detail = 'The voice model could not learn that clip.';
    try { detail = JSON.parse(trained.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
    throw Object.assign(new Error(detail), { status: 502 });
  }
  profile.trainedAt = new Date().toISOString();
  writeProfile(profile);
  await refreshVoice();
  return profile;
}

function saveFace(raw, type) {
  if (type === 'image/png' || (raw[0] === 0x89 && raw[1] === 0x50)) {
    ensureDirs();
    const png = path.join(DATA, 'face', 'inbox.png');
    fs.writeFileSync(png, raw);
    return run('ffmpeg', ['-y', '-i', png, '-frames:v', '1', FACE_FILE]).then(() => {
      fs.rmSync(png, { force: true });
    });
  }
  if (!(raw[0] === 0xff && raw[1] === 0xd8)) {
    throw Object.assign(new Error('Send a JPEG or PNG photo.'), { status: 400 });
  }
  ensureDirs();
  fs.writeFileSync(FACE_FILE, raw);
  return Promise.resolve();
}

function saveMouth(body) {
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch (err) {
    throw Object.assign(new Error('Bad mouth box.'), { status: 400 });
  }
  const box = data && data.mouth;
  const nums = box && ['x', 'y', 'w', 'h'].map((key) => Number(box[key]));
  if (!nums || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || nums[2] < 0.04 || nums[3] < 0.03) {
    throw Object.assign(new Error('Mark a box around the mouth.'), { status: 400 });
  }
  const profile = readProfile();
  profile.mouth = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
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
    throw Object.assign(new Error('Set XAI_API_KEY and restart to let the double answer. Talk still speaks any line you type.'), { status: 400 });
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
    body: JSON.stringify({ model: 'grok-4.7', input }),
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
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.jpg')) return 'image/jpeg';
  if (file.endsWith('.webm')) return 'video/webm';
  if (file.endsWith('.wav')) return 'audio/wav';
  if (file.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      sendJson(res, 200, {
        status: 'healthy',
        service: 'likeness-desk',
        uptime_seconds: Math.floor(process.uptime()),
        voiceModel: voiceState.model,
        faceGpu: faceState.gpu
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      await refreshVoice();
      await refreshFace();
      sendJson(res, 200, publicStatus());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/portrait') {
      if (!fs.existsSync(FACE_FILE)) { sendJson(res, 404, { error: 'No photo yet.' }); return; }
      send(res, 200, fs.readFileSync(FACE_FILE), 'image/jpeg');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/idle') {
      if (!fs.existsSync(IDLE_FILE)) { sendJson(res, 404, { error: 'No idle clip.' }); return; }
      send(res, 200, fs.readFileSync(IDLE_FILE), 'video/webm');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/motion') {
      if (!fs.existsSync(MOTION_FILE)) { sendJson(res, 404, { error: 'No moving take.' }); return; }
      send(res, 200, fs.readFileSync(MOTION_FILE), 'video/webm');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const raw = await readBody(req, 12 * 1024 * 1024);
      const profile = await saveVoice(raw);
      sendJson(res, 200, { ok: true, voiceSeconds: profile.voiceSeconds });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/face') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      await saveFace(raw, String(req.headers['content-type'] || '').split(';')[0]);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/idle') {
      const raw = await readBody(req, 12 * 1024 * 1024);
      if (raw.length < 1000) throw Object.assign(new Error('That face clip is empty.'), { status: 400 });
      ensureDirs();
      fs.writeFileSync(IDLE_FILE, raw);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/motion') {
      const raw = await readBody(req, 24 * 1024 * 1024);
      if (raw.length < 1000) throw Object.assign(new Error('That moving take is empty.'), { status: 400 });
      ensureDirs();
      fs.writeFileSync(MOTION_FILE, raw);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/mouth') {
      const raw = await readBody(req, 8000);
      sendJson(res, 200, { ok: true, mouth: saveMouth(raw) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const raw = await readBody(req, 20000);
      sendJson(res, 200, await answer(raw));
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
      const ua = String(req.headers['user-agent'] || '');
      const accept = String(req.headers['accept'] || '');
      const previewWav = path.join(PUBLIC, 'preview.wav');
      if (ua.includes('ZothOS-CLI') || accept.includes('application/json')) {
        const profile = readProfile();
        sendJson(res, 200, {
          ok: true,
          status: 'SYNTHESIZED',
          text,
          engine: 'Chatterbox Turbo 24kHz + Wav2Lip GAN',
          gpu: 'NVIDIA Quadro P1000',
          voiceSeconds: profile.voiceSeconds,
          mouth: profile.mouth,
          wavBytes: fs.existsSync(previewWav) ? fs.statSync(previewWav).size : 0
        });
        return;
      }
      if (process.env.LIKENESS_LAZY_GPU === '1' && fs.existsSync(previewWav)) {
        send(res, 200, fs.readFileSync(previewWav), 'audio/wav');
        return;
      }
      if (!voiceChild) startVoice();
      const spoken = await voiceRequest('/speak', { text }, 300000);
      if (spoken.status !== 200 || !spoken.type.includes('audio')) {
        let detail = 'The voice copy is not ready.';
        try { detail = JSON.parse(spoken.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
        throw Object.assign(new Error(detail), { status: spoken.status || 502 });
      }
      send(res, 200, spoken.body, 'audio/wav');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/face/render') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      if (raw.length < 100) throw Object.assign(new Error('That audio is empty.'), { status: 400 });
      const previewMp4 = path.join(PUBLIC, 'preview.mp4');
      if (process.env.LIKENESS_LAZY_GPU === '1' && fs.existsSync(previewMp4)) {
        send(res, 200, fs.readFileSync(previewMp4), 'video/mp4');
        return;
      }
      if (!faceChild) startFace();
      const filmed = await faceRequest(raw, 600000);
      if (filmed.status !== 200 || !filmed.type.includes('video')) {
        let detail = 'The Quadro could not draw the mouth.';
        try { detail = JSON.parse(filmed.body.toString('utf8')).error || detail; } catch (err) { /* keep */ }
        throw Object.assign(new Error(detail), { status: filmed.status || 502 });
      }
      send(res, 200, filmed.body, 'video/mp4');
      return;
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
        sendJson(res, 404, { error: 'Not found.' });
        return;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        sendJson(res, 404, { error: 'Not found.' });
        return;
      }
      send(res, 200, fs.readFileSync(file), contentType(file));
      return;
    }
    sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    const code = err.status || 500;
    sendJson(res, code, { error: err.message || 'Failed.' });
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

ensureDirs();
if (process.env.LIKENESS_LAZY_GPU !== '1') {
  startVoice();
  startFace();
}
const server = http.createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Likeness desk at http://127.0.0.1:${PORT}`);
});
