// Apprentice frontend. Three views: Record (expert), Guide (novice), Data (robot dataset).

const $ = (id) => document.getElementById(id);
const CHECK_EVERY_MS = 1200; // pause between checks; each check itself takes about 3 s
const FRAME_EVERY_MS = 1500;
const HAND_EVERY_MS = 100;

let STATUS = { mock: true, tts: false };

// ---------- small utils ----------

function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function captureJpeg(video, maxW = 768, quality = 0.72) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return Promise.resolve(null);
  const scale = Math.min(1, maxW / w);
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

async function openCamera(video, withAudio) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera needs HTTPS. Open the https link on your phone.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
    audio: withAudio,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function audioMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return "";
}
const extFor = (mime) => (mime.includes("mp4") || mime.includes("aac") ? "m4a" : "webm");

// ---------- speech out ----------

const player = new Audio();
player.playsInline = true;
// Speech queue: pending lines can be dropped (they go stale fast), and the
// current line can be cut off when something more important happens.
const speechQueue = [];
let speaking = false;
let stopCurrent = null;

function unlockAudio() {
  // iOS only lets audio play after a user gesture: play a silent clip once.
  player.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRBqpAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
  player.play().catch(() => {});
  if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  // Create the audio context inside the tap, or iOS keeps it suspended.
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch {}
}

// lowPriority lines (nudges, reminders) are skipped if anything else is queued or playing.
function speak(text, lowPriority = false) {
  if (!text) return Promise.resolve();
  if (lowPriority && (speaking || speechQueue.length)) return Promise.resolve();
  return new Promise((done) => {
    speechQueue.push({ text, done });
    if (!speaking) drainSpeech();
  });
}

// Drop everything waiting; optionally cut off the line being spoken.
function clearSpeech(cutCurrent = false) {
  while (speechQueue.length) speechQueue.shift().done();
  if (cutCurrent) stopCurrent?.();
}

async function drainSpeech() {
  speaking = true;
  while (speechQueue.length) {
    const item = speechQueue.shift();
    try { await speakNow(item.text); } catch {}
    item.done();
  }
  speaking = false;
}

// Fixed lines (intro, every step, praise) are generated once at the start, so
// moving to the next step plays instantly instead of waiting for ElevenLabs.
const ttsCache = new Map(); // text -> Promise<blob URL | null>

function ttsUrl(text) {
  if (!STATUS.tts) return Promise.resolve(null);
  if (!ttsCache.has(text)) {
    ttsCache.set(text, fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
      .then(async (r) => (r.status === 200 ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null));
  }
  return ttsCache.get(text);
}

async function prefetchSpeech(lines) {
  const queue = [...lines];
  const worker = async () => { while (queue.length) await ttsUrl(queue.shift()); };
  await Promise.all([worker(), worker(), worker()]);
}

async function speakNow(text) {
  let played = false;
  if (STATUS.tts) {
    const url = await ttsUrl(text);
    if (url) {
      player.src = url;
      await new Promise((res) => {
        stopCurrent = () => { player.pause(); res(); };
        player.onended = res;
        player.onerror = res;
        player.play().catch(res);
      });
      stopCurrent = null;
      played = true;
    }
  }
  if (!played && window.speechSynthesis) {
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onend = res;
      u.onerror = res;
      stopCurrent = () => { speechSynthesis.cancel(); res(); };
      speechSynthesis.speak(u);
      setTimeout(res, 12000);
    });
    stopCurrent = null;
  }
}

// ---------- hand tracking (MediaPipe, runs in the browser) ----------

let handLandmarker = null;
let handLoading = null;

