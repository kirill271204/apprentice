"""AI layer: OpenAI (vision, reasoning, speech to text) and ElevenLabs (text to speech).

Uses the REST APIs directly via httpx. If OPENAI_API_KEY is missing, every
function falls back to a deterministic mock so the app is always demoable.
"""

import base64
import json
import os
from collections import defaultdict

import httpx

OPENAI_URL = "https://api.openai.com/v1"
ELEVEN_URL = "https://api.elevenlabs.io/v1"


def cfg(name, default=""):
    return os.getenv(name, default).strip()


def mock_mode():
    return not cfg("OPENAI_API_KEY")


def tts_enabled():
    return bool(cfg("ELEVENLABS_API_KEY"))


def _headers():
    return {"Authorization": f"Bearer {cfg('OPENAI_API_KEY')}"}


def _img(b64jpeg, detail="low"):
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64jpeg}", "detail": detail}}


def _is_reasoning(model):
    return model.startswith(("gpt-5", "o1", "o3", "o4"))


async def _chat_json(model, system, content, max_tokens=1500, effort=None):
    """Chat completion that must return a JSON object. Retries without
    reasoning_effort if the model rejects it, and falls back to a
    second model if the first one is unavailable."""
    models = [model, cfg("OPENAI_FALLBACK_MODEL", "gpt-4.1-mini")]
    effort = cfg("OPENAI_REASONING_EFFORT", "low") if effort is None else effort
    last_err = None
    async with httpx.AsyncClient(timeout=90) as client:
        for m in models:
            for use_effort in ([True, False] if effort and _is_reasoning(m) else [False]):
                body = {
                    "model": m,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
                    "response_format": {"type": "json_object"},
                    "max_completion_tokens": max_tokens,
                }
                if use_effort:
                    body["reasoning_effort"] = effort
                r = await client.post(f"{OPENAI_URL}/chat/completions", headers=_headers(), json=body)
                if r.status_code == 200:
                    text = r.json()["choices"][0]["message"]["content"] or "{}"
                    return json.loads(text)
                last_err = f"{m}: {r.status_code} {r.text[:300]}"
                if r.status_code == 400 and "reasoning" in r.text:
                    continue  # retry same model without reasoning_effort
                break  # try fallback model
    raise RuntimeError(last_err)


async def transcribe(audio_bytes, filename, timestamps=False):
    """Returns {"text": str, "segments": [{"start", "end", "text"}]}."""
    if mock_mode():
        return {"text": "", "segments": []}
    data = {"model": "whisper-1" if timestamps else cfg("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")}
    if timestamps:
        data["response_format"] = "verbose_json"
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            f"{OPENAI_URL}/audio/transcriptions",
            headers=_headers(),
            data=data,
            files={"file": (filename, audio_bytes)},
        )
    r.raise_for_status()
    j = r.json()
    segs = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in j.get("segments", [])]
    return {"text": j.get("text", ""), "segments": segs}


BUILD_SYSTEM = """You turn an expert's first person recording of a hands on task into a guide that a beginner can follow while a phone camera watches their hands.

You get the expert's narration (with timestamps) and frames sampled from the video (each labelled with its index and time).

Return a JSON object:
{
  "title": short task name,
  "summary": one sentence,
  "tools": [parts or tools needed],
  "safety": [safety notes, empty if none],
  "steps": [
    {
      "title": 2 to 5 words,
      "instruction": one or two short sentences, spoken aloud to the beginner, second person,
      "done_when": a condition that can be checked visually from a camera frame,
      "common_mistakes": [specific, visible mistakes a beginner might make on this step],
      "tip": optional extra advice from the expert, or "",
      "t_start": seconds, "t_end": seconds,
      "ref_frame": index of the frame that best shows this step completed
    }
  ]
}

Rules: 3 to 10 steps. Follow the expert's actual order and wording where possible. Be concrete about parts, colours, positions and directions. Never invent steps the expert did not show or say.

The beginner wears the phone on their chest and only HEARS you, so:
- instruction: one action, at most 15 words, easy to follow by ear.
- done_when: the visible END STATE as seen from a chest camera looking down at the hands (for example "the cover is flat and closed, no gap"), never a hidden mechanism (not "the tab is hooked inside").
- common_mistakes: only mistakes that are clearly visible from that camera, with the exact visual cue (for example "the flat end of the battery faces away from the spring").
- ref_frame: prefer a frame where the hands are out of the way and the result is clearly visible."""


