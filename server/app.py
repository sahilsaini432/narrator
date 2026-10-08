import re
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import db
import extract
import ocr
import tts

ROOT = Path(__file__).resolve().parent.parent
UPLOADS = db.DATA_DIR / "uploads"
PHOTOS = UPLOADS / "photos"  # one sub-folder per photo book: data/uploads/photos/<book id>/
MAX_PHOTO_BYTES = 30_000_000
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Narrator")
db.init()
UPLOADS.mkdir(parents=True, exist_ok=True)


class ProgressIn(BaseModel):
    page: int = Field(ge=1)
    offset_seconds: float = Field(default=0, ge=0)


class FolderIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class BookPatch(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class PageIn(BaseModel):
    text: str = Field(max_length=100_000)


class MoveIn(BaseModel):
    to: int = Field(ge=1)


def _book_or_404(book_id: int) -> dict:
    book = db.get_book(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    return book


def _dir_bytes(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


@app.get("/api/books")
def list_books():
    return db.list_books()


@app.post("/api/books")
def upload_book(file: UploadFile = File(...)):
    name = Path(file.filename or "upload").name
    ext = Path(name).suffix.lower()
    if ext not in (".pdf", ".epub"):
        raise HTTPException(400, "Only .pdf and .epub files are supported")
    safe = re.sub(r"[^\w.\- ]", "_", Path(name).stem)[:80]
    dest = UPLOADS / f"{uuid.uuid4().hex[:8]}-{safe}{ext}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        fmt, title, author, pages = extract.extract(dest)
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, f"Could not read this file: {exc}")
    if not any(p != extract.EMPTY_PAGE for p in pages):
        dest.unlink(missing_ok=True)
        raise HTTPException(
            422, "No readable text found. This looks like a scanned PDF (OCR isn't supported yet)."
        )
    book_id = db.add_book(title, author, fmt, dest, pages)
    return db.get_book(book_id)


class UrlIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


@app.post("/api/books/url")
def add_web_page(body: UrlIn):
    url = body.url.strip()
    if "://" not in url:
        url = "https://" + url
    try:
        title, author, pages = extract.extract_web(url)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(422, f"Could not load that page: {exc}")
    # The source URL stands in for the file path; there is no file to keep.
    return db.get_book(db.add_book(title, author, "web", url, pages))


class TextIn(BaseModel):
    title: str = Field(default="", max_length=200)
    text: str = Field(min_length=1, max_length=1_000_000)


@app.post("/api/books/text")
def add_text(body: TextIn):
    try:
        title, pages = extract.extract_text(body.text, body.title.strip())
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    # Pasted text has no file behind it, so the file path is left empty.
    return db.get_book(db.add_book(title, "", "text", "", pages))


@app.get("/api/books/{book_id}")
def get_book(book_id: int):
    return _book_or_404(book_id)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: int):
    _book_or_404(book_id)
    path = db.get_book_file(book_id)
    db.delete_book(book_id)
    tts.delete_book_audio(book_id)
    shutil.rmtree(PHOTOS / str(book_id), ignore_errors=True)
    if path and "://" not in path:
        Path(path).unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/folders")
def create_folder(body: FolderIn):
    """A photo folder is a book whose pages are photographed pages."""
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Give the folder a name")
    return db.get_book(db.add_book(title, "", "photos", "", []))


@app.post("/api/books/{book_id}/photos")
def add_photo(book_id: int, file: UploadFile = File(...)):
    book = _book_or_404(book_id)
    if book["format"] != "photos":
        raise HTTPException(400, "Photos can only be added to a photo folder")
    data = file.file.read(MAX_PHOTO_BYTES + 1)
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "That photo is too large")
    try:
        jpeg = ocr.prepare_image(data)
        text = ocr.read_text(jpeg)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"Could not read text from this photo: {exc}")
    if not re.search(r"\w", text):
        raise HTTPException(
            422, "No text found in this photo. Try a flatter, brighter, closer shot of the page."
        )
    folder = PHOTOS / str(book_id)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex[:10]}.jpg"
    (folder / name).write_bytes(jpeg)
    db.append_page(book_id, text, name)
    return db.get_book(book_id)


@app.patch("/api/books/{book_id}")
def rename_book(book_id: int, body: BookPatch):
    _book_or_404(book_id)
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Title can't be empty")
    db.rename_book(book_id, title)
    return db.get_book(book_id)