function loadHands() {
  if (handLoading) return handLoading;
  handLoading = (async () => {
    try {
      const v = "0.10.14";
      const { HandLandmarker, FilesetResolver } = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/wasm`);
      handLandmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
    } catch (e) {
      console.warn("Hand tracking unavailable", e);
      handLandmarker = null;
    }
    return handLandmarker;
  })();
  return handLoading;
}

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

// Runs hand detection on a video and draws it; calls onSample(hands) at ~10 Hz.
function startHandLoop(video, canvas, onSample) {
  let stop = false;
  let lastT = 0;
  const ctx = canvas.getContext("2d");
  const tick = () => {
    if (stop) return;
    requestAnimationFrame(tick);
    const now = performance.now();
    if (!handLandmarker || !video.videoWidth || now - lastT < HAND_EVERY_MS) return;
    lastT = now;
    let res;
    try { res = handLandmarker.detectForVideo(video, now); } catch { return; }
    const hands = (res.landmarks || []).map((lm, i) => ({
      side: res.handednesses?.[i]?.[0]?.categoryName || "",
      lm: lm.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]),
    }));
    drawHands(ctx, canvas, video, hands);
    onSample?.(hands);
  };
  requestAnimationFrame(tick);
  return () => {
    stop = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

function drawHands(ctx, canvas, video, hands) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * devicePixelRatio) {
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
  }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Map normalised video coords to an object-fit: cover element.
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  const P = (p) => [ox + p[0] * vw * s, oy + p[1] * vh * s];
  for (const h of hands) {
    ctx.strokeStyle = "rgba(91,143,240,0.9)";
    ctx.lineWidth = 2.5;
    for (const [a, b] of HAND_LINKS) {
      const [x1, y1] = P(h.lm[a]), [x2, y2] = P(h.lm[b]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.fillStyle = "#ffffff";
    for (const p of h.lm) {
      const [x, y] = P(p);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// ---------- navigation ----------

function show(view) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["record", "guide", "data"]) $(`view-${v}`).hidden = v !== view;
  if (view === "guide" && !guide.running) renderGuideList();
  if (view === "data") renderData();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// ======================================================================
// RECORD (expert)
// ======================================================================

const rec = { stream: null, recording: false, frames: [], times: [], hands: [], audioChunks: [], mr: null, t0: 0, timer: null, stopHands: null, proc: null };

$("rec-cam").onclick = async () => {
  if (rec.stream) return;
  try {
    rec.stream = await openCamera($("rec-video"), true);
    $("rec-empty").hidden = true;
    $("rec-go").disabled = false;
    $("rec-cam").textContent = "Camera on";
    $("rec-cam").disabled = true;
    loadHands().then(() => {
      rec.stopHands = startHandLoop($("rec-video"), $("rec-overlay"), (hands) => {
        if (rec.recording) rec.hands.push({ t: +((performance.now() - rec.t0) / 1000).toFixed(2), hands });
      });
    });
  } catch (e) {
    toast(e.message || "Couldn't open the camera");
  }
};

$("rec-go").onclick = () => (rec.recording ? stopRecording() : startRecording());

function startRecording() {
  Object.assign(rec, { frames: [], times: [], hands: [], audioChunks: [], recording: true, t0: performance.now() });
  const mime = audioMime();
  const audioTracks = rec.stream.getAudioTracks();
  if (audioTracks.length && window.MediaRecorder) {
    rec.mr = new MediaRecorder(new MediaStream(audioTracks), mime ? { mimeType: mime } : undefined);
    rec.mr.ondataavailable = (e) => e.data.size && rec.audioChunks.push(e.data);
    rec.mr.start(1000);
  }
  $("rec-go").textContent = "Stop and build guide";
  $("rec-go").classList.add("rec");
  $("rec-badge").hidden = false;
  rec.timer = setInterval(async () => {
    const t = (performance.now() - rec.t0) / 1000;
    $("rec-timer").textContent = fmtTime(t);
    const blob = await captureJpeg($("rec-video"));
    if (blob && rec.recording) {
      rec.frames.push(blob);
      rec.times.push(+t.toFixed(2));
    }
    $("rec-info").textContent = `${rec.frames.length} frames, ${rec.hands.length} hand samples. Keep talking through each step.`;
  }, FRAME_EVERY_MS);
}

async function stopRecording() {
  rec.recording = false;
  clearInterval(rec.timer);
  $("rec-badge").hidden = true;
  $("rec-go").classList.remove("rec");
  $("rec-go").disabled = true;
  $("rec-go").textContent = "Building guide…";
  let audioBlob = null;
  if (rec.mr && rec.mr.state !== "inactive") {
    await new Promise((res) => { rec.mr.onstop = res; rec.mr.stop(); });
    audioBlob = new Blob(rec.audioChunks, { type: rec.mr.mimeType || "audio/webm" });
  }
  if (rec.frames.length < 2) {
    toast("Record for a few more seconds");
    resetRecButton();
    return;
  }
  const fd = new FormData();
  rec.frames.forEach((b, i) => fd.append("frames", b, `${i}.jpg`));
  fd.append("frame_times", JSON.stringify(rec.times));
  fd.append("title", $("rec-title").value.trim());
  fd.append("hands", JSON.stringify(rec.hands));
  if (audioBlob) fd.append("audio", audioBlob, `audio.${extFor(audioBlob.type)}`);
  $("rec-info").textContent = "Turning the demo into steps. This takes up to a minute.";
  try {
    const proc = await api("/api/procedures/build", { method: "POST", body: fd });
    showResult(proc);
  } catch (e) {
    toast(e.message, 6000);
    $("rec-info").textContent = "";
  }
  resetRecButton();
}

function resetRecButton() {
  $("rec-go").disabled = false;
  $("rec-go").textContent = "Start recording";
}

$("rec-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("video", file);
  fd.append("title", $("rec-title").value.trim());
  $("rec-info").textContent = `Uploading ${file.name} and turning it into steps. This takes up to a minute.`;
  try {
    showResult(await api("/api/procedures/build_from_video", { method: "POST", body: fd }));
  } catch (err) {
    toast(err.message, 6000);
    $("rec-info").textContent = "";
  }
  e.target.value = "";
};

function showResult(proc) {
  rec.proc = proc;
  $("rec-info").textContent = "";
  $("rec-result").hidden = false;
  $("res-title").textContent = proc.title || "Untitled";
  $("res-summary").textContent = proc.summary || "";
  $("res-steps").className = "steps-edit";
  $("res-steps").innerHTML = proc.steps.map((s, i) => `
    <div class="se" data-i="${i}">
      <img src="/api/procedures/${proc.id}/frame/${s.ref_frame}" alt="">
      <div>
        <div class="n">Step ${i + 1}</div>
        <input data-k="title" value="${esc(s.title)}">
        <textarea data-k="instruction">${esc(s.instruction)}</textarea>
        <input data-k="done_when" value="${esc(s.done_when)}" title="Done when">
      </div>
    </div>`).join("");
  $("rec-result").scrollIntoView({ behavior: "smooth" });
}

$("res-save").onclick = async () => {
  const p = rec.proc;
  document.querySelectorAll("#res-steps .se").forEach((el) => {
    const s = p.steps[+el.dataset.i];
    el.querySelectorAll("[data-k]").forEach((f) => (s[f.dataset.k] = f.value.trim()));
  });
  rec.proc = await api(`/api/procedures/${p.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: p.steps }) });
  toast("Guide saved");
};