CHECK_SYSTEM = """You are a live coach watching a beginner do a hands on task through their phone camera.

Current step {n} of {total}: "{title}"
Instruction: {instruction}
Done when: {done_when}
Things to look out for (report only if you clearly SEE them): {mistakes}
Recent checks on this step, oldest first: {history}
The beginner may have fixed earlier problems since then. Judge only what the LIVE frame shows now.

Images: the EXPERT reference for this step{ref_note} (it may be from a different angle or distance, use it only to know what the result should look like), then {live_note}.

Status of the LIVE frame:
- "done": the done_when condition is clearly visible.
- "mistake": something is clearly DONE WRONG and you can see it plainly (wrong part, wrong place, wrong orientation). You would bet on it.
- "working": not finished yet, or not started. A part that is simply missing or not yet placed is "working", never "mistake".
- "unsure": you can see the work area but cannot verify the key detail (it is covered by fingers, too small, at a bad angle or blurry). Never guess a mistake; use "unsure" instead.
- "unclear": the work area is not in view at all.

Return JSON: {{"status": ..., "feedback": ..., "observation": ...}}
- feedback: at most 12 words, spoken to the beginner. Concrete: which part, which way. "done": brief praise. "working": "". "unsure": what to do so you can see (for example "Move your thumb so I can see the battery end"). "unclear": how to point the camera.
- observation: a short neutral description of what you see (for the dataset).
Do not use dashes."""


ASK_SYSTEM = """You are a friendly expert coach helping a beginner through a hands on task in real time. You have the full guide below and the beginner's current camera frame.

Guide: {guide}
They are on step {n}: "{title}".

Answer their question in one to three short spoken sentences. Be concrete and practical. If it is unsafe, say so clearly. Return JSON: {{"answer": ...}}"""


async def build_procedure(frames, frame_times, transcript, title_hint=""):
    """frames: list of base64 jpegs. Returns a procedure dict."""
    if mock_mode():
        return _mock_procedure(len(frames), frame_times, title_hint)

    # Cap the number of frames sent to the model, spread evenly.
    max_frames = int(cfg("MAX_BUILD_FRAMES", "24"))
    idx = list(range(len(frames)))
    if len(idx) > max_frames:
        step = len(idx) / max_frames
        idx = [int(i * step) for i in range(max_frames)]

    narration = "\n".join(f"[{s['start']:.1f}s to {s['end']:.1f}s] {s['text']}" for s in transcript.get("segments", []))
    if not narration:
        narration = transcript.get("text", "") or "(no narration)"

    content = [{"type": "text", "text": f"Task hint: {title_hint or 'unknown'}\n\nNarration:\n{narration}\n\nFrames follow."}]
    for i in idx:
        content.append({"type": "text", "text": f"Frame {i} at t={frame_times[i]:.1f}s"})
        content.append(_img(frames[i]))

    proc = await _chat_json(cfg("OPENAI_BUILD_MODEL", "gpt-5"), BUILD_SYSTEM, content, max_tokens=6000)
    n = len(frames)
    for s in proc.get("steps", []):
        rf = s.get("ref_frame")
        s["ref_frame"] = rf if isinstance(rf, int) and 0 <= rf < n else max(0, n - 1)
        s.setdefault("common_mistakes", [])
        s.setdefault("tip", "")
    return proc


async def check_step(procedure, step_index, live_b64, ref_b64=None, history="", model=None, detail=None, effort=None, prev_b64=None, verify=False):
    steps = procedure["steps"]
    step = steps[step_index]
    if mock_mode():
        return _mock_check(procedure.get("id", ""), step_index, step)
    if verify:  # second opinion from a stronger model on a sharper image
        model = model or cfg("OPENAI_VERIFY_MODEL", "gpt-4.1")
        detail = detail or "high"

    system = CHECK_SYSTEM.format(
        n=step_index + 1,
        total=len(steps),
        title=step["title"],
        instruction=step["instruction"],
        done_when=step["done_when"],
        mistakes="; ".join(step.get("common_mistakes", [])) or "none listed",
        history=history or "none",
        ref_note="" if ref_b64 else " (not available)",
        live_note="an EARLIER live frame (about 1 s ago, use it only if the current one is blocked) and then the CURRENT LIVE frame" if prev_b64 else "the LIVE camera frame",
    )
    d = detail or cfg("CHECK_DETAIL", "high")
    content = []
    if ref_b64:
        content += [{"type": "text", "text": "EXPERT reference:"}, _img(ref_b64, "low")]
    if prev_b64:
        content += [{"type": "text", "text": "EARLIER live frame:"}, _img(prev_b64, d)]
    content += [{"type": "text", "text": "CURRENT LIVE frame:" if prev_b64 else "LIVE frame:"}, _img(live_b64, d)]
    out = await _chat_json(model or cfg("OPENAI_CHECK_MODEL", "gpt-4.1-mini"), system, content, max_tokens=600, effort=effort)
    if out.get("status") not in ("done", "mistake", "working", "unsure", "unclear"):
        out["status"] = "working"
    out["feedback"] = _no_dashes(out.get("feedback", ""))
    out.setdefault("observation", "")
    return out