@app.get("/api/books/{book_id}/pages")
def list_pages(book_id: int):
    _book_or_404(book_id)
    return db.list_pages(book_id)


@app.put("/api/books/{book_id}/pages/{n}")
def edit_page(book_id: int, n: int, body: PageIn):
    _book_or_404(book_id)
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "A page can't be empty. Delete it instead.")
    if not db.update_page_text(book_id, n, text):
        raise HTTPException(404, "Page not found")
    tts.delete_page_audio(book_id, n)  # re-generated from the new text on next play
    return {"ok": True}


@app.delete("/api/books/{book_id}/pages/{n}")
def delete_page(book_id: int, n: int):
    _book_or_404(book_id)
    found, image = db.delete_page(book_id, n)
    if not found:
        raise HTTPException(404, "Page not found")
    if image:
        (PHOTOS / str(book_id) / Path(image).name).unlink(missing_ok=True)
    tts.delete_book_audio(book_id)  # cached audio is keyed by page number, which just shifted
    return db.get_book(book_id)


@app.post("/api/books/{book_id}/pages/{n}/move")
def move_page(book_id: int, n: int, body: MoveIn):
    book = _book_or_404(book_id)
    if not (1 <= n <= book["page_count"] and body.to <= book["page_count"]):
        raise HTTPException(404, "Page not found")
    db.move_page(book_id, n, body.to)
    tts.delete_book_audio(book_id)
    return {"ok": True}


@app.get("/api/books/{book_id}/pages/{n}/image")
def page_image(book_id: int, n: int):
    image = db.get_page_image(book_id, n)
    path = PHOTOS / str(book_id) / Path(image).name if image else None
    if not path or not path.is_file():
        raise HTTPException(404, "No photo for this page")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/books/{book_id}/pages/{n}")
def get_page(book_id: int, n: int):
    text = db.get_page_text(book_id, n)
    if text is None:
        raise HTTPException(404, "Page not found")
    return {"page": n, "text": text}


@app.get("/api/books/{book_id}/pages/{n}/audio")
def get_audio(book_id: int, n: int, voice: str = tts.DEFAULT_VOICE):
    book = _book_or_404(book_id)
    if not 1 <= n <= book["page_count"]:
        raise HTTPException(404, "Page not found")
    try:
        path = tts.get_audio(book_id, n, voice)
    except Exception as exc:
        raise HTTPException(500, f"Speech generation failed: {exc}")
    if path is None:
        raise HTTPException(404, "Page not found")
    voice = voice if voice in tts.VOICE_IDS else tts.DEFAULT_VOICE
    tts.prefetch(book_id, n, voice)
    # FileResponse supports HTTP Range requests, which Safari requires for <audio>.
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "no-cache"})


@app.get("/api/books/{book_id}/progress")
def get_progress(book_id: int):
    book = _book_or_404(book_id)
    return {
        "page": book["page"] or 1,
        "offset_seconds": book["offset_seconds"] or 0,
        "updated_at": book["progress_updated_at"],
    }


@app.put("/api/books/{book_id}/progress")
def put_progress(book_id: int, body: ProgressIn):
    book = _book_or_404(book_id)
    page = min(body.page, book["page_count"])
    return {"updated_at": db.save_progress(book_id, page, body.offset_seconds)}


@app.get("/api/storage")
def storage():
    books = []
    for b in db.list_books():
        file_path = db.get_book_file(b["id"]) or ""
        if b["format"] == "photos":
            file_bytes = _dir_bytes(PHOTOS / str(b["id"]))
        elif file_path and "://" not in file_path and Path(file_path).is_file():
            file_bytes = Path(file_path).stat().st_size
        else:
            file_bytes = 0
        books.append(
            {
                "id": b["id"],
                "title": b["title"],
                "format": b["format"],
                "page_count": b["page_count"],
                "file_bytes": file_bytes,
                "audio_bytes": tts.audio_bytes(b["id"]),
            }
        )
    return {"books": books, "audio_total": sum(b["audio_bytes"] for b in books)}


@app.delete("/api/books/{book_id}/audio")
def clear_book_audio(book_id: int):
    _book_or_404(book_id)
    tts.delete_book_audio(book_id)
    return {"ok": True}


@app.delete("/api/audio")
def clear_audio():
    tts.clear_all_audio()
    return {"ok": True}


@app.get("/api/voices")
def voices():
    return {"default": tts.DEFAULT_VOICE, "voices": tts.VOICES}


@app.get("/api/status")
def status():
    return tts.status


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