$("res-use").onclick = async () => {
  await $("res-save").onclick();
  stopStream(rec.stream);
  rec.stopHands?.();
  rec.stream = null;
  $("rec-cam").disabled = false;
  $("rec-cam").textContent = "Start camera";
  $("rec-empty").hidden = false;
  show("guide");
  startGuide(rec.proc.id);
};

// ======================================================================
// GUIDE (novice gets live help)
// ======================================================================

const guide = {
  running: false, proc: null, step: 0, stream: null, session: null, t0: 0,
  inflight: false, loop: null, stopHands: null, saveTimer: null, wakeLock: null,
  stepStartedAt: 0, lastCaptureAt: 0, latestApplied: 0, inflightN: 0, prevBlob: null,
  history: [], votes: [], verifying: false, verifiedAt: 0,
  mistakeOnStep: false, mistakeActive: false, mistakeSpokenAt: 0, nudgeAt: 0, paused: false,
};

async function renderGuideList() {
  const list = await api("/api/procedures");
  $("g-empty").hidden = list.length > 0;
  $("g-list").innerHTML = list.map((p) => `
    <button class="item" data-id="${p.id}">
      <span><strong>${esc(p.title)}</strong><br><span class="muted small">${p.steps} steps</span></span>
      <span class="btn primary">Start</span>
    </button>`).join("");
  $("g-list").querySelectorAll(".item").forEach((b) => (b.onclick = () => startGuide(b.dataset.id)));
}

const now = () => +((performance.now() - guide.t0) / 1000).toFixed(2);
const logEvent = (type, extra = {}) => guide.session.events.push({ t: now(), type, step: guide.step, ...extra });

async function startGuide(pid) {
  unlockAudio();
  const proc = await api(`/api/procedures/${pid}`);
  Object.assign(guide, { proc, step: 0, running: true, t0: performance.now(), paused: false });
  resetMotion();
  keepAwake();
  guide.session = {
    id: "s" + Date.now().toString(36),
    role: "novice",
    procedure_id: proc.id,
    procedure_title: proc.title,
    started: Date.now() / 1000,
    events: [],
    hands: [],
    frames: [],
    completed: false,
  };
  $("g-pick").hidden = true;
  $("g-finish").hidden = true;
  $("g-live").hidden = false;
  try {
    guide.stream = await openCamera($("g-video"), false);
  } catch (e) {
    toast(e.message || "Couldn't open the camera", 6000);
    endGuide(false);
    return;
  }
  loadHands().then(() => {
    if (!guide.running) return;
    guide.stopHands = startHandLoop($("g-video"), $("g-overlay"), (hands) => {
      updateMotion(hands);
      if (hands.length) guide.session.hands.push({ t: now(), step: guide.step, hands });
    });
  });
  guide.saveTimer = setInterval(saveSession, 8000);
  startListening();
  ttsUrl(introLine()); ttsUrl(stepLine(0)); // first lines go out first
  prefetchSpeech([...proc.steps.map((_, i) => stepLine(i)), ...PRAISE, "That was the last step. You're all done."]);
  enterStep(0, true);
  runCheckLoop();
}

const introLine = () => `Let's do this: ${guide.proc.title}.`;
const stepLine = (i) => `Step ${i + 1}. ${guide.proc.steps[i].instruction}`;

