// Apprenta frontend. One hub (Start) and three modes: Record, Guide, Data.

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
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1.5;
    for (const [a, b] of HAND_LINKS) {
      const [x1, y1] = P(h.lm[a]), [x2, y2] = P(h.lm[b]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (const p of h.lm) {
      const [x, y] = P(p);
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// ---------- navigation: one hub, every mode closes back to Start ----------

const SCREENS = ["start", "r-details", "r-capture", "r-processing", "r-review", "r-saved", "g-choose", "g-live", "g-done", "data"];
let current = "start";

function go(name) {
  for (const s of SCREENS) $(`scr-${s}`).hidden = s !== name;
  current = name;
  contours.active = name === "start";
  if (name === "start") { contours.start(); refreshTotals(); }
}

function closeToStart() {
  if (guide.running) endGuide(false, true);
  stopRecCamera();
  go("start");
}
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeToStart));

// ---------- start screen ----------

let PROCS = [], SESSIONS = [];

async function refreshTotals() {
  try {
    [PROCS, SESSIONS] = await Promise.all([api("/api/procedures"), api("/api/sessions")]);
    const demos = SESSIONS.filter((s) => s.role === "expert").length;
    $("totals").textContent = `${demos} demo${demos === 1 ? "" : "s"} · ${PROCS.length} task${PROCS.length === 1 ? "" : "s"} · ${SESSIONS.length} episode${SESSIONS.length === 1 ? "" : "s"}`;
    $("go-guide").disabled = PROCS.length === 0;
    $("guide-hint").hidden = PROCS.length > 0;
    for (const id of ["go-record", "go-data"]) $(id).disabled = false;
  } catch {
    $("totals").textContent = "Offline";
    for (const id of ["go-record", "go-guide", "go-data"]) $(id).disabled = true;
    $("guide-hint").hidden = false;
    $("guide-hint").textContent = "Can't reach Apprenta";
  }
}

$("go-record").onclick = () => openDetails();
$("go-guide").onclick = () => openChoose();
$("go-data").onclick = () => openData();
$("logo").onclick = (e) => contours.ripple(e.clientX, e.clientY);

// Dynamic background: slow contour lines that bend towards your touch.
const contours = (() => {
  const cv = $("contours"), ctx = cv.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };
  const ripples = [];
  let raf = 0, t0 = performance.now();
  const api = { active: true };
  function size() {
    cv.width = innerWidth * devicePixelRatio;
    cv.height = innerHeight * devicePixelRatio;
  }
  function frame() {
    raf = 0;
    if (!api.active) return;
    const W = innerWidth, H = innerHeight, t = (performance.now() - t0) / 1000;
    const w = (Math.PI * 2) / 25; // one cycle every ~25 s
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    const N = 16;
    for (let i = 0; i < N; i++) {
      const y0 = (H * (i + 0.5)) / N;
      ctx.beginPath();
      for (let x = -10; x <= W + 10; x += 10) {
        let y = y0 + 18 * Math.sin(x * 0.006 + t * w + i * 0.7) + 9 * Math.sin(x * 0.013 - t * w * 1.3 + i * 1.9);
        const dx = x - pointer.x, dy = y - pointer.y, d2 = dx * dx + dy * dy;
        y -= dy * 0.35 * Math.exp(-d2 / 14000); // bend towards the touch
        for (const r of ripples) {
          const d = Math.hypot(x - r.x, y - r.y), age = t - r.t, front = age * 220;
          y += 10 * Math.exp(-((d - front) ** 2) / 900) * Math.max(0, 1 - age / 2.5) * Math.sin(d * 0.05);
        }
        x === -10 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let k = ripples.length - 1; k >= 0; k--) if (t - ripples[k].t > 2.5) ripples.splice(k, 1);
    if (!reduce) raf = requestAnimationFrame(frame);
  }
  api.start = () => { size(); if (!raf) raf = requestAnimationFrame(frame); };
  api.ripple = (x, y) => { ripples.push({ x, y, t: (performance.now() - t0) / 1000 }); api.start(); };
  addEventListener("resize", () => api.active && api.start());
  addEventListener("pointermove", (e) => { pointer.tx = e.clientX; pointer.ty = e.clientY; });
  addEventListener("pointerdown", (e) => { pointer.tx = e.clientX; pointer.ty = e.clientY; });
  return api;
})();

// ======================================================================
// RECORD (expert demo): details, capture, processing, review
// ======================================================================

const rec = { stream: null, recording: false, frames: [], times: [], hands: [], audioChunks: [], mr: null, t0: 0, timer: null, stopHands: null, proc: null, q: 0 };

function openDetails() {
  rec.q = 0;
  showQuestion();
  $("r-chips").innerHTML = [...new Map(PROCS.map((p) => [p.title, p])).values()].slice(0, 6)
    .map((p) => `<button class="chip" data-t="${esc(p.title)}" data-h="${esc(p.hardware || "")}">${esc(p.title)}</button>`).join("");
  $("r-chips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => {
    $("r-title").value = c.dataset.t;
    if (c.dataset.h) $("r-hw").value = c.dataset.h;
    $("r-chips").querySelectorAll(".chip").forEach((x) => x.classList.toggle("sel", x === c));
  }));
  go("r-details");
  setTimeout(() => $("r-title").focus(), 250);
}

