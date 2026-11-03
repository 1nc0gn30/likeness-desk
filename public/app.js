const statusLine = document.getElementById('statusLine');
const stageCanvas = document.getElementById('stageCanvas');
const stageHint = document.getElementById('stageHint');
const idleVideo = document.getElementById('idleVideo');
const transcript = document.getElementById('transcript');
const talkInput = document.getElementById('talkInput');
const talkForm = document.getElementById('talkForm');
const micBtn = document.getElementById('micBtn');
const answerBtn = document.getElementById('answerBtn');
const hearBtn = document.getElementById('hearBtn');
const recordVoice = document.getElementById('recordVoice');
const learnVoice = document.getElementById('learnVoice');
const voiceMeta = document.getElementById('voiceMeta');
const openCam = document.getElementById('openCam');
const takePhoto = document.getElementById('takePhoto');
const recordIdle = document.getElementById('recordIdle');
const faceMeta = document.getElementById('faceMeta');
const cam = document.getElementById('cam');
const faceVideo = document.getElementById('faceVideo');
const ctx = stageCanvas.getContext('2d');

const history = [];
let desk = { voiceModel: false, voiceTrained: false, face: false, idle: false, mouth: null, chat: false };
let voiceBlob = null;
let portrait = null;
let speaking = false;
let amp = 0;
let audioCtx = null;
let analyser = null;
let camStream = null;
let drag = null;
let stopRecording = null;
let holdPhoto = false;
let previewText = '';
let previewReady = false;
let previewFace = false;
let previewHeard = false;
let faceUrl = null;
let keeper = null;
let currentSource = null;
let speakGen = 0;
let holdStatus = false;
let renderClock = null;

function setStatus(text, isError) {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', Boolean(isError));
}

function addLine(who, text) {
  const item = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = who;
  item.append(name, document.createTextNode(text));
  transcript.append(item);
  transcript.scrollTop = transcript.scrollHeight;
}

async function checkPreview() {
  if (previewHeard) return;
  if (!previewText) {
    const note = await fetch('/preview.txt', { cache: 'no-store' });
    if (!note.ok) return;
    previewText = (await note.text()).replace(/\s+/g, ' ').trim();
  }
  if (!previewReady) {
    const ready = await fetch('/preview.ready', { cache: 'no-store' });
    previewReady = ready.ok;
  }
  if (previewReady && !previewFace) {
    const face = await fetch('/preview.face', { cache: 'no-store' });
    previewFace = face.ok;
  }
  hearBtn.hidden = !previewReady;
}

async function refresh() {
  const res = await fetch('/api/status');
  desk = await res.json();
  await checkPreview();
  if (!speaking && !holdStatus) {
    if (desk.voiceError) setStatus(desk.voiceError, true);
    else if (!desk.voiceModel) setStatus('The voice model is loading. The first start downloads it once.');
    else if (!desk.voiceTrained) setStatus('Voice model is ready. Record a take, then press Stop to hear it.');
    else setStatus(desk.chat ? 'Voice copy is ready, and the chat key is set.' : 'Voice copy is ready. Type a line and press Talk, or press Listen.');
  }
  if (stopRecording) {
    learnVoice.disabled = true;
  } else if (voiceBlob) {
    learnVoice.disabled = !desk.voiceModel;
  } else {
    voiceMeta.textContent = desk.voiceTrained
      ? `Learned from a ${desk.voiceSeconds}s take.`
      : 'No take yet.';
    learnVoice.disabled = true;
  }
  if (!camStream && !drag) {
    faceMeta.textContent = desk.motion
      ? 'Moving take saved. New lines play your body and paint the mouth.'
      : (desk.face
        ? (desk.mouth
          ? (desk.faceGpu ? 'Photo saved. Record yourself moving so the body travels with the line.' : 'Photo and mouth box are saved.')
          : 'Photo saved. Drag a box around the mouth.')
        : 'No photo yet.');
  }
  answerBtn.disabled = !desk.chat;
  if (desk.face && !portrait) await loadPortrait();
  const plate = desk.motion ? 'motion' : (desk.idle ? 'idle' : '');
  if (plate && plate !== idleVideo.dataset.plate) {
    idleVideo.dataset.plate = plate;
    idleVideo.src = plate === 'motion' ? `/api/motion?t=${Date.now()}` : `/api/idle?t=${Date.now()}`;
  }
  showIdle(true);
}

function fitRect() {
  const frame = stageCanvas.getBoundingClientRect();
  const width = frame.width || 480;
  const height = frame.height || 640;
  if (!portrait) return { x: 0, y: 0, w: width, h: height, width, height };
  const scale = Math.min(width / portrait.naturalWidth, height / portrait.naturalHeight);
  const w = portrait.naturalWidth * scale;
  const h = portrait.naturalHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h, width, height };
}