function enterStep(i, intro = false, praise = "") {
  const steps = guide.proc.steps;
  guide.step = Math.max(0, Math.min(i, steps.length - 1));
  guide.stepStartedAt = guide.latestApplied = performance.now();
  Object.assign(guide, { mistakeOnStep: false, mistakeActive: false, history: [], votes: [], prevBlob: null, mistakeSpokenAt: 0, nudgeAt: 0, verifying: false, verifiedAt: 0 });
  const s = steps[guide.step];
  $("g-stepno").textContent = `Step ${guide.step + 1} of ${steps.length}`;
  $("g-bar").style.width = `${(guide.step / steps.length) * 100}%`;
  $("g-title").textContent = s.title;
  $("g-instr").textContent = s.instruction;
  $("g-done").textContent = s.done_when ? `Done when: ${s.done_when}` : "";
  $("g-ref-wrap").hidden = !Number.isInteger(s.ref_frame);
  $("g-ref").src = `/api/procedures/${guide.proc.id}/frame/${s.ref_frame}`;
  setFeedback("", "");
  logEvent("step_start", { title: s.title });
  clearSpeech(); // anything still queued is about the previous step
  if (intro) speak(introLine());
  else if (praise) speak(praise);
  speak(stepLine(guide.step));
}

function setFeedback(text, status) {
  const f = $("g-feedback");
  f.hidden = !text;
  f.textContent = text;
  f.className = `feedback ${status || ""}`;
}

// ---------- fast local layer: hand motion decides WHEN to ask the AI ----------
// Like a robot's "System 1": MediaPipe runs on the phone at ~10 Hz and triggers
// the slow cloud check only at useful moments (hands pause or pull back).

const motion = { samples: [], lastSeen: 0, lastUpdate: 0, stillSince: 0 };
const STILL_SPEED = 0.025; // normalised centroid movement per ~0.45 s

function resetMotion() {
  Object.assign(motion, { samples: [], lastSeen: 0, lastUpdate: 0, stillSince: 0 });
}

function updateMotion(hands) {
  const t = performance.now();
  motion.lastUpdate = t;
  if (hands.length) {
    let sx = 0, sy = 0, n = 0, x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const h of hands) for (const [x, y] of h.lm) {
      sx += x; sy += y; n++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    motion.samples.push({ t, cx: sx / n, cy: sy / n, box: [x0, y0, x1, y1] });
    motion.lastSeen = t;
  }
  motion.samples = motion.samples.filter((s) => t - s.t < 3000);
  const recent = motion.samples.filter((s) => t - s.t < 450);
  const present = hands.length > 0;
  let speed = Infinity;
  if (recent.length >= 2) {
    const a = recent[0], b = recent[recent.length - 1];
    speed = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  }
  if (present && speed < STILL_SPEED) motion.stillSince ||= t;
  else motion.stillSince = 0;
}

function motionState() {
  const t = performance.now();
  return {
    tracking: !!handLandmarker && t - motion.lastUpdate < 1000,
    present: motion.lastSeen > 0 && t - motion.lastSeen < 400,
    awayFor: motion.lastSeen ? t - motion.lastSeen : 0,
    stillFor: motion.stillSince ? t - motion.stillSince : 0,
  };
}

// Union of where the hands were in the last 3 s: that is where the work is.
function workBox() {
  if (!motion.samples.length) return null;
  const b = [1, 1, 0, 0];
  for (const s of motion.samples) {
    b[0] = Math.min(b[0], s.box[0]); b[1] = Math.min(b[1], s.box[1]);
    b[2] = Math.max(b[2], s.box[2]); b[3] = Math.max(b[3], s.box[3]);
  }
  return b;
}