function showQuestion() {
  document.querySelectorAll("#scr-r-details .q").forEach((el) => (el.hidden = +el.dataset.q !== rec.q));
  document.querySelectorAll("#r-dots i").forEach((d, i) => d.classList.toggle("on", i <= Math.min(rec.q, 2)));
  $("r-next").textContent = rec.q === 3 ? "Start recording" : "Next";
  $("r-upload-btn").hidden = rec.q !== 3;
  if (rec.q === 3) {
    const rows = [["Task", $("r-title").value.trim() || "Untitled task"], ["Hardware", $("r-hw").value.trim() || "Not given"],
      ["Demonstrator", $("r-who").value.trim() || "Not given"], ["Narration", $("r-audio").checked ? "On" : "Off"]];
    $("r-summary").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${esc(v)}</span></div>`).join("");
  }
}

$("r-next").onclick = () => {
  if (rec.q === 0 && !$("r-title").value.trim()) { $("r-title").focus(); toast("Name the task first"); return; }
  if (rec.q < 3) { rec.q++; showQuestion(); return; }
  openCapture();
};
for (const id of ["r-title", "r-hw", "r-who"]) $(id).addEventListener("keydown", (e) => e.key === "Enter" && $("r-next").onclick());
$("r-upload-btn").onclick = () => $("r-file").click();

async function openCapture() {
  go("r-capture");
  $("rec-timer").textContent = "00:00";
  $("rec-go").classList.remove("on");
  const p = $("rec-prompt"); p.style.animation = "none"; p.offsetHeight; p.style.animation = "";
  if (rec.stream) return;
  try {
    rec.stream = await openCamera($("rec-video"), $("r-audio").checked);
    loadHands().then(() => {
      if (!rec.stream) return;
      rec.stopHands = startHandLoop($("rec-video"), $("rec-overlay"), (hands) => {
        if (rec.recording) rec.hands.push({ t: +((performance.now() - rec.t0) / 1000).toFixed(2), hands });
      });
    });
  } catch (e) {
    toast(e.message || "Couldn't open the camera", 5000);
  }
}

function stopRecCamera() {
  clearInterval(rec.timer);
  rec.recording = false;
  rec.stopHands?.();
  rec.stopHands = null;
  stopStream(rec.stream);
  rec.stream = null;
}

$("rec-go").onclick = () => (rec.recording ? stopRecording() : startRecording());

function startRecording() {
  if (!rec.stream) return;
  Object.assign(rec, { frames: [], times: [], hands: [], audioChunks: [], recording: true, t0: performance.now(), mr: null });
  const mime = audioMime();
  const audioTracks = rec.stream.getAudioTracks();
  if (audioTracks.length && window.MediaRecorder) {
    rec.mr = new MediaRecorder(new MediaStream(audioTracks), mime ? { mimeType: mime } : undefined);
    rec.mr.ondataavailable = (e) => e.data.size && rec.audioChunks.push(e.data);
    rec.mr.start(1000);
  }
  $("rec-go").classList.add("on");
  rec.timer = setInterval(async () => {
    const t = (performance.now() - rec.t0) / 1000;
    $("rec-timer").textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const blob = await captureJpeg($("rec-video"));
    if (blob && rec.recording) { rec.frames.push(blob); rec.times.push(+t.toFixed(2)); }
  }, FRAME_EVERY_MS);
}

async function stopRecording() {
  rec.recording = false;
  clearInterval(rec.timer);
  $("rec-go").classList.remove("on");
  let audioBlob = null;
  if (rec.mr && rec.mr.state !== "inactive") {
    await new Promise((res) => { rec.mr.onstop = res; rec.mr.stop(); });
    audioBlob = new Blob(rec.audioChunks, { type: rec.mr.mimeType || "audio/webm" });
  }
  if (rec.frames.length < 2) { toast("Record for a few more seconds"); return; }
  const fd = new FormData();
  rec.frames.forEach((b, i) => fd.append("frames", b, `${i}.jpg`));
  fd.append("frame_times", JSON.stringify(rec.times));
  fd.append("hands", JSON.stringify(rec.hands));
  if (audioBlob) fd.append("audio", audioBlob, `audio.${extFor(audioBlob.type)}`);
  const thumb = URL.createObjectURL(rec.frames[Math.floor(rec.frames.length / 2)]);
  stopRecCamera();
  runBuild("/api/procedures/build", fd, thumb);
}

$("r-file").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("video", file);
  e.target.value = "";
  runBuild("/api/procedures/build_from_video", fd, "");
};

// Processing: the backend working, shown as calm stages.
async function runBuild(url, fd, thumb) {
  fd.append("title", $("r-title").value.trim());
  fd.append("hardware", $("r-hw").value.trim());
  fd.append("demonstrator", $("r-who").value.trim());
  go("r-processing");
  $("p-thumb").src = thumb || "";
  $("p-thumb").hidden = !thumb;
  $("p-error").hidden = true;
  const items = [...document.querySelectorAll("#p-stages li")];
  items.forEach((li) => (li.className = ""));
  const at = [0, 2500, 6000, 11000, 16000];
  let k = -1;
  const advance = (i) => {
    items.forEach((li, j) => { li.classList.toggle("shown", j <= i); li.classList.toggle("active", j === i); li.classList.toggle("done", j < i); });
    k = i;
  };
  const timers = at.map((ms, i) => setTimeout(() => advance(i), ms));
  try {
    const proc = await api(url, { method: "POST", body: fd });
    timers.forEach(clearTimeout);
    for (let i = Math.max(k, 0); i <= items.length; i++) { advance(i); await new Promise((r) => setTimeout(r, 180)); }
    await new Promise((r) => setTimeout(r, 300));
    showReview(proc);
  } catch (e) {
    timers.forEach(clearTimeout);
    if (k < 0) advance(0);
    items[k].className = "shown failed";
    $("p-error").hidden = false;
    $("p-error").innerHTML = `${esc(e.message)} <button class="btn text" id="p-retry">Try again</button>`;
    $("p-retry").onclick = () => openCapture();
  }
}

function showReview(proc) {
  rec.proc = proc;
  $("rv-title").textContent = proc.title || "Untitled";
  $("rv-hw").textContent = proc.hardware || proc.summary || "";
  $("rv-steps").innerHTML = proc.steps.map((s, i) => `
    <div class="row" data-i="${i}">
      <img class="thumb64" src="/api/procedures/${proc.id}/frame/${s.ref_frame}" alt="">
      <div class="step-edit">
        <div class="n">Step ${i + 1}${s.t_end > s.t_start ? ` · ${Math.round(s.t_end - s.t_start)} s` : ""}</div>
        <div class="t" contenteditable="true" spellcheck="false">${esc(s.instruction)}</div>
      </div>
    </div>`).join("");
  go("r-review");
}

$("rv-save").onclick = async () => {
  const p = rec.proc;
  document.querySelectorAll("#rv-steps .row").forEach((el) => {
    p.steps[+el.dataset.i].instruction = el.querySelector("[contenteditable]").textContent.trim();
  });
  $("rv-save").classList.add("loading");
  try {
    rec.proc = await api(`/api/procedures/${p.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: p.steps }) });
    $("sv-sub").textContent = `${rec.proc.steps.length} steps · ${rec.proc.title}`;
    go("r-saved");
  } catch (e) { toast(e.message); }
  $("rv-save").classList.remove("loading");
};
$("rv-redo").onclick = () => openCapture();
$("sv-try").onclick = () => startGuide(rec.proc.id);

