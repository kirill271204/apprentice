"""Apprentice server. Run: .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000"""

import io
import json
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import ai  # noqa: E402

ROOT = Path(__file__).parent
DATA = ROOT / "data"
PROCS = DATA / "procedures"
SESS = DATA / "sessions"
for d in (PROCS, SESS):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Apprentice")


@app.middleware("http")
async def no_cache(request, call_next):
    # Phones must always load the latest app code during the hack.
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------- helpers ----------

def _read(path: Path):
    return json.loads(path.read_text())


def _write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2))


def _proc_path(pid):
    return PROCS / pid / "procedure.json"


def _load_proc(pid):
    p = _proc_path(pid)
    if not p.exists():
        raise HTTPException(404, "Guide not found")
    return _read(p)


def _sess_path(sid):
    return SESS / sid / "session.json"


def _load_sess(sid):
    p = _sess_path(sid)
    return _read(p) if p.exists() else None


def _new_id():
    return time.strftime("%H%M%S") + "-" + uuid.uuid4().hex[:6]


async def _finish_build(frames_bytes, frame_times, audio_bytes, audio_name, title, hands, source, hardware="", demonstrator=""):
    pid = _new_id()
    fdir = PROCS / pid / "frames"
    fdir.mkdir(parents=True)
    for i, fb in enumerate(frames_bytes):
        (fdir / f"{i:04d}.jpg").write_bytes(fb)

    transcript = {"text": "", "segments": []}
    if audio_bytes:
        (PROCS / pid / audio_name).write_bytes(audio_bytes)
        transcript = await ai.transcribe(audio_bytes, audio_name, timestamps=True)

    proc = await ai.build_procedure([ai.b64(f) for f in frames_bytes], frame_times, transcript, title)
    proc.update({"id": pid, "created": time.time(), "n_frames": len(frames_bytes), "source": source, "mock": ai.mock_mode(),
                 "hardware": hardware, "demonstrator": demonstrator, "frame_times": frame_times})
    _write(_proc_path(pid), proc)

    # The expert recording is itself a demonstration episode for the dataset.
    sid = "expert-" + pid
    _write(_sess_path(sid), {
        "id": sid,
        "role": "expert",
        "procedure_id": pid,
        "procedure_title": proc.get("title"),
        "started": time.time() - (frame_times[-1] if frame_times else 0),
        "ended": time.time(),
        "transcript": transcript,
        "hands": hands or [],
        "events": [{"t": s.get("t_start", 0), "type": "step_start", "step": i} for i, s in enumerate(proc["steps"])],
        "frames": [{"file": f"{i:04d}.jpg", "t": frame_times[i], "step": _step_at(proc, frame_times[i])} for i in range(len(frames_bytes))],
        "frames_dir": f"procedures/{pid}/frames",
    })
    return proc


def _step_at(proc, t):
    for i, s in enumerate(proc["steps"]):
        if s.get("t_start", 0) <= t <= s.get("t_end", 0):
            return i
    return None


# ---------- API ----------

@app.get("/api/status")
def status():
    return {"mock": ai.mock_mode(), "tts": ai.tts_enabled(), "check_model": ai.cfg("OPENAI_CHECK_MODEL", "gpt-4.1-mini")}


@app.post("/api/procedures/build")
async def build(
    frames: list[UploadFile] = File(...),
    frame_times: str = Form("[]"),
    title: str = Form(""),
    hands: str = Form("[]"),
    hardware: str = Form(""),
    demonstrator: str = Form(""),
    audio: UploadFile | None = File(None),
):
    """Expert recorded in the browser: frames + audio + hand landmarks."""
    fb = [await f.read() for f in frames]
    times = json.loads(frame_times) or [i * 1.5 for i in range(len(fb))]
    ab = await audio.read() if audio else None
    try:
        return await _finish_build(fb, times, ab, audio.filename if audio else "", title, json.loads(hands), "browser", hardware, demonstrator)
    except Exception as e:  # surface model errors to the UI
        raise HTTPException(502, f"Building the guide failed: {e}")


@app.post("/api/procedures/build_from_video")
async def build_from_video(video: UploadFile = File(...), title: str = Form(""), hardware: str = Form(""), demonstrator: str = Form("")):
    """Expert recorded with the phone's normal camera app: extract frames and audio with ffmpeg."""
    tmp = Path(tempfile.mkdtemp())
    try:
        src = tmp / ("in" + Path(video.filename or "v.mp4").suffix)
        src.write_bytes(await video.read())
        every = float(ai.cfg("VIDEO_FRAME_EVERY", "1.5"))
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(src), "-vf", f"fps=1/{every},scale=768:-2", "-q:v", "4", str(tmp / "f_%04d.jpg")],
            check=True,
        )
        has_audio = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(tmp / "audio.mp3")]
        ).returncode == 0
        fpaths = sorted(tmp.glob("f_*.jpg"))
        fb = [p.read_bytes() for p in fpaths]
        times = [i * every for i in range(len(fb))]
        ab = (tmp / "audio.mp3").read_bytes() if has_audio and (tmp / "audio.mp3").exists() else None
        return await _finish_build(fb, times, ab, "audio.mp3", title, [], "video", hardware, demonstrator)
    except subprocess.CalledProcessError:
        raise HTTPException(400, "Couldn't read that video file.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Building the guide failed: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/api/procedures")
