"""Local text-to-speech (Kokoro via ONNX, CPU) with an on-disk MP3 cache and prefetch."""
import re
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import db
from extract import EMPTY_PAGE

MODELS_DIR = db.DATA_DIR / "models"
AUDIO_DIR = db.DATA_DIR / "audio"
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

VOICES = [
    {"id": "af_heart", "label": "Heart (US F)"},
    {"id": "af_bella", "label": "Bella (US F)"},
    {"id": "af_nicole", "label": "Nicole (US F)"},
    {"id": "am_michael", "label": "Michael (US M)"},
    {"id": "am_adam", "label": "Adam (US M)"},
    {"id": "bf_emma", "label": "Emma (UK F)"},
    {"id": "bm_george", "label": "George (UK M)"},
]
DEFAULT_VOICE = VOICES[0]["id"]
VOICE_IDS = {v["id"] for v in VOICES}

_kokoro = None
_load_lock = threading.Lock()
_gen_lock = threading.Lock()  # one synthesis at a time keeps CPU/RAM predictable
_key_locks: dict = {}
_key_locks_guard = threading.Lock()
_prefetch_pool = ThreadPoolExecutor(max_workers=1)

# Set by the app so /api/status can show download progress.
status = {"state": "idle", "detail": ""}


def _download(name: str):
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dest = MODELS_DIR / name
    if dest.exists():
        return dest
    status.update(state="downloading", detail=name)
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(f"{RELEASE}/{name}", tmp)
    tmp.replace(dest)
    return dest


def _engine():
    global _kokoro
    with _load_lock:
        if _kokoro is None:
            from kokoro_onnx import Kokoro

            model = _download(MODEL_FILE)
            voices = _download(VOICES_FILE)
            status.update(state="loading", detail="model")
            _kokoro = Kokoro(str(model), str(voices))
            status.update(state="ready", detail="")
        return _kokoro


def _sentences(text: str, limit: int = 350):
    """Split text into chunks small enough for the model's token window."""
    out = []
    for para in re.split(r"\n{2,}", text):
        cur = ""
        for s in re.split(r"(?<=[.!?;:])\s+", para.strip()):
            while len(s) > limit:  # very long run-on sentence: cut at a space
                cut = s.rfind(" ", 0, limit)
                cut = cut if cut > 0 else limit
                if cur:
                    out.append(cur)
                    cur = ""
                out.append(s[:cut])
                s = s[cut:].strip()
            if cur and len(cur) + len(s) + 1 > limit:
                out.append(cur)
                cur = s
            else:
                cur = f"{cur} {s}".strip()
        if cur:
            out.append(cur)
    return [c for c in out if re.search(r"\w", c)]


def _encode_mp3(samples: np.ndarray, rate: int) -> bytes:
    import lameenc

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    return bytes(enc.encode(pcm.tobytes()) + enc.flush())


def _synthesize(text: str, voice: str) -> bytes:
    kokoro = _engine()
    pieces, rate = [], 24000
    gap = None
    for chunk in _sentences(text):
        samples, rate = kokoro.create(chunk, voice=voice, speed=1.0, lang="en-us")
        if gap is None:
            gap = np.zeros(int(rate * 0.18), dtype=np.float32)
        pieces.append(np.asarray(samples, dtype=np.float32))
        pieces.append(gap)
    if not pieces:
        pieces = [np.zeros(int(rate * 0.5), dtype=np.float32)]
    return _encode_mp3(np.concatenate(pieces), rate)


def audio_path(book_id: int, page: int, voice: str) -> Path:
    return AUDIO_DIR / str(book_id) / voice / f"{page}.mp3"


def get_audio(book_id: int, page: int, voice: str) -> Path | None:
    """Return the cached MP3 for a page, generating it on first use."""
    if voice not in VOICE_IDS:
        voice = DEFAULT_VOICE
    path = audio_path(book_id, page, voice)
    if path.exists():
        return path
    text = db.get_page_text(book_id, page)
    if text is None:
        return None
    if text == EMPTY_PAGE:
        text = "This page has no readable text."

    key = (book_id, page, voice)
    with _key_locks_guard:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        if path.exists():
            return path
        with _gen_lock:
            data = _synthesize(text, voice)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return path


def prefetch(book_id: int, page: int, voice: str, count: int = 2):
    book = db.get_book(book_id)
    if not book:
        return
    for p in range(page + 1, min(page + count, book["page_count"]) + 1):
        if not audio_path(book_id, p, voice).exists():
            _prefetch_pool.submit(_safe_get, book_id, p, voice)


def _safe_get(book_id, page, voice):
    try:
        get_audio(book_id, page, voice)
    except Exception as exc:  # prefetch is best-effort
        print(f"prefetch failed for book {book_id} page {page}: {exc}")


def delete_book_audio(book_id: int):
    import shutil

    shutil.rmtree(AUDIO_DIR / str(book_id), ignore_errors=True)


def delete_page_audio(book_id: int, page: int):
    """Drop one page's cached audio in every voice (its text changed)."""
    for f in (AUDIO_DIR / str(book_id)).glob(f"*/{page}.mp3"):
        f.unlink(missing_ok=True)


def audio_bytes(book_id: int) -> int:
    return sum(f.stat().st_size for f in (AUDIO_DIR / str(book_id)).rglob("*.mp3"))


def clear_all_audio():
    import shutil

    shutil.rmtree(AUDIO_DIR, ignore_errors=True)
