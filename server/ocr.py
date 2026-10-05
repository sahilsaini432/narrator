"""Read the text on a photographed book page (RapidOCR, runs locally on CPU)."""
import io
import re
import statistics
import threading

MAX_SIDE = 1800  # phone photos are ~12 MP; this is plenty for print and far faster to read
_engine = None
_lock = threading.Lock()  # the engine is not thread-safe, and one page at a time keeps RAM predictable


def prepare_image(data: bytes) -> bytes:
    """Apply the phone's rotation, shrink, and return JPEG bytes."""
    from PIL import Image, ImageOps

    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise ValueError("That file isn't an image Narrator can open (try JPEG or PNG)")
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue()


def _group_lines(boxes):
    """Merge recognized fragments into visual lines: [(left, right, top, bottom, text)]."""
    frags = []
    for box, text, _score in boxes:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        frags.append((min(xs), max(xs), min(ys), max(ys), text.strip()))
    frags = [f for f in frags if f[4]]
    if not frags:
        return []
    height = statistics.median(f[3] - f[2] for f in frags)
    frags.sort(key=lambda f: (f[2] + f[3]) / 2)
    lines, cur = [], [frags[0]]
    for f in frags[1:]:
        cy = statistics.mean((g[2] + g[3]) / 2 for g in cur)
        if abs((f[2] + f[3]) / 2 - cy) <= 0.6 * height:
            cur.append(f)
        else:
            lines.append(cur)
            cur = [f]
    lines.append(cur)
    merged = []
    for ln in lines:
        ln.sort(key=lambda f: f[0])
        merged.append(
            (ln[0][0], max(f[1] for f in ln), min(f[2] for f in ln), max(f[3] for f in ln),
             " ".join(f[4] for f in ln))
        )
    return merged


def _is_page_number(text: str) -> bool:
    return bool(re.fullmatch(r"[-–—\s]*(page\s*)?\d{1,4}[-–—\s]*", text.lower()))


def lines_to_text(lines) -> str:
    """Rebuild paragraphs from lines: break on a first-line indent or a short line ending a sentence."""
    if not lines:
        return ""
    # A lone number at the very top or bottom is a page number, not something to read aloud.
    if len(lines) > 1 and _is_page_number(lines[0][4]):
        lines = lines[1:]
    if len(lines) > 1 and _is_page_number(lines[-1][4]):
        lines = lines[:-1]

    height = statistics.median(l[3] - l[2] for l in lines)
    left = statistics.median(l[0] for l in lines)
    right = max(l[1] for l in lines)
    width = max(right - min(l[0] for l in lines), 1)

    paragraphs, cur = [], ""
    prev = None
    for l in lines:
        text = l[4]
        new_para = False
        if prev is not None:
            indented = l[0] - left > 1.0 * height
            gap = l[2] - prev[3] > 0.9 * height
            short_end = (prev[1] < right - 0.15 * width) and re.search(r'[.!?]["”’\')]?$', prev[4])
            new_para = indented or gap or bool(short_end)
        if new_para:
            paragraphs.append(cur)
            cur = text
        elif cur.endswith("-") and text[:1].islower():
            cur = cur[:-1] + text  # re-join a word hyphenated across lines
        else:
            cur = f"{cur} {text}".strip()
        prev = l
    if cur:
        paragraphs.append(cur)
    return "\n\n".join(paragraphs)


def read_text(jpeg: bytes) -> str:
    global _engine
    import numpy as np
    from PIL import Image

    with _lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
        arr = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB"))[:, :, ::-1]  # RGB -> BGR
        result, _elapsed = _engine(arr)
    return lines_to_text(_group_lines(result or []))