// ======================================================================
// GUIDE (live coaching)
// ======================================================================

const guide = {
  running: false, proc: null, step: 0, stream: null, session: null, t0: 0,
  inflight: false, loop: null, stopHands: null, saveTimer: null, wakeLock: null,
  stepStartedAt: 0, lastCaptureAt: 0, latestApplied: 0, inflightN: 0, prevBlob: null,
  history: [], votes: [], verifying: false, verifiedAt: 0,
  mistakeOnStep: false, mistakeActive: false, mistakeSpokenAt: 0, nudgeAt: 0, paused: false,
  boxState: "searching", boxHold: 0,
};

async function openChoose() {
  go("g-choose");
  const list = await api("/api/procedures");
  $("g-list").innerHTML = list.map((p) => `
    <button class="row" data-id="${p.id}">
      <div class="grow"><div class="t">${esc(p.title)}</div><div class="s">${esc(p.hardware || "")}</div></div>
      <div class="meta">${p.steps} steps<br>${p.episodes} episodes</div>
    </button>`).join("") || `<p class="body">No guides yet. Record a demo first.</p>`;
  $("g-list").querySelectorAll(".row").forEach((b) => (b.onclick = () => startGuide(b.dataset.id)));
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
    id: "s" + Date.now().toString(36), role: "novice", procedure_id: proc.id, procedure_title: proc.title,
    started: Date.now() / 1000, events: [], hands: [], frames: [], completed: false,
  };
  $("g-segs").innerHTML = proc.steps.map(() => "<i></i>").join("");
  go("g-live");
  try {
    guide.stream = await openCamera($("g-video"), false);
  } catch (e) {
    toast(e.message || "Couldn't open the camera", 6000);
    endGuide(false, true);
    go("start");
    return;
  }
  loadHands().then(() => {
    if (!guide.running) return;
    guide.stopHands = startHandLoop($("g-video"), $("g-overlay"), (hands) => {
      updateMotion(hands);
      placeBox();
      if (hands.length) guide.session.hands.push({ t: now(), step: guide.step, hands });
    });
  });
  guide.saveTimer = setInterval(saveSession, 8000);
  startListening();
  ttsUrl(introLine()); ttsUrl(stepLine(0)); // first lines go out first
  prefetchSpeech([...proc.steps.map((_, i) => stepLine(i)), ...PRAISE, "That was the last step. You're all done."]);
  enterStep(0, true);
  placeBox();
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
  $("g-stepno").textContent = `STEP ${guide.step + 1} / ${steps.length}`;
  $("g-segs").querySelectorAll("i").forEach((el, k) => el.classList.toggle("on", k <= guide.step));
  $("g-ref").hidden = !Number.isInteger(s.ref_frame);
  $("g-ref").src = `/api/procedures/${guide.proc.id}/frame/${s.ref_frame}`;
  // After a completed step the box shows its tick briefly, then the next box draws in.
  const redraw = () => {
    $("g-box-label").textContent = s.title;
    const box = $("g-box");
    box.style.animation = "none"; box.offsetHeight; box.style.animation = "";
    setBoxState("searching");
  };
  if (praise) setTimeout(redraw, 500); else redraw();
  setInstruction(s.instruction, false);
  $("g-hint").textContent = `Say "Coach, …" to ask · swipe to skip`;
  logEvent("step_start", { title: s.title });
  clearSpeech(); // anything still queued is about the previous step
  if (intro) speak(introLine());
  else if (praise) speak(praise);
  speak(stepLine(guide.step));
}

