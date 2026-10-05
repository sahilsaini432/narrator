import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "narrator.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    file_path TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    added_at REAL NOT NULL,
    last_opened_at REAL
);
CREATE TABLE IF NOT EXISTS pages (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (book_id, n)
);
CREATE TABLE IF NOT EXISTS progress (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    page INTEGER NOT NULL DEFAULT 1,
    offset_seconds REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);
"""


@contextmanager
def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init():
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Photo folders keep the original image beside each page's text.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(pages)")}
        if "image" not in cols:
            conn.execute("ALTER TABLE pages ADD COLUMN image TEXT")


def add_book(title, author, fmt, file_path, pages):
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO books (title, author, format, file_path, page_count, added_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (title, author, fmt, str(file_path), len(pages), time.time()),
        )
        book_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO pages (book_id, n, text) VALUES (?, ?, ?)",
            [(book_id, i + 1, t) for i, t in enumerate(pages)],
        )
        conn.execute(
            "INSERT INTO progress (book_id, page, offset_seconds, updated_at) VALUES (?, 1, 0, ?)",
            (book_id, time.time()),
        )
    return book_id


_LIST_SQL = """
SELECT b.id, b.title, b.author, b.format, b.page_count, b.added_at, b.last_opened_at,
       p.page, p.offset_seconds, p.updated_at AS progress_updated_at
FROM books b LEFT JOIN progress p ON p.book_id = b.id
"""


def list_books():
    with connect() as conn:
        rows = conn.execute(
            _LIST_SQL + " ORDER BY COALESCE(b.last_opened_at, b.added_at) DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_book(book_id):
    with connect() as conn:
        row = conn.execute(_LIST_SQL + " WHERE b.id = ?", (book_id,)).fetchone()
    return dict(row) if row else None


def get_book_file(book_id):
    with connect() as conn:
        row = conn.execute("SELECT file_path FROM books WHERE id = ?", (book_id,)).fetchone()
    return row["file_path"] if row else None


def get_page_text(book_id, n):
    with connect() as conn:
        row = conn.execute(
            "SELECT text FROM pages WHERE book_id = ? AND n = ?", (book_id, n)
        ).fetchone()
    return row["text"] if row else None


def rename_book(book_id, title):
    with connect() as conn:
        conn.execute("UPDATE books SET title = ? WHERE id = ?", (title, book_id))


def list_pages(book_id):
    with connect() as conn:
        rows = conn.execute(
            "SELECT n, text, image FROM pages WHERE book_id = ? ORDER BY n", (book_id,)
        ).fetchall()
    return [{"n": r["n"], "text": r["text"], "has_image": r["image"] is not None} for r in rows]


def get_page_image(book_id, n):
    with connect() as conn:
        row = conn.execute(
            "SELECT image FROM pages WHERE book_id = ? AND n = ?", (book_id, n)
        ).fetchone()
    return row["image"] if row else None


def append_page(book_id, text, image=None):
    """Add a page at the end of a book; returns its page number."""
    with connect() as conn:
        n = conn.execute(
            "SELECT COALESCE(MAX(n), 0) + 1 FROM pages WHERE book_id = ?", (book_id,)
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO pages (book_id, n, text, image) VALUES (?, ?, ?, ?)",
            (book_id, n, text, image),
        )
        conn.execute("UPDATE books SET page_count = ? WHERE id = ?", (n, book_id))
    return n


def update_page_text(book_id, n, text):
    with connect() as conn:
        cur = conn.execute(
            "UPDATE pages SET text = ? WHERE book_id = ? AND n = ?", (text, book_id, n)
        )
    return cur.rowcount > 0


def delete_page(book_id, n):
    """Remove page n and close the gap. Returns (found, image filename)."""
    with connect() as conn:
        row = conn.execute(
            "SELECT image FROM pages WHERE book_id = ? AND n = ?", (book_id, n)
        ).fetchone()
        if not row:
            return False, None
        conn.execute("DELETE FROM pages WHERE book_id = ? AND n = ?", (book_id, n))
        # Renumber in two steps through negatives so the (book_id, n) key never collides.
        conn.execute("UPDATE pages SET n = -n WHERE book_id = ? AND n > ?", (book_id, n))
        conn.execute("UPDATE pages SET n = -n - 1 WHERE book_id = ? AND n < 0", (book_id,))
        count = conn.execute(
            "SELECT COUNT(*) FROM pages WHERE book_id = ?", (book_id,)
        ).fetchone()[0]
        conn.execute("UPDATE books SET page_count = ? WHERE id = ?", (count, book_id))
        # Keep the reader on the same content: pages before the saved one shifted down.
        conn.execute(
            "UPDATE progress SET page = CASE WHEN page > ? THEN page - 1 ELSE page END WHERE book_id = ?",
            (n, book_id),
        )
        conn.execute(
            "UPDATE progress SET page = MAX(1, MIN(page, ?)), offset_seconds = 0"
            " WHERE book_id = ? AND page > ?",
            (count, book_id, count),
        )
    return True, row["image"]


def move_page(book_id, n, to):
    with connect() as conn:
        if n == to:
            return
        conn.execute("UPDATE pages SET n = 0 WHERE book_id = ? AND n = ?", (book_id, n))
        if to < n:  # pages in [to, n-1] shift down the list by one
            conn.execute(
                "UPDATE pages SET n = -(n + 1) WHERE book_id = ? AND n BETWEEN ? AND ?",
                (book_id, to, n - 1),
            )
        else:  # pages in [n+1, to] shift up by one
            conn.execute(
                "UPDATE pages SET n = -(n - 1) WHERE book_id = ? AND n BETWEEN ? AND ?",
                (book_id, n + 1, to),
            )
        conn.execute("UPDATE pages SET n = -n WHERE book_id = ? AND n < 0", (book_id,))
        conn.execute("UPDATE pages SET n = ? WHERE book_id = ? AND n = 0", (to, book_id))


def delete_book(book_id):
    with connect() as conn:
        conn.execute("DELETE FROM books WHERE id = ?", (book_id,))


def save_progress(book_id, page, offset_seconds):
    now = time.time()
    with connect() as conn:
        conn.execute(
            "INSERT INTO progress (book_id, page, offset_seconds, updated_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(book_id) DO UPDATE SET page = excluded.page,"
            " offset_seconds = excluded.offset_seconds, updated_at = excluded.updated_at",
            (book_id, page, offset_seconds, now),
        )
        conn.execute("UPDATE books SET last_opened_at = ? WHERE id = ?", (now, book_id))
    return now


def touch_opened(book_id):
    with connect() as conn:
        conn.execute("UPDATE books SET last_opened_at = ? WHERE id = ?", (time.time(), book_id))