// Crop around the work area so small details (polarity, orientation) stay sharp.
function captureWork(video, maxOut = 640, quality = 0.75) {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W) return Promise.resolve(null);
  let sx = 0, sy = 0, sw = W, sh = H;
  const b = workBox();
  if (b) {
    const bw = (b[2] - b[0]) * W, bh = (b[3] - b[1]) * H;
    const cx = ((b[0] + b[2]) / 2) * W, cy = ((b[1] + b[3]) / 2) * H;
    const side = Math.min(Math.min(W, H), Math.max(Math.max(bw, bh) * 2, 0.55 * Math.min(W, H)));
    sw = sh = side;
    sx = Math.max(0, Math.min(W - side, cx - side / 2));
    sy = Math.max(0, Math.min(H - side, cy - side / 2));
  }
  const scale = Math.min(1, maxOut / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

// ---------- the check pipeline ----------
// A cloud check takes ~2.5 s, so we overlap them: a new frame goes out about
// every second with up to 3 in flight, and the newest capture always wins.
// The coach only speaks when results agree, so one blurry frame never talks.

const LOOP_MS = 150;
const CAPTURE_EVERY_MS = 1000;
const MAX_INFLIGHT = 3;

function runCheckLoop() {
  clearTimeout(guide.loop);
  if (!guide.running) return;
  const t = performance.now();
  if (!guide.paused && guide.inflightN < MAX_INFLIGHT && t - guide.stepStartedAt > 1200 && t - guide.lastCaptureAt >= CAPTURE_EVERY_MS) {
    checkOnce();
  }
  guide.loop = setTimeout(runCheckLoop, LOOP_MS);
}

function historyText() {
  const t = performance.now();
  return guide.history.slice(-3).map((h) => `${h.status} ${Math.round((t - h.at) / 1000)}s ago${h.feedback ? ` ("${h.feedback}")` : ""}`).join("; ");
}

async function checkOnce(verify = false) {
  if (!guide.running) return;
  const capturedAt = performance.now();
  if (!verify) guide.lastCaptureAt = capturedAt;
  const blob = await captureWork($("g-video"), verify ? 960 : 640);
  if (!blob) return;
  const prev = guide.prevBlob;
  if (!verify) guide.prevBlob = blob;
  const stepAtSend = guide.step;
  const fd = new FormData();
  fd.append("image", blob, "f.jpg");
  if (prev) fd.append("prev_image", prev, "p.jpg");
  fd.append("procedure_id", guide.proc.id);
  fd.append("step_index", stepAtSend);
  fd.append("session_id", guide.session.id);
  fd.append("t", now());
  fd.append("history", historyText());
  fd.append("verify", verify ? "1" : "0");
  guide.inflightN++;
  $("g-checking").hidden = false;
  let r;
  try {
    r = await api("/api/check", { method: "POST", body: fd });
  } catch (e) {
    r = { status: "error", observation: e.message };
  }
  guide.inflightN--;
  if (verify) guide.verifying = false;
  $("g-checking").hidden = guide.inflightN === 0;
  if (!guide.running || stepAtSend !== guide.step) return; // step changed meanwhile

  const outdated = capturedAt < guide.latestApplied; // a newer frame already answered
  if (r.frame) guide.session.frames.push({ file: r.frame, t: now(), step: stepAtSend, status: r.status, observation: r.observation, feedback: r.feedback, verified: verify });
  logEvent("check", { status: r.status, feedback: r.feedback, observation: r.observation, latency: r.latency, verified: verify, outdated });
  if (outdated || r.status === "error") {
    if (r.status === "error") setFeedback("Connection hiccup, still watching", "error");
    return;
  }
  guide.latestApplied = capturedAt;
  guide.history.push({ status: r.status, feedback: r.feedback, at: capturedAt });
  guide.votes.push(verify ? r.status + "!" : r.status); // "!" marks the stronger model's verdict
  handleCheck(r, verify);
}

const recent = (n) => guide.votes.slice(-n).map((v) => v.replace("!", ""));
const count = (arr, s) => arr.filter((v) => v === s).length;

// Voice is the only channel when the phone is on your chest: every spoken
// line has to be right, short and on time.
function handleCheck(r, verified) {
  const t = performance.now();
  const last2 = recent(2), last3 = recent(3);

  if (r.status === "done") {
    setFeedback(r.feedback || "Looks right", "done");
    if (verified || count(last3, "done") >= 2) return completeStep();
    return;
  }

  if (r.status === "mistake") {
    setFeedback(r.feedback, "mistake");
    const confirmed = verified || count(last3, "mistake") >= 2;
    if (!confirmed) return;
    const fresh = !guide.mistakeActive && t - guide.mistakeSpokenAt > 6000;
    const reminder = guide.mistakeActive && t - guide.mistakeSpokenAt > 20000;
    if (fresh || reminder) {
      chime("mistake");
      speak(r.feedback, reminder);
      guide.mistakeSpokenAt = t;
      guide.mistakeOnStep = true;
      logEvent("mistake_spoken", { feedback: r.feedback, verified });
    }
    guide.mistakeActive = true;
    return;
  }

  if (r.status === "working") {
    setFeedback("", "");
    if (count(last2, "working") === 2) guide.mistakeActive = false; // they fixed it
    return;
  }

  if (r.status === "unsure") {
    setFeedback(r.feedback, "unsure");
    // The fast model can't tell (small detail, partly covered): ask the stronger one once.
    if (!verified && !guide.verifying && count(last3, "unsure") >= 2 && t - guide.verifiedAt > 6000) {
      guide.verifying = true;
      guide.verifiedAt = t;
      checkOnce(true);
    } else if (count(last3, "unsure") === 3 && t - guide.nudgeAt > 15000) {
      speak(r.feedback, true);
      guide.nudgeAt = t;
    }
    return;
  }

  if (r.status === "unclear") {
    const fb = r.feedback || "Point the camera at your hands.";
    setFeedback(fb, "unclear");
    if (count(last3, "unclear") >= 2 && t - guide.nudgeAt > 15000) {
      speak(fb, true);
      guide.nudgeAt = t;
    }
  }
}

const PRAISE = ["Nice.", "Great.", "Perfect.", "Good job."];

function completeStep() {
  logEvent("step_done", { corrected: guide.mistakeOnStep });
  chime("done");
  clearSpeech(true); // cut off any outdated warning
  const praise = PRAISE[guide.step % PRAISE.length];
  if (guide.step >= guide.proc.steps.length - 1) {
    speak(praise);
    speak("That was the last step. You're all done.");
    finishGuide();
  } else {
    enterStep(guide.step + 1, false, praise);
  }
}

// Short tones, generated locally: instant feedback while the voice catches up.
function chime(kind) {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    const notes = kind === "done" ? [880, 1320] : [330, 262];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = "sine";
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.2);
    });
  } catch {}
}