function showIdle(on) {
  const useIdle = Boolean(on && (desk.motion || desk.idle) && desk.mouth && !speaking && !drag && !holdPhoto && !camStream);
  idleVideo.hidden = !useIdle;
  if (!camStream && faceVideo.hidden) stageCanvas.style.visibility = useIdle ? 'hidden' : 'visible';
}

function draw() {
  requestAnimationFrame(draw);
  if (stageCanvas.style.visibility === 'hidden') return;
  const frame = stageCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(frame.width * dpr));
  const height = Math.max(1, Math.round(frame.height * dpr));
  if (stageCanvas.width !== width || stageCanvas.height !== height) {
    stageCanvas.width = width;
    stageCanvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, frame.width, frame.height);
  if (!portrait) return;
  stageHint.hidden = true;
  const box = fitRect();
  const sway = Math.sin(performance.now() / 900) * 4;
  const nod = (speaking ? amp * 8 : 0) + Math.sin(performance.now() / 1400) * 2;
  ctx.drawImage(portrait, box.x + sway, box.y + nod, box.w, box.h);
  if (desk.mouth && speaking) {
    const mouth = desk.mouth;
    const mx = box.x + sway + mouth.x * box.w;
    const my = box.y + nod + mouth.y * box.h;
    const mw = mouth.w * box.w;
    const mh = mouth.h * box.h;
    const scale = 1 + Math.min(0.7, amp * 1.4);
    const dh = mh * scale;
    ctx.drawImage(
      portrait,
      mouth.x * portrait.naturalWidth,
      mouth.y * portrait.naturalHeight,
      mouth.w * portrait.naturalWidth,
      mouth.h * portrait.naturalHeight,
      mx,
      my - (dh - mh) / 2,
      mw,
      dh
    );
  }
  if (drag) {
    ctx.strokeStyle = '#e2a15a';
    ctx.lineWidth = 2;
    ctx.strokeRect(drag.x, drag.y, drag.w, drag.h);
  }
}

async function loadPortrait() {
  const res = await fetch(`/api/portrait?t=${Date.now()}`);
  if (!res.ok) return;
  const blob = await res.blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  if (portrait && portrait.src.startsWith('blob:')) URL.revokeObjectURL(portrait.src);
  portrait = img;
  idleVideo.hidden = speaking || !desk.idle;
}

function armAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  const resume = audioCtx.resume();
  if (resume && typeof resume.catch === 'function') resume.catch(() => {});
  if (keeper) return;
  const silent = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const source = audioCtx.createBufferSource();
  source.buffer = silent;
  source.loop = true;
  source.connect(audioCtx.destination);
  try {
    source.start();
    keeper = source;
  } catch (err) {
    keeper = null;
  }
}

function stopKeeper() {
  if (!keeper) return;
  try { keeper.stop(); } catch (err) { /* already stopped */ }
  try { keeper.disconnect(); } catch (err) { /* already disconnected */ }
  keeper = null;
}

function stopRenderClock() {
  if (!renderClock) return;
  clearInterval(renderClock);
  renderClock = null;
}

function startRenderClock() {
  stopRenderClock();
  const started = Date.now();
  statusLine.classList.remove('error');
  statusLine.textContent = 'Rendering your line in your voice. 0s.';
  renderClock = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    statusLine.textContent = `Rendering your line in your voice. ${seconds}s.`;
  }, 500);
}

function stopFaceVideo() {
  faceVideo.onended = null;
  try { faceVideo.pause(); } catch (err) { /* already paused */ }
  faceVideo.hidden = true;
  faceVideo.removeAttribute('src');
  if (faceUrl) {
    URL.revokeObjectURL(faceUrl);
    faceUrl = null;
  }
}

function stopPlayback() {
  speaking = false;
  amp = 0;
  stopRenderClock();
  stopFaceVideo();
  stageCanvas.style.visibility = 'visible';
  if (!currentSource) return;
  currentSource.onended = null;
  try { currentSource.stop(); } catch (err) { /* already stopped */ }
  currentSource = null;
}

function startGpuClock() {
  stopRenderClock();
  const started = Date.now();
  statusLine.classList.remove('error');
  statusLine.textContent = 'Drawing you on the Quadro. 0s.';
  renderClock = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    statusLine.textContent = `Drawing you on the Quadro. ${seconds}s.`;
  }, 500);
}