function setInstruction(text, correction) {
  $("g-instr").textContent = text;
  $("g-ibar").classList.toggle("correction", !!correction);
}

function setBoxState(state) {
  guide.boxState = state;
  $("g-box").className = `obox ${state}`;
  $("g-box").hidden = false;
}

// Called by the check pipeline: captions always mirror what the coach says.
function setFeedback(text, status) {
  const instr = guide.proc?.steps[guide.step]?.instruction || "";
  if (status === "done") { setBoxState("complete"); setInstruction(text || instr, false); return; }
  if (status === "mistake") {
    if (guide.boxState !== "mistake") { setBoxState("mistake"); navigator.vibrate?.([60, 60, 60]); }
    setInstruction(text, true);
    return;
  }
  if (status === "unclear") { setBoxState("searching"); $("g-hint").textContent = text || "Hold steady"; return; }
  if (status === "unsure") { $("g-hint").textContent = "Not sure yet · swipe left when it's done"; return; }
  if (status === "error") { $("g-hint").textContent = "Can't reach Apprenta · still watching"; return; }
  // working
  setInstruction(instr, false);
  setBoxState(motionState().present ? "active" : "searching");
  $("g-hint").textContent = `Say "Coach, …" to ask · swipe to skip`;
}

// The box follows the work area (where the hands have been), mapped onto the cover-fit video.
function placeBox() {
  const v = $("g-video"), box = $("g-box");
  const W = innerWidth, H = innerHeight, vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return;
  const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  let b = workBox();
  let x0, y0, x1, y1;
  if (b) {
    const pad = 0.06;
    [x0, y0, x1, y1] = [ox + (b[0] - pad) * vw * s, oy + (b[1] - pad * 2) * vh * s, ox + (b[2] + pad) * vw * s, oy + (b[3] + pad) * vh * s];
  } else {
    [x0, y0, x1, y1] = [W * 0.18, H * 0.3, W * 0.82, H * 0.62];
  }
  x0 = Math.max(16, x0); y0 = Math.max(110, y0); x1 = Math.min(W - 16, x1); y1 = Math.min(H - 190, y1);
  if (x1 - x0 < 80 || y1 - y0 < 80) return;
  Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  if (guide.boxState === "searching" && motionState().present && !guide.mistakeActive) setBoxState("active");
  if (guide.boxState === "active" && !motionState().present) setBoxState("searching");
}