def list_procedures():
    eps = {}
    for sp in SESS.glob("*/session.json"):
        pid = _read(sp).get("procedure_id")
        eps[pid] = eps.get(pid, 0) + 1
    out = []
    for p in sorted(PROCS.glob("*/procedure.json"), reverse=True):
        j = _read(p)
        out.append({"id": j["id"], "title": j.get("title"), "hardware": j.get("hardware", ""), "steps": len(j.get("steps", [])),
                    "episodes": eps.get(j["id"], 0), "created": j.get("created"), "mock": j.get("mock")})
    return out


@app.get("/api/procedures/{pid}")
def get_procedure(pid: str):
    return _load_proc(pid)


@app.put("/api/procedures/{pid}")
async def save_procedure(pid: str, body: dict):
    proc = _load_proc(pid)
    for k in ("title", "summary", "steps", "tools", "safety"):
        if k in body:
            proc[k] = body[k]
    _write(_proc_path(pid), proc)
    return proc


@app.get("/api/procedures/{pid}/frame/{idx}")
def procedure_frame(pid: str, idx: int):
    p = PROCS / pid / "frames" / f"{idx:04d}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


@app.post("/api/check")
async def check(
    image: UploadFile = File(...),
    procedure_id: str = Form(...),
    step_index: int = Form(...),
    session_id: str = Form(...),
    t: float = Form(0),
    history: str = Form(""),
    verify: str = Form("0"),
    prev_image: UploadFile | None = File(None),
):
    proc = _load_proc(procedure_id)
    if not 0 <= step_index < len(proc["steps"]):
        raise HTTPException(400, "Bad step")
    live = await image.read()

    ref_b64 = None
    rf = proc["steps"][step_index].get("ref_frame")
    rp = PROCS / procedure_id / "frames" / f"{rf:04d}.jpg" if isinstance(rf, int) else None
    if rp and rp.exists():
        ref_b64 = ai.b64(rp.read_bytes())

    t0 = time.time()
    try:
        prev = ai.b64(await prev_image.read()) if prev_image else None
        out = await ai.check_step(proc, step_index, ai.b64(live), ref_b64, history, prev_b64=prev, verify=verify == "1")
        out["verified"] = verify == "1"
    except Exception as e:
        return JSONResponse({"status": "error", "feedback": "", "observation": str(e)[:300]})
    out["latency"] = round(time.time() - t0, 2)

    # Every checked frame is saved with its label: this is the training data.
    fdir = SESS / session_id / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    fname = f"{len(list(fdir.glob('*.jpg'))):04d}.jpg"
    (fdir / fname).write_bytes(live)
    out["frame"] = fname
    return out


WAKE = re.compile(r"\b(coach|couch|coaches|koch|cooch|poach)\b[\s,.!?]*", re.I)
COMMANDS = [
    ("next", re.compile(r"^(next|next step|skip|skip it|done|i'?m done|finished|go on)\W*$", re.I)),
    ("back", re.compile(r"^(back|go back|previous|previous step|last step)\W*$", re.I)),
    ("repeat", re.compile(r"^(repeat( that| it| please)?|say (that|it) again|again|what was that|come again)\W*$", re.I)),
    ("check", re.compile(r"^(check|check (it|this|now)|is (this|it) (right|ok|okay|correct))\W*$", re.I)),
]


@app.post("/api/ask")
async def ask(
    audio: UploadFile = File(...),
    procedure_id: str = Form(...),
    step_index: int = Form(...),
    hands_free: str = Form("0"),
    image: UploadFile | None = File(None),
):
    proc = _load_proc(procedure_id)
    ab = await audio.read()
    try:
        q = (await ai.transcribe(ab, audio.filename or "q.webm"))["text"] if not ai.mock_mode() else "Coach, what do I do here?"
        q = q.strip()
        if hands_free == "1":
            # Only react when addressed: "Coach, ..." keeps room chatter out.
            m = WAKE.search(q)
            if not m:
                return {"ignored": True, "question": q}
            q = q[m.end():].strip()
            for name, rx in COMMANDS:
                if rx.match(q):
                    return {"question": q, "command": name}
        if not q:
            return {"question": "", "answer": "Yes? Ask me anything about this step."}
        live = ai.b64(await image.read()) if image else None
        out = await ai.answer_question(proc, step_index, q, live)
        return {"question": q, "answer": ai._no_dashes(out.get("answer", ""))}
    except Exception as e:
        return {"question": "", "answer": "I couldn't reach the AI just now. Try again.", "error": str(e)[:300]}


@app.post("/api/tts")
async def tts(body: dict):
    audio = await ai.tts(body.get("text", ""))
    if audio is None:
        return Response(status_code=204)
    return Response(audio, media_type="audio/mpeg")