def _no_dashes(text):
    return text.replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ")


async def answer_question(procedure, step_index, question, live_b64=None):
    if mock_mode():
        step = procedure["steps"][step_index]
        return {"answer": f"For this step: {step['instruction']} {step.get('tip', '')}".strip()}
    guide = json.dumps(
        {"title": procedure.get("title"), "steps": [{k: s[k] for k in ("title", "instruction", "done_when", "tip") if k in s} for s in procedure["steps"]]}
    )
    step = procedure["steps"][step_index]
    system = ASK_SYSTEM.format(guide=guide, n=step_index + 1, title=step["title"])
    content = [{"type": "text", "text": f"Question: {question}"}]
    if live_b64:
        content.append(_img(live_b64))
    return await _chat_json(cfg("OPENAI_CHECK_MODEL", "gpt-5-mini"), system, content, max_tokens=1200)


async def tts(text):
    """Returns mp3 bytes, or None if ElevenLabs is not configured (browser speaks instead)."""
    if not tts_enabled() or not text.strip():
        return None
    voice = cfg("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{ELEVEN_URL}/text-to-speech/{voice}?output_format=mp3_44100_128",
            headers={"xi-api-key": cfg("ELEVENLABS_API_KEY")},
            json={"text": text, "model_id": cfg("ELEVENLABS_MODEL", "eleven_flash_v2_5")},
        )
    if r.status_code != 200:
        return None
    return r.content


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# ---------- Mock mode ----------

_mock_counts = defaultdict(int)


def _mock_procedure(n_frames, frame_times, title_hint):
    n = max(n_frames, 1)
    dur = frame_times[-1] if frame_times else 40.0
    names = [
        ("Lay out the base", "Place the large grey base plate flat in front of you.", "The grey base plate is flat and centred in view."),
        ("Add the wheels", "Press the two black axles under the base, then push a wheel onto each end.", "Four wheels are attached under the base."),
        ("Build the cabin", "Stack the red bricks on the front half of the base to make the cabin.", "Red bricks form a cabin on the front half."),
        ("Finish the roof", "Put the clear windscreen piece on the front and the flat roof piece on top.", "The windscreen and roof are on the cabin."),
    ]
    steps = []
    for i, (t, ins, done) in enumerate(names):
        steps.append({
            "title": t,
            "instruction": ins,
            "done_when": done,
            "common_mistakes": ["Piece attached facing the wrong way", "Piece pressed only halfway down"],
            "tip": "Press firmly until you hear a click.",
            "t_start": round(dur * i / 4, 1),
            "t_end": round(dur * (i + 1) / 4, 1),
            "ref_frame": min(n - 1, int(n * (i + 1) / 4) - 1) if n > 1 else 0,
        })
    return {
        "title": title_hint or "LEGO car (mock)",
        "summary": "Mock guide generated without an API key.",
        "tools": ["LEGO pieces"],
        "safety": [],
        "steps": steps,
    }


def _mock_check(proc_id, step_index, step):
    key = (proc_id, step_index)
    _mock_counts[key] += 1
    c = _mock_counts[key]
    if c == 1:
        return {"status": "working", "feedback": "", "observation": "Hands are working on the piece."}
    if c == 2 and step_index == 1:
        return {"status": "mistake", "feedback": step["common_mistakes"][0] + ". Flip it around.", "observation": "One piece looks reversed."}
    if c >= 3:
        _mock_counts[key] = 0
        return {"status": "done", "feedback": "Nice, that looks right.", "observation": step["done_when"]}
    return {"status": "working", "feedback": "", "observation": "Still in progress."}