$("g-next").onclick = () => {
  if (!guide.running) return;
  logEvent("skip");
  if (guide.step >= guide.proc.steps.length - 1) finishGuide();
  else enterStep(guide.step + 1);
};
$("g-prev").onclick = () => guide.running && (logEvent("back"), enterStep(guide.step - 1));
$("g-repeat").onclick = () => {
  if (!guide.running) return;
  const s = guide.proc.steps[guide.step];
  speak(`${s.instruction} ${s.tip || ""}`);
};
$("g-stop").onclick = () => endGuide(false);
$("g-again").onclick = () => { $("g-finish").hidden = true; $("g-pick").hidden = false; renderGuideList(); };
$("g-see-data").onclick = () => show("data");

// ---------- voice in ----------
// The phone sits on your chest, so you talk to it: "Coach, which way does this go?",
// "Coach, next", "Coach, repeat", "Coach, go back". The wake word keeps room chatter out.
// The Hold to ask button still works when the phone is in your hand.

async function sendUtterance(blob, handsFree) {
  const fd = new FormData();
  fd.append("audio", blob, `q.${extFor(blob.type)}`);
  fd.append("procedure_id", guide.proc.id);
  fd.append("step_index", guide.step);
  fd.append("hands_free", handsFree ? "1" : "0");
  const frame = await captureWork($("g-video"));
  if (frame) fd.append("image", frame, "f.jpg");
  const r = await api("/api/ask", { method: "POST", body: fd });
  if (r.ignored) return;
  $("g-heard").textContent = r.question ? `You said: "${r.question}"` : "";
  if (r.command) {
    logEvent("voice_command", { question: r.question, command: r.command });
    if (r.command === "next") $("g-next").onclick();
    else if (r.command === "back") $("g-prev").onclick();
    else if (r.command === "repeat") $("g-repeat").onclick();
    else if (r.command === "check") guide.lastCaptureAt = 0;
    return;
  }
  logEvent("ask", { question: r.question, answer: r.answer, hands_free: handsFree });
  clearSpeech(true);
  await speak(r.answer);
}

// Hands-free listener: simple voice activity detection on the mic level.
const ear = { stream: null, analyser: null, timer: null, mr: null, chunks: [], recStart: 0, loudSince: 0, quietSince: 0, busy: false, floor: 0.01 };
let audioCtx = null;

async function startListening() {
  try {
    ear.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    toast("Allow the microphone to talk to the coach");
    return;
  }
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  ear.analyser = audioCtx.createAnalyser();
  ear.analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(ear.stream).connect(ear.analyser);
  const buf = new Float32Array(ear.analyser.fftSize);
  ear.timer = setInterval(() => {
    ear.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    if (!ear.mr) ear.floor = ear.floor * 0.98 + rms * 0.02; // adapt to room noise
    const loud = rms > Math.max(0.02, ear.floor * 3);
    const t = performance.now();
    if (!ear.mr) {
      if (speaking || ear.busy || !guide.running) return; // never record the coach itself
      if (loud) startUtterance();
    } else {
      if (loud) ear.quietSince = 0;
      else ear.quietSince ||= t;
      if ((ear.quietSince && t - ear.quietSince > 900) || t - ear.recStart > 8000) stopUtterance();
    }
  }, 50);
}

function startUtterance() {
  const mime = audioMime();
  ear.chunks = [];
  ear.mr = new MediaRecorder(ear.stream, mime ? { mimeType: mime } : undefined);
  ear.mr.ondataavailable = (e) => e.data.size && ear.chunks.push(e.data);
  ear.mr.start();
  ear.recStart = performance.now();
  ear.quietSince = 0;
  $("g-heard").textContent = "Listening…";
}

async function stopUtterance() {
  const mr = ear.mr;
  ear.mr = null;
  const length = performance.now() - ear.recStart;
  await new Promise((res) => { mr.onstop = res; mr.stop(); });
  if (length < 1200 || !guide.running) { // too short to be "Coach, ..." plus a request
    $("g-heard").textContent = "";
    return;
  }
  ear.busy = true;
  try {
    await sendUtterance(new Blob(ear.chunks, { type: mr.mimeType || "audio/webm" }), true);
  } catch (e) {
    console.warn("voice failed", e);
  }
  if ($("g-heard").textContent === "Listening…") $("g-heard").textContent = "";
  ear.busy = false;
}

function stopListening() {
  clearInterval(ear.timer);
  if (ear.mr && ear.mr.state !== "inactive") ear.mr.stop();
  ear.mr = null;
  stopStream(ear.stream);
  ear.stream = null;
}