function sampleAmp() {
  if (!analyser) return;
  const bins = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(bins);
  let sum = 0;
  for (let i = 0; i < bins.length; i++) {
    const v = (bins[i] - 128) / 128;
    sum += v * v;
  }
  amp = Math.min(1, Math.sqrt(sum / bins.length) * 4);
}

function failSpeak(message) {
  speaking = false;
  holdStatus = true;
  stopRenderClock();
  stopFaceVideo();
  stageCanvas.style.visibility = 'visible';
  showIdle(true);
  setStatus(message, true);
}

async function speak(text, who) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length < 2) return;
  if (!desk.voiceTrained) {
    holdStatus = true;
    setStatus('Record a voice take before the double can talk.', true);
    return;
  }
  const gen = ++speakGen;
  stopPlayback();
  armAudio();
  if (who) addLine(who, line);
  speaking = true;
  holdStatus = true;
  holdPhoto = false;
  showIdle(false);
  startRenderClock();
  let res;
  try {
    res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line })
    });
  } catch (err) {
    if (gen !== speakGen) return;
    failSpeak('The voice copy did not speak.');
    return;
  }
  if (gen !== speakGen) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    failSpeak(err.error || 'The voice copy did not speak.');
    return;
  }
  let raw;
  try {
    raw = await res.arrayBuffer();
  } catch (err) {
    if (gen !== speakGen) return;
    failSpeak('The voice copy did not speak.');
    return;
  }
  if (gen !== speakGen) return;
  await playSpoken(raw, gen, 'Voice copy is ready.');
}

async function playRaw(raw, gen, doneText) {
  if (!audioCtx) {
    failSpeak('The voice copy did not speak.');
    return;
  }
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (err) { /* gesture already used */ }
  }
  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(raw.slice(0));
  } catch (err) {
    if (gen !== speakGen) return;
    failSpeak('That audio did not play.');
    return;
  }
  if (gen !== speakGen) return;
  stopRenderClock();
  const source = audioCtx.createBufferSource();
  currentSource = source;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.buffer = buffer;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  source.onended = () => {
    if (currentSource !== source) return;
    currentSource = null;
    speaking = false;
    amp = 0;
    holdStatus = false;
    stopFaceVideo();
    stageCanvas.style.visibility = 'visible';
    showIdle(true);
    setStatus(doneText || 'Voice copy is ready.');
  };
  try {
    source.start();
  } catch (err) {
    if (gen !== speakGen) return;
    failSpeak('That audio did not play. Press the button again.');
    return;
  }
  stopKeeper();
  holdStatus = true;
  setStatus('Speaking.');
  const pump = () => {
    if (!speaking || currentSource !== source) return;
    sampleAmp();
    requestAnimationFrame(pump);
  };
  pump();
}

function showFaceClip(blob, withSound) {
  if (faceUrl) URL.revokeObjectURL(faceUrl);
  faceUrl = URL.createObjectURL(blob);
  faceVideo.src = faceUrl;
  faceVideo.hidden = false;
  faceVideo.muted = !withSound;
  faceVideo.volume = 1;
  idleVideo.hidden = true;
  stageCanvas.style.visibility = 'hidden';
  holdStatus = true;
  setStatus('Speaking.');
  return faceVideo.play();
}

async function playFace(blob, raw, gen, doneText) {
  try {
    await showFaceClip(blob, true);
  } catch (err) {
    try {
      faceVideo.muted = true;
      await faceVideo.play();
    } catch (err2) {
      stopFaceVideo();
      stageCanvas.style.visibility = 'visible';
      await playRaw(raw, gen, doneText);
      return;
    }
    await playRaw(raw, gen, doneText);
    return;
  }
  if (gen !== speakGen) return;
  faceVideo.onended = () => {
    if (gen !== speakGen || faceVideo.hidden) return;
    speaking = false;
    amp = 0;
    holdStatus = false;
    stopFaceVideo();
    stageCanvas.style.visibility = 'visible';
    showIdle(true);
    setStatus(doneText || 'Voice copy is ready.');
  };
}

async function playSpoken(raw, gen, doneText) {
  if (desk.face && desk.faceGpu) {
    startGpuClock();
    let filmed = null;
    try {
      const res = await fetch('/api/face/render', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: raw
      });
      if (res.ok) filmed = await res.blob();
    } catch (err) {
      filmed = null;
    }
    if (gen !== speakGen) return;
    stopRenderClock();
    if (filmed && filmed.size > 1000) {
      try {
        await playFace(filmed, raw, gen, doneText);
        return;
      } catch (err) {
        stopFaceVideo();
        stageCanvas.style.visibility = 'visible';
      }
    }
  }
  await playRaw(raw, gen, doneText);
}