@app.post("/api/sessions/{sid}")
async def save_session(sid: str, body: dict):
    prev = _load_sess(sid) or {}
    prev.update(body)
    prev["id"] = sid
    prev.setdefault("role", "novice")
    prev["frames_dir"] = f"sessions/{sid}/frames"
    _write(_sess_path(sid), prev)
    return {"ok": True}


def _mistakes(ev):
    # New sessions log confirmed (spoken) mistakes; older ones only raw check results.
    if any(e.get("type") == "mistake_spoken" or "outdated" in e for e in ev):
        return sum(1 for e in ev if e.get("type") == "mistake_spoken")
    return sum(1 for e in ev if e.get("type") == "check" and e.get("status") == "mistake")


def _summary(s):
    ev = s.get("events", [])
    return {
        "id": s["id"],
        "role": s.get("role", "novice"),
        "procedure_id": s.get("procedure_id"),
        "procedure_title": s.get("procedure_title"),
        "started": s.get("started"),
        "duration": round((s.get("ended") or s.get("started") or 0) - (s.get("started") or 0), 1),
        "hand_samples": len(s.get("hands", [])),
        "frames": len(s.get("frames", [])),
        "mistakes": _mistakes(ev),
        "questions": sum(1 for e in ev if e.get("type") == "ask"),
        "steps_done": sum(1 for e in ev if e.get("type") == "step_done"),
        "completed": bool(s.get("completed")),
    }


@app.get("/api/sessions")
def list_sessions():
    out = [_summary(_read(p)) for p in SESS.glob("*/session.json")]
    return sorted(out, key=lambda s: s.get("started") or 0, reverse=True)


@app.get("/api/sessions/{sid}")
def get_session(sid: str):
    s = _load_sess(sid)
    if not s:
        raise HTTPException(404)
    s["summary"] = _summary(s)
    return s


@app.get("/api/sessions/{sid}/frame/{name}")
def session_frame(sid: str, name: str):
    s = _load_sess(sid)
    if not s or "/" in name:
        raise HTTPException(404)
    p = DATA / s["frames_dir"] / name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


def _episode(s):
    proc = None
    if s.get("procedure_id") and _proc_path(s["procedure_id"]).exists():
        proc = _load_proc(s["procedure_id"])
    return {
        "format": "apprentice-episode-v1",
        "role": s.get("role"),
        "task": proc.get("title") if proc else s.get("procedure_title"),
        "steps": [{k: st.get(k) for k in ("title", "instruction", "done_when")} for st in (proc or {}).get("steps", [])],
        "summary": _summary(s),
        "transcript": s.get("transcript"),
        "events": s.get("events", []),
        "frames": s.get("frames", []),
        "hands": s.get("hands", []),
        "hand_landmark_format": "MediaPipe 21 keypoints, normalised image coords [x, y, z]",
        "procedure_id": s.get("procedure_id"),
        "id": s["id"],
    }


def _zip_episode(z, s, prefix=""):
    z.writestr(f"{prefix}episode.json", json.dumps(_episode(s), indent=2))
    fdir = DATA / s["frames_dir"]
    if fdir.exists():
        for f in sorted(fdir.glob("*.jpg")):
            z.write(f, f"{prefix}frames/{f.name}")


@app.get("/api/sessions/{sid}/export")
def export_session(sid: str):
    """Zip: episode.json (hands, events, labels, transcript) + labelled frames."""
    s = _load_sess(sid)
    if not s:
        raise HTTPException(404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        _zip_episode(z, s)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{sid}.zip"'})


def build_dataset_zip(target):
    """Everything recorded, in one place: every guide and every episode."""
    sessions = [_read(p) for p in SESS.glob("*/session.json")]
    sessions.sort(key=lambda s: s.get("started") or 0)
    procs = [_read(p) for p in PROCS.glob("*/procedure.json")]
    manifest = {
        "format": "apprenta-dataset-v1",
        "created": time.time(),
        "tasks": [{"id": p["id"], "title": p.get("title"), "hardware": p.get("hardware", ""), "steps": len(p.get("steps", []))} for p in procs],
        "episodes": [{**_summary(s), "path": f"episodes/{s['id']}/"} for s in sessions],
        "totals": {
            "episodes": len(sessions),
            "expert_demos": sum(1 for s in sessions if s.get("role") == "expert"),
            "guided_attempts": sum(1 for s in sessions if s.get("role") != "expert"),
            "hand_samples": sum(len(s.get("hands", [])) for s in sessions),
            "labelled_frames": sum(len(s.get("frames", [])) for s in sessions),
            "mistakes_caught": sum(_mistakes(s.get("events", [])) for s in sessions),
        },
    }
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for p in procs:
            d = PROCS / p["id"]
            z.writestr(f"tasks/{p['id']}/procedure.json", json.dumps(p, indent=2))
            for a in d.glob("audio.*"):
                z.write(a, f"tasks/{p['id']}/{a.name}")
        for s in sessions:
            _zip_episode(z, s, f"episodes/{s['id']}/")
    return manifest


@app.get("/api/export_all")
def export_all():
    buf = io.BytesIO()
    build_dataset_zip(buf)
    buf.seek(0)
    name = f"apprenta-dataset-{time.strftime('%Y%m%d-%H%M')}.zip"
    return StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