// Hold to ask (phone in hand).
const ask = { mr: null, chunks: [] };
const askBtn = $("g-ask");
askBtn.addEventListener("pointerdown", startAsk);
askBtn.addEventListener("pointerup", stopAsk);
askBtn.addEventListener("pointerleave", stopAsk);
askBtn.addEventListener("contextmenu", (e) => e.preventDefault());

function startAsk(e) {
  e.preventDefault();
  if (!guide.running || ask.mr || !ear.stream) return;
  if (ear.mr) { ear.mr.stop(); ear.mr = null; }
  ear.busy = true;
  guide.paused = true;
  clearSpeech(true);
  const mime = audioMime();
  ask.chunks = [];
  ask.mr = new MediaRecorder(ear.stream, mime ? { mimeType: mime } : undefined);
  ask.mr.ondataavailable = (ev) => ev.data.size && ask.chunks.push(ev.data);
  ask.mr.start();
  askBtn.classList.add("on");
  askBtn.textContent = "Listening…";
}

async function stopAsk() {
  if (!ask.mr) return;
  const mr = ask.mr;
  ask.mr = null;
  askBtn.classList.remove("on");
  askBtn.textContent = "Thinking…";
  await new Promise((res) => { mr.onstop = res; mr.stop(); });
  try {
    await sendUtterance(new Blob(ask.chunks, { type: mr.mimeType || "audio/webm" }), false);
  } catch (e) {
    toast(e.message);
  }
  askBtn.textContent = "Hold to ask";
  guide.paused = false;
  ear.busy = false;
}

// Keep the screen on: nobody touches a chest mounted phone.
async function keepAwake() {
  try { guide.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (guide.running && document.visibilityState === "visible") keepAwake();
});