hearBtn.addEventListener('click', async () => {
  if (!previewReady || !previewText) return;
  const gen = ++speakGen;
  stopPlayback();
  armAudio();
  hearBtn.disabled = true;
  const res = await fetch('/preview.wav', { cache: 'no-store' });
  if (!res.ok || gen !== speakGen) {
    hearBtn.disabled = false;
    holdStatus = true;
    setStatus('The paragraph is not ready yet.', true);
    return;
  }
  const raw = await res.arrayBuffer();
  if (gen !== speakGen) return;
  previewHeard = true;
  hearBtn.hidden = true;
  addLine('Me', previewText);
  speaking = true;
  holdStatus = true;
  holdPhoto = false;
  showIdle(false);
  if (previewFace && !desk.motion) {
    const filmed = await fetch('/preview.mp4', { cache: 'no-store' });
    if (filmed.ok && gen === speakGen) {
      const blob = await filmed.blob();
      if (gen === speakGen && blob.size > 1000) {
        try {
          await playFace(blob, raw, gen, 'Voice copy is ready.');
          hearBtn.disabled = false;
          return;
        } catch (err) {
          stopFaceVideo();
          stageCanvas.style.visibility = 'visible';
        }
      }
    }
  }
  await playSpoken(raw, gen, 'Voice copy is ready.');
  hearBtn.disabled = false;
});

talkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = talkInput.value;
  if (text.replace(/\s+/g, ' ').trim().length < 2) return;
  armAudio();
  talkInput.value = '';
  speak(text, 'Me');
});

answerBtn.addEventListener('click', async () => {
  const text = talkInput.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  talkInput.value = '';
  addLine('Them', text);
  history.push({ role: 'them', text });
  setStatus('Thinking.');
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, history })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(data.error || 'No answer.', true);
    return;
  }
  history.push({ role: 'me', text: data.text });
  await speak(data.text, 'Me');
});

micBtn.addEventListener('click', () => {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    holdStatus = true;
    setStatus('This browser has no speech box. Type the line and press Talk.', true);
    return;
  }
  armAudio();
  const rec = new Rec();
  rec.lang = 'en-US';
  rec.onresult = (event) => {
    const text = event.results[0][0].transcript;
    talkInput.value = text;
    speak(text, 'Me');
  };
  rec.onerror = () => {
    holdStatus = true;
    setStatus('The browser did not catch that. Type the line and press Talk.', true);
  };
  rec.start();
  holdStatus = true;
  setStatus('Listening. The copy will say it back. Chrome speech leaves this machine.');
});

async function playTake(blob, canLearn) {
  const gen = ++speakGen;
  stopPlayback();
  armAudio();
  speaking = true;
  holdStatus = true;
  holdPhoto = false;
  showIdle(false);
  setStatus('Playing your recording.');
  const raw = await blob.arrayBuffer();
  if (gen !== speakGen) return;
  const doneText = canLearn
    ? 'That was your recording. Learn this take updates the copy.'
    : 'That was under six seconds. Read a little more, then the copy can learn it.';
  await playRaw(raw, gen, doneText);
}

recordVoice.addEventListener('click', async () => {
  if (stopRecording) {
    armAudio();
    stopRecording();
    return;
  }
  let stream;
  try {
    armAudio();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    holdStatus = true;
    setStatus('The microphone was not allowed.', true);
    return;
  }
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const started = Date.now();
  stopRecording = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  recordVoice.textContent = 'Stop';
  holdStatus = true;
  setStatus('Recording. Press Stop to hear the take.');
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    voiceMeta.textContent = `Recording ${seconds}s. Read the script.`;
    if (seconds >= 26 && stopRecording) stopRecording();
  }, 250);
  const done = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();
  await done;
  clearInterval(timer);
  stopRecording = null;
  stream.getTracks().forEach((track) => track.stop());
  recordVoice.textContent = 'Record voice';
  const seconds = (Date.now() - started) / 1000;
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  const canLearn = seconds > 6 && blob.size > 0;
  if (!canLearn) {
    voiceBlob = null;
    learnVoice.disabled = true;
    voiceMeta.textContent = 'That was under six seconds. Read a little more.';
  } else {
    voiceBlob = blob;
    learnVoice.disabled = !desk.voiceModel;
    voiceMeta.textContent = 'Playing the take. Learn this take updates the copy.';
  }
  if (blob.size > 0) await playTake(blob, canLearn);
});