function goNext() {
  if (!guide.running) return;
  logEvent("skip");
  if (guide.step >= guide.proc.steps.length - 1) finishGuide();
  else enterStep(guide.step + 1);
}
function goBack() { if (guide.running) { logEvent("back"); enterStep(guide.step - 1); } }
function repeatStep() {
  if (!guide.running) return;
  const s = guide.proc.steps[guide.step];
  speak(`${s.instruction} ${s.tip || ""}`);
}
$("g-stop").onclick = () => closeToStart();

// Swipe left to advance, right to go back: for when automatic checks lag.
(() => {
  let sx = 0, sy = 0, st = 0;
  const el = $("scr-g-live");
  el.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; st = performance.now(); });
  el.addEventListener("pointerup", (e) => {
    if (e.target.closest("button, .kthumb")) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - st < 800) dx < 0 ? goNext() : goBack();
  });
})();

// Tap the keyframe to see the expert frame full screen for 3 s.
$("g-ref").onclick = () => {
  $("g-expert-img").src = $("g-ref").src;
  $("g-expert").hidden = false;
  clearTimeout(guide.expertT);
  guide.expertT = setTimeout(() => ($("g-expert").hidden = true), 3000);
};
$("g-expert").onclick = () => ($("g-expert").hidden = true);

function finishGuide() {
  guide.session.completed = true;
  logEvent("complete");
  setBoxState("complete");
  const s = guide.session;
  const mistakes = s.events.filter((e) => e.type === "mistake_spoken").length;
  $("gd-time").textContent = `${guide.proc.title} · ${fmtTime(now())}`;
  $("gd-text").textContent = `${guide.proc.steps.length} steps · ${mistakes} mistake${mistakes === 1 ? "" : "s"} caught · ${s.hands.length} hand samples · ${s.frames.length} labelled frames`;
  guide.lastSessionId = s.id;
  setTimeout(() => endGuide(true), 1200);
}

async function endGuide(completed, silent = false) {
  if (!guide.running) return;
  guide.running = false;
  clearTimeout(guide.loop);
  clearInterval(guide.saveTimer);
  guide.stopHands?.();
  guide.stopHands = null;
  stopListening();
  if (!completed) clearSpeech(true);
  guide.wakeLock?.release?.().catch(() => {});
  guide.wakeLock = null;
  stopStream(guide.stream);
  guide.stream = null;
  $("g-box").hidden = true;
  await saveSession();
  if (completed) go("g-done");
  else if (!silent) go("start");
}

$("gd-view").onclick = () => openData(guide.lastSessionId);

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
  const b = null; // full frame: cropping to the hands could cut the object out of view
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
    if (r.command === "next") goNext();
    else if (r.command === "back") goBack();
    else if (r.command === "repeat") repeatStep();
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

// ======================================================================
// DATA dashboard: every figure traces back to the episodes behind it
// ======================================================================

const dash = { filter: "all", sessions: [], procs: [], seenFigs: false };

async function openData(highlightSid) {
  go("data");
  $("d-overview").hidden = false; $("d-task").hidden = true; $("d-ep").hidden = true;
  [dash.sessions, dash.procs] = await Promise.all([api("/api/sessions"), api("/api/procedures")]);
  renderOverview();
  if (highlightSid) openEpisode(highlightSid, true);
}

document.querySelectorAll("#d-filter .chip").forEach((c) => (c.onclick = () => {
  dash.filter = c.dataset.f;
  document.querySelectorAll("#d-filter .chip").forEach((x) => x.classList.toggle("sel", x === c));
  renderOverview();
}));

function countUp(el, to) {
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 600);
    el.textContent = Math.round(to * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // Animation frames pause in background tabs: always land on the real number.
  setTimeout(() => (el.textContent = to.toLocaleString()), 700);
}