async function saveSession() {
  if (!guide.session) return;
  guide.session.ended = Date.now() / 1000;
  try {
    await api(`/api/sessions/${guide.session.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(guide.session) });
  } catch (e) {
    console.warn("save failed", e);
  }
}

function finishGuide() {
  guide.session.completed = true;
  logEvent("complete");
  $("g-bar").style.width = "100%";
  const s = guide.session;
  const mistakes = s.events.filter((e) => e.type === "check" && e.status === "mistake").length;
  $("g-finish-text").textContent = `${guide.proc.steps.length} steps in ${fmtTime(now())}. ${mistakes} mistake${mistakes === 1 ? "" : "s"} caught. ${s.hands.length} hand samples and ${s.frames.length} labelled frames saved for robot training.`;
  setTimeout(() => endGuide(true), 1500);
}

async function endGuide(completed) {
  guide.running = false;
  clearTimeout(guide.loop);
  clearInterval(guide.saveTimer);
  guide.stopHands?.();
  guide.stopHands = null;
  stopListening();
  clearSpeech();
  guide.wakeLock?.release?.().catch(() => {});
  guide.wakeLock = null;
  stopStream(guide.stream);
  guide.stream = null;
  await saveSession();
  $("g-live").hidden = true;
  if (completed) $("g-finish").hidden = false;
  else { $("g-pick").hidden = false; renderGuideList(); }
}

// ======================================================================
// DATA (robot learning dataset)
// ======================================================================

async function renderData() {
  const list = await api("/api/sessions");
  const tot = list.reduce((a, s) => ({
    eps: a.eps + 1,
    secs: a.secs + (s.duration || 0),
    hands: a.hands + s.hand_samples,
    frames: a.frames + s.frames,
    fixes: a.fixes + s.mistakes,
  }), { eps: 0, secs: 0, hands: 0, frames: 0, fixes: 0 });
  $("d-totals").innerHTML = [
    ["Episodes", tot.eps], ["Recorded time", fmtTime(tot.secs)], ["Hand samples", tot.hands.toLocaleString()],
    ["Labelled frames", tot.frames.toLocaleString()], ["Mistakes caught", tot.fixes],
  ].map(([l, v]) => `<div class="metric"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
  $("d-list").innerHTML = list.length ? list.map((s) => `
    <button class="item" data-id="${s.id}">
      <span><strong>${esc(s.procedure_title || "Untitled")}</strong>
      <span class="tag ${s.role === "expert" ? "ok" : "warn"}">${s.role === "expert" ? "expert demo" : "guided attempt"}</span><br>
      <span class="muted small">${new Date((s.started || 0) * 1000).toLocaleTimeString()} · ${fmtTime(s.duration || 0)} · ${s.mistakes} mistakes · ${s.hand_samples} hand samples</span></span>
      <span class="muted">›</span>
    </button>`).join("") : `<p class="muted small">No episodes yet.</p>`;
  $("d-list").querySelectorAll(".item").forEach((b) => (b.onclick = () => {
    $("d-list").querySelectorAll(".item").forEach((x) => x.classList.toggle("sel", x === b));
    renderEpisode(b.dataset.id);
  }));
  if (list[0] && $("d-detail").hidden) {
    $("d-list").querySelector(".item")?.classList.add("sel");
    renderEpisode(list[0].id);
  }
}

async function renderEpisode(sid) {
  const s = await api(`/api/sessions/${sid}`);
  let proc = null;
  try { proc = s.procedure_id ? await api(`/api/procedures/${s.procedure_id}`) : null; } catch {}
  const sum = s.summary;
  $("d-detail").hidden = false;
  $("d-title").textContent = `${s.procedure_title || "Episode"} (${s.role === "expert" ? "expert demo" : "guided attempt"})`;
  $("d-export").href = `/api/sessions/${sid}/export`;
  $("d-metrics").innerHTML = [
    ["Duration", fmtTime(sum.duration || 0)], ["Hand samples", sum.hand_samples], ["Labelled frames", sum.frames],
    ["Mistakes caught", sum.mistakes], ["Questions", sum.questions],
  ].map(([l, v]) => `<div class="metric"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");

  // Step timeline from step_start events.
  const starts = s.events.filter((e) => e.type === "step_start");
  const end = Math.max(sum.duration || 0, ...s.events.map((e) => e.t || 0), 1);
  const segs = starts.map((e, i) => {
    const t1 = i + 1 < starts.length ? starts[i + 1].t : end;
    const bad = s.events.some((x) => x.type === "check" && x.status === "mistake" && x.t >= e.t && x.t <= t1);
    return { step: e.step, dur: Math.max(0.5, t1 - e.t), bad };
  });
  $("d-timeline").innerHTML = segs.map((g) => `<div class="${g.bad ? "warn" : "ok"}" style="flex:${g.dur}" title="Step ${g.step + 1}">${g.step + 1}</div>`).join("") || `<span class="muted small">No steps logged.</span>`;

  drawTrajectories($("d-traj"), s.hands, proc?.steps?.length || segs.length || 1, s.role === "expert" ? segs.map((g, i) => starts[i].t) : null);

  const frames = s.frames || [];
  $("d-frames").innerHTML = frames.slice(-36).map((f) => `
    <figure>
      <img loading="lazy" src="/api/sessions/${sid}/frame/${f.file}" alt="">
      <figcaption>${f.step != null ? `step ${f.step + 1}` : ""} ${f.status ? `<span class="tag ${f.status}">${f.status}</span>` : ""}</figcaption>
    </figure>`).join("") || `<span class="muted small">No frames.</span>`;

  $("d-events").innerHTML = s.events.map((e) => {
    const txt = e.type === "check" ? `${e.status}${e.feedback ? ": " + e.feedback : ""}${e.latency ? ` (${e.latency}s)` : ""}`
      : e.type === "ask" ? `Q: ${e.question} A: ${e.answer}`
      : e.title || (e.corrected ? "after correction" : "");
    return `<div>${(e.t || 0).toFixed(1)}s  step ${(e.step ?? 0) + 1}  ${e.type}  ${esc(txt)}</div>`;
  }).join("") || "No events.";
}

function drawTrajectories(canvas, samples, nSteps, expertStarts) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const colors = ["#2f6fde", "#1d9e75", "#d85a30", "#7f77dd", "#d4537e", "#ba7517", "#378add", "#639922", "#e24b4a", "#5f5e5a"];
  const stepOf = (smp) => {
    if (smp.step != null) return smp.step;
    if (!expertStarts) return 0;
    let k = 0;
    expertStarts.forEach((t, i) => { if (smp.t >= t) k = i; });
    return k;
  };
  if (!samples?.length) {
    ctx.fillStyle = "#888";
    ctx.font = "14px sans-serif";
    ctx.fillText("No hand samples in this episode", 20, 30);
    return;
  }
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;
  const sides = {};
  for (const smp of samples) {
    for (const h of smp.hands) {
      const key = h.side || "hand";
      const [x, y] = h.lm[0];
      const p = [x * W, y * H, stepOf(smp)];
      const prev = sides[key];
      if (prev && prev[2] === p[2] && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < W * 0.2) {
        ctx.strokeStyle = colors[p[2] % colors.length];
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      }
      sides[key] = p;
    }
  }
  ctx.globalAlpha = 1;
  ctx.font = "12px sans-serif";
  for (let i = 0; i < Math.min(nSteps, colors.length); i++) {
    ctx.fillStyle = colors[i];
    ctx.fillRect(10 + i * 62, H - 20, 10, 10);
    ctx.fillStyle = "#888";
    ctx.fillText(`step ${i + 1}`, 24 + i * 62, H - 11);
  }
}

// ---------- boot ----------

window.__apprentice = { guide, rec }; // for debugging from the console

(async () => {
  try { STATUS = await api("/api/status"); } catch {}
  const m = $("mode");
  m.textContent = STATUS.mock ? "Demo mode (no API key)" : STATUS.tts ? "Live AI + voice" : "Live AI";
  m.className = `pill ${STATUS.mock ? "mock" : "live"}`;
  renderGuideList();
})();