learnVoice.addEventListener('click', async () => {
  if (!voiceBlob) return;
  armAudio();
  learnVoice.disabled = true;
  holdStatus = true;
  setStatus('Learning the take.');
  const res = await fetch('/api/voice', { method: 'POST', body: voiceBlob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(data.error || 'The take was not learned.', true);
    learnVoice.disabled = false;
    return;
  }
  voiceBlob = null;
  await refresh();
  await speak('This is my voice, saying a new sentence I did not record.');
});

async function ensureCam() {
  if (camStream) return camStream;
  camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 720 }, audio: false });
  cam.srcObject = camStream;
  cam.hidden = false;
  stageCanvas.style.display = 'none';
  idleVideo.hidden = true;
  stageHint.hidden = true;
  await cam.play();
  return camStream;
}

openCam.addEventListener('click', async () => {
  try {
    await ensureCam();
    takePhoto.disabled = false;
    recordIdle.disabled = false;
    faceMeta.textContent = 'Camera is open.';
  } catch (err) {
    setStatus('The camera was not allowed.', true);
  }
});

function shot() {
  const canvas = document.createElement('canvas');
  canvas.width = cam.videoWidth || 480;
  canvas.height = cam.videoHeight || 640;
  const pen = canvas.getContext('2d');
  pen.translate(canvas.width, 0);
  pen.scale(-1, 1);
  pen.drawImage(cam, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

takePhoto.addEventListener('click', async () => {
  const blob = await shot();
  if (!blob) return;
  const res = await fetch('/api/face', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    setStatus(data.error || 'The photo was not saved.', true);
    return;
  }
  cam.hidden = true;
  stageCanvas.style.display = 'block';
  if (camStream) camStream.getTracks().forEach((track) => track.stop());
  camStream = null;
  portrait = null;
  await refresh();
  faceMeta.textContent = 'Photo saved. Drag a box around the mouth.';
});

let recordingMotion = false;

recordIdle.addEventListener('click', async () => {
  if (recordingMotion) return;
  await ensureCam();
  recordingMotion = true;
  recordIdle.disabled = true;
  const recorder = new MediaRecorder(camStream);
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const done = new Promise((resolve) => { recorder.onstop = resolve; });
  const started = Date.now();
  recorder.start();
  const timer = setInterval(() => {
    const left = Math.max(0, 15 - (Date.now() - started) / 1000);
    faceMeta.textContent = `Talk and move your hands. ${Math.ceil(left)}s.`;
  }, 250);
  setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 15000);
  await done;
  clearInterval(timer);
  recordingMotion = false;
  recordIdle.disabled = false;
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  const res = await fetch('/api/motion', { method: 'POST', body: blob });
  if (!res.ok) {
    setStatus('The moving take was not saved.', true);
    return;
  }
  delete idleVideo.dataset.plate;
  idleVideo.removeAttribute('src');
  await refresh();
  faceMeta.textContent = 'Moving take saved. New lines play your body and paint the mouth.';
});

function point(event) {
  const rect = stageCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

stageCanvas.addEventListener('pointerdown', (event) => {
  if (!portrait || speaking) return;
  stageCanvas.setPointerCapture(event.pointerId);
  const start = point(event);
  drag = { x: start.x, y: start.y, w: 0, h: 0, start };
});

stageCanvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const now = point(event);
  drag.x = Math.min(drag.start.x, now.x);
  drag.y = Math.min(drag.start.y, now.y);
  drag.w = Math.abs(now.x - drag.start.x);
  drag.h = Math.abs(now.y - drag.start.y);
});

stageCanvas.addEventListener('pointerup', async () => {
  if (!drag || !portrait) { drag = null; return; }
  const box = fitRect();
  const mouth = {
    x: (drag.x - box.x) / box.w,
    y: (drag.y - box.y) / box.h,
    w: drag.w / box.w,
    h: drag.h / box.h
  };
  drag = null;
  mouth.x = Math.min(1, Math.max(0, mouth.x));
  mouth.y = Math.min(1, Math.max(0, mouth.y));
  mouth.w = Math.min(1 - mouth.x, Math.max(0, mouth.w));
  mouth.h = Math.min(1 - mouth.y, Math.max(0, mouth.h));
  const res = await fetch('/api/mouth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mouth })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    faceMeta.textContent = data.error || 'Mark a slightly larger box.';
    return;
  }
  desk.mouth = data.mouth;
  faceMeta.textContent = 'Mouth box saved.';
});

idleVideo.addEventListener('click', () => {
  holdPhoto = true;
  showIdle(false);
  faceMeta.textContent = 'Drag a new box around the mouth.';
});

requestAnimationFrame(draw);
refresh();
setInterval(refresh, 4000);