function renderOverview() {
  const all = dash.sessions;
  const list = all.filter((s) => dash.filter === "all" || s.role === dash.filter);
  $("d-empty").hidden = all.length > 0;
  const figs = [
    ["Episodes", list.length], ["Expert demos", list.filter((s) => s.role === "expert").length],
    ["Guided attempts", list.filter((s) => s.role !== "expert").length], ["Mistakes caught", list.reduce((a, s) => a + s.mistakes, 0)],
  ];
  $("d-figs").innerHTML = figs.map(([l]) => `<div class="fig"><div class="v">0</div><div class="l">${l}</div></div>`).join("");
  $("d-figs").querySelectorAll(".v").forEach((el, i) => countUp(el, figs[i][1]));

  const ordered = [...list].sort((a, b) => (a.started || 0) - (b.started || 0));
  $("d-strip").innerHTML = ordered.map((s) => `<button class="${s.role === "expert" ? "expert" : ""} ${s.mistakes ? "m" : ""}" data-id="${s.id}" title="${esc(s.procedure_title)}"></button>`).join("");
  $("d-strip").querySelectorAll("button").forEach((b) => (b.onclick = () => openEpisode(b.dataset.id)));

  $("d-tasks").innerHTML = dash.procs.map((p) => {
    const eps = all.filter((s) => s.procedure_id === p.id && s.role !== "expert").sort((a, b) => a.started - b.started);
    const pts = eps.map((s, i) => [eps.length > 1 ? (i / (eps.length - 1)) * 60 + 2 : 32, 18 - Math.min(16, s.mistakes * 4)]);
    const spark = pts.length ? `<svg class="spark" viewBox="0 0 64 20"><path d="M${pts.map((q) => q.join(" ")).join(" L")}"/></svg>` : `<svg class="spark"></svg>`;
    return `<button class="row" data-id="${p.id}">
      <div class="grow"><div class="t">${esc(p.title)}</div><div class="s">${esc(p.hardware || "")}</div></div>
      ${spark}<div class="meta">${p.steps} steps<br>${p.episodes} episodes</div></button>`;
  }).join("");
  $("d-tasks").querySelectorAll(".row").forEach((b) => (b.onclick = () => openTask(b.dataset.id)));
}

$("d-task-back").onclick = () => { $("d-task").hidden = true; $("d-overview").hidden = false; };
$("d-ep-back").onclick = () => { $("d-ep").hidden = true; (dash.fromTask ? $("d-task") : $("d-overview")).hidden = false; };
$("d-empty-rec").onclick = () => openDetails();

const stepMistakes = (s) => {
  const spoken = s.events.filter((e) => e.type === "mistake_spoken");
  const newFormat = spoken.length || s.events.some((e) => "outdated" in e);
  return newFormat ? spoken : s.events.filter((e) => e.type === "check" && e.status === "mistake");
};

function stepDurations(s, n) {
  const starts = s.events.filter((e) => e.type === "step_start");
  const end = s.summary?.duration || Math.max(0, ...s.events.map((e) => e.t || 0));
  const d = Array(n).fill(null);
  starts.forEach((e, i) => { if (e.step < n) d[e.step] = (i + 1 < starts.length ? starts[i + 1].t : end) - e.t; });
  return d;
}

async function openTask(pid) {
  dash.fromTask = true;
  $("d-overview").hidden = true; $("d-ep").hidden = true; $("d-task").hidden = false;
  const proc = await api(`/api/procedures/${pid}`);
  const n = proc.steps.length;
  const sums = dash.sessions.filter((s) => s.procedure_id === pid);
  const full = await Promise.all(sums.map((s) => api(`/api/sessions/${s.id}`)));
  $("dt-title").textContent = proc.title;
  $("dt-hw").textContent = proc.hardware || "";
  const expT = proc.steps.map((s) => (s.t_end > s.t_start ? s.t_end - s.t_start : null));
  const gui = full.filter((s) => s.role !== "expert");
  const guiT = proc.steps.map((_, i) => {
    const v = gui.map((s) => stepDurations(s, n)[i]).filter((x) => x != null && x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  const mist = proc.steps.map((_, i) => gui.reduce((a, s) => a + stepMistakes(s).filter((e) => e.step === i).length, 0));
  const maxT = Math.max(1, ...expT.filter(Boolean), ...guiT.filter(Boolean));
  const most = mist.some((m) => m > 0) ? mist.indexOf(Math.max(...mist)) : -1;
  $("dt-map").innerHTML = proc.steps.map((s, i) => `
    <button class="sm-step ${i === most ? "most" : ""}" data-i="${i}">
      <img src="/api/procedures/${pid}/frame/${s.ref_frame}" alt="">
      <div class="t">${i + 1}. ${esc(s.title)}</div>
      <div class="sm-bar exp" style="width:${expT[i] ? (expT[i] / maxT) * 100 : 0}%"></div>
      <div class="sm-bar gui" style="width:${guiT[i] ? (guiT[i] / maxT) * 100 : 0}%"></div>
      <div class="m">${mist[i]} mistake${mist[i] === 1 ? "" : "s"}</div>
    </button>`).join("");
  const renderEps = (stepFilter) => {
    const rows = full.filter((s) => stepFilter == null || stepMistakes(s).some((e) => e.step === stepFilter))
      .sort((a, b) => b.started - a.started);
    $("dt-eps").innerHTML = rows.map((s) => `
      <button class="row" data-id="${s.id}">
        <div class="grow"><div class="t">${s.role === "expert" ? "Expert" : "Guided"}</div>
        <div class="s">${new Date((s.started || 0) * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${fmtTime(s.summary.duration || 0)}</div></div>
        <div class="meta">${s.role === "expert" || s.completed ? "Completed" : "Stopped"}<br>${s.summary.mistakes} mistake${s.summary.mistakes === 1 ? "" : "s"}</div>
      </button>`).join("") || `<p class="body">No episodes at this step.</p>`;
    $("dt-eps").querySelectorAll(".row").forEach((b) => (b.onclick = () => openEpisode(b.dataset.id)));
  };
  $("dt-map").querySelectorAll(".sm-step").forEach((b) => (b.onclick = () => {
    const sel = !b.classList.contains("sel");
    $("dt-map").querySelectorAll(".sm-step").forEach((x) => x.classList.remove("sel"));
    b.classList.toggle("sel", sel);
    renderEps(sel ? +b.dataset.i : null);
  }));
  renderEps(null);
}

async function openEpisode(sid, highlight = false) {
  if (!highlight) dash.fromTask = !$("d-task").hidden;
  $("d-overview").hidden = true; $("d-task").hidden = true; $("d-ep").hidden = false;
  const s = await api(`/api/sessions/${sid}`);
  let proc = null;
  try { proc = s.procedure_id ? await api(`/api/procedures/${s.procedure_id}`) : null; } catch {}
  const sum = s.summary, dur = Math.max(1, sum.duration || 0);
  $("de-title").textContent = `${s.procedure_title || "Episode"}`;
  $("de-export").href = `/api/sessions/${sid}/export`;

  // Player: scrub through the labelled frames.
  const frames = s.frames || [];
  const scrub = $("de-scrub");
  scrub.max = Math.max(0, frames.length - 1);
  scrub.value = 0;
  const showFrame = () => { const f = frames[+scrub.value]; $("de-frame").src = f ? `/api/sessions/${sid}/frame/${f.file}` : ""; };
  scrub.oninput = showFrame;
  showFrame();
  const mistakes = stepMistakes(s);
  $("de-ticks").innerHTML = [
    ...s.events.filter((e) => e.type === "step_start").map((e) => `<i style="left:${(e.t / dur) * 100}%" title="Step ${e.step + 1}"></i>`),
    ...mistakes.map((e) => `<i class="m" style="left:${(e.t / dur) * 100}%" title="Mistake"></i>`),
  ].join("");

  const steps = s.events.filter((e) => e.type === "step_start").map((e) => `${e.step + 1} · ${fmtTime(e.t)}`).join(", ");
  const mRows = mistakes.map((e) => {
    const fixed = s.events.find((x) => x.type === "step_done" && x.step === e.step && x.t >= e.t);
    return `${fmtTime(e.t)} step ${e.step + 1}: ${e.feedback || "mistake"}${fixed ? ` (recovered in ${Math.round(fixed.t - e.t)} s)` : ""}`;
  });
  const others = s.role === "expert"
    ? dash.sessions.filter((x) => x.procedure_id === s.procedure_id && x.role !== "expert").length
    : null;
  const rows = [
    ["Episode ID", s.id], ["Type", s.role === "expert" ? "Expert demo" : "Guided attempt"], ["Task", s.procedure_title || ""],
    ["Hardware", proc?.hardware || "Not given"], ["Duration", fmtTime(sum.duration || 0)], ["Outcome", s.role === "expert" || s.completed ? "Completed" : "Stopped"],
    ["Steps", steps || "None logged"], ["Mistakes", mRows.length ? mRows.join("<br>") : "None"],
    ["Questions", s.events.filter((e) => e.type === "ask").map((e) => esc(e.question)).join("<br>") || "None"],
    ["Hand samples", (s.hands || []).length.toLocaleString()], ["Labelled frames", frames.length],
    ["Transcript", s.transcript?.text ? esc(s.transcript.text.slice(0, 400)) + (s.transcript.text.length > 400 ? "…" : "") : "None"],
    ["Lineage", s.role === "expert" ? `Used by ${others} guided episode${others === 1 ? "" : "s"}` : `<a href="#" id="de-lineage" class="btn text" style="padding:0;min-height:0">Expert demo ›</a>`],
  ];
  $("de-kv").innerHTML = rows.map(([k, v]) => `<div class="${highlight && k === "Mistakes" ? "hl" : ""}"><span>${k}</span><span>${k === "Mistakes" || k === "Questions" || k === "Lineage" || k === "Transcript" ? v : esc(v)}</span></div>`).join("");
  $("de-lineage")?.addEventListener("click", (e) => { e.preventDefault(); openEpisode(`expert-${s.procedure_id}`); });
  drawTrajectories($("de-traj"), s.hands || [], proc?.steps?.length || 1, s.events);
  $("de-frames").innerHTML = frames.map((f, i) => `
    <figure class="${f.status === "mistake" ? "m" : ""}" data-i="${i}">
      <img loading="lazy" src="/api/sessions/${sid}/frame/${f.file}" alt="">
      <figcaption>${f.step != null ? `Step ${f.step + 1}` : ""}${f.status ? ` · ${f.status}` : ""}</figcaption>
    </figure>`).join("") || `<p class="body">No frames.</p>`;
  $("de-frames").querySelectorAll("figure").forEach((el) => (el.onclick = () => { scrub.value = el.dataset.i; showFrame(); $("scr-data").scrollTo({ top: 0, behavior: "smooth" }); }));
  $("de-events").innerHTML = s.events.filter((e) => e.type !== "check" || e.status !== "working").map((e) => {
    const txt = e.type === "check" ? `${e.status}${e.verified ? " (verified)" : ""}${e.feedback ? ": " + e.feedback : ""}`
      : e.type === "ask" ? `Q: ${e.question} A: ${e.answer}` : e.type === "mistake_spoken" ? `said: ${e.feedback}` : e.title || e.command || "";
    return `<div>${fmtTime(e.t || 0)} · step ${(e.step ?? 0) + 1} · <b>${e.type.replace("_", " ")}</b> ${esc(txt)}</div>`;
  }).join("") || "No events.";
  const raw = { ...s, hands: `${(s.hands || []).length} samples (in the export)` };
  $("de-raw").textContent = JSON.stringify(raw, null, 2);
  $("de-raw").hidden = true;
  $("de-raw-btn").classList.remove("sel");
  $("de-raw-btn").onclick = () => { $("de-raw").hidden = !$("de-raw").hidden; $("de-raw-btn").classList.toggle("sel", !$("de-raw").hidden); };
  $("scr-data").scrollTop = 0;
}

// Wrist paths, one line per hand, brighter for later steps.
function drawTrajectories(canvas, samples, nSteps, events) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!samples.length) {
    ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "500 22px Inter, sans-serif";
    ctx.fillText("No hand samples in this episode", 24, 44);
    return;
  }
  const starts = (events || []).filter((e) => e.type === "step_start");
  const stepOf = (smp) => smp.step ?? starts.reduce((k, e) => (smp.t >= e.t ? e.step : k), 0);
  ctx.lineWidth = 2;
  const last = {};
  for (const smp of samples) for (const h of smp.hands) {
    const key = h.side || "hand", st = stepOf(smp);
    const p = [h.lm[0][0] * W, h.lm[0][1] * H, st];
    const q = last[key];
    if (q && q[2] === st && Math.hypot(p[0] - q[0], p[1] - q[1]) < W * 0.2) {
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.7 * (st / Math.max(1, nSteps - 1))})`;
      ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    last[key] = p;
  }
  ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "500 18px Inter, sans-serif";
  ctx.fillText(`${samples.length.toLocaleString()} samples · brighter = later steps`, 20, H - 18);
}

// ---------- boot ----------

window.__apprentice = { guide, rec };

(async () => {
  try { STATUS = await api("/api/status"); } catch {}
  go("start");
})();
