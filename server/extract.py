"""Turn a PDF or EPUB into (title, author, pages) where each page is clean text."""
import re
from collections import Counter
from pathlib import Path

EMPTY_PAGE = "(no text on this page)"
EPUB_PAGE_CHARS = 2000


def _clean(text: str) -> str:
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # join hyphenated line breaks
    text = re.sub(r"\n{2,}", "\n\n", text)
    paragraphs = []
    for para in text.split("\n\n"):
        para = re.sub(r"\s*\n\s*", " ", para)
        para = re.sub(r"[ \t]+", " ", para).strip()
        if para:
            paragraphs.append(para)
    return "\n\n".join(paragraphs)


def _edge_lines(page_text: str):
    lines = [l.strip() for l in page_text.splitlines() if l.strip()]
    return lines[:2] + lines[-2:]


def _normalize_edge(line: str) -> str:
    return re.sub(r"\d+", "#", line.lower())


def extract_pdf(path: Path):
    import pymupdf as fitz

    doc = fitz.open(path)
    raw = [page.get_text("text") for page in doc]
    meta = doc.metadata or {}
    doc.close()

    # Lines that repeat at the top/bottom of many pages are headers/footers.
    counts = Counter()
    for t in raw:
        counts.update({_normalize_edge(l) for l in _edge_lines(t)})
    threshold = max(4, int(len(raw) * 0.4))
    repeated = (
        {k for k, v in counts.items() if v >= threshold and len(k) < 120}
        if len(raw) >= 6  # too few pages to tell headers from repeated body text
        else set()
    )

    pages = []
    for t in raw:
        kept = []
        for line in t.splitlines():
            s = line.strip()
            if not s:
                kept.append("")
                continue
            if re.fullmatch(r"(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?", s.lower()):
                continue
            if _normalize_edge(s) in repeated:
                continue
            kept.append(line)
        pages.append(_clean("\n".join(kept)) or EMPTY_PAGE)

    title = (meta.get("title") or "").strip() or path.stem
    return title, (meta.get("author") or "").strip(), pages


def _split_long(paragraph: str, limit: int):
    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    chunks, cur = [], ""
    for s in sentences:
        if cur and len(cur) + len(s) + 1 > limit:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return chunks


def extract_epub(path: Path):
    from bs4 import BeautifulSoup
    from ebooklib import ITEM_DOCUMENT, epub

    book = epub.read_epub(str(path), options={"ignore_ncx": True})

    def meta(name):
        vals = book.get_metadata("DC", name)
        return vals[0][0].strip() if vals else ""

    paragraphs = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "lxml")
        for tag in soup(["script", "style", "nav"]):
            tag.decompose()
        blocks = soup.find_all(["p", "h1", "h2", "h3", "h4", "li", "blockquote"])
        if not blocks:
            text = _clean(soup.get_text("\n"))
            if text:
                paragraphs.extend(text.split("\n\n"))
            continue
        for b in blocks:
            text = re.sub(r"\s+", " ", b.get_text(" ")).strip()
            if text:
                paragraphs.append(text)

    return meta("title") or path.stem, meta("creator"), _paginate(paragraphs)


def _paginate(paragraphs):
    pages, cur = [], ""
    for para in paragraphs:
        for piece in _split_long(para, EPUB_PAGE_CHARS) if len(para) > EPUB_PAGE_CHARS else [para]:
            if cur and len(cur) + len(piece) + 2 > EPUB_PAGE_CHARS:
                pages.append(cur)
                cur = piece
            else:
                cur = f"{cur}\n\n{piece}" if cur else piece
    if cur:
        pages.append(cur)
    return pages or [EMPTY_PAGE]


MAX_WEB_BYTES = 5_000_000
MAX_REDIRECTS = 5


def _check_public_url(url: str):
    """Reject non-http(s) URLs and hosts that resolve to this machine or the local network."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("Enter a full web address starting with http:// or https://")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443)
    except socket.gaierror:
        raise ValueError(f"Could not find the site “{parts.hostname}”")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError("That address points at a private or local network, so it was blocked")


_USER_AGENTS = (
    # Some sites (e.g. Wikipedia) only serve clients that identify themselves honestly...
    "Narrator/1.0 (personal text-to-speech reader)",
    # ...while others block anything that doesn't look like a browser.
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)


def _fetch(url: str, user_agent: str) -> bytes:
    import httpx

    headers = {"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"}
    with httpx.Client(timeout=20, headers=headers, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            _check_public_url(url)  # re-checked on every hop so a redirect can't reach the LAN
            with client.stream("GET", url) as res:
                if res.is_redirect:
                    url = str(res.url.join(res.headers["location"]))
                    continue
                if res.status_code >= 400:
                    raise PermissionError(res.status_code)
                ctype = res.headers.get("content-type", "")
                if "html" not in ctype and "text" not in ctype:
                    raise ValueError(f"That link is not a web page ({ctype or 'unknown type'})")
                body = bytearray()
                for chunk in res.iter_bytes():
                    body += chunk
                    if len(body) > MAX_WEB_BYTES:
                        raise ValueError("That page is too large")
                return bytes(body)
        raise ValueError("Too many redirects")


def fetch_html(url: str) -> bytes:
    """Raw bytes, so trafilatura can detect the page's charset itself."""
    status = None
    for agent in _USER_AGENTS:
        try:
            return _fetch(url, agent)
        except PermissionError as exc:
            status = exc.args[0]
            if status not in (401, 403, 429):
                break
    raise ValueError(f"The site returned an error (HTTP {status})")


def extract_web(url: str):
    import trafilatura

    html = fetch_html(url)
    text = trafilatura.extract(
        html, url=url, output_format="txt", include_comments=False, include_tables=False
    )
    if not text or not text.strip():
        raise ValueError(
            "No readable article text found. The page may need JavaScript or a login to show its content."
        )
    meta = trafilatura.extract_metadata(html, default_url=url)
    title = (meta.title if meta and meta.title else "").strip() or url
    author = (meta.author if meta and meta.author else "").strip()
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    return title, author, _paginate(paragraphs)


TEXT_TITLE_CHARS = 60


def extract_text(text: str, title: str = ""):
    """Pasted text -> (title, pages). Untitled pastes are named after their opening words."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if re.search(r"\n[ \t]*\n", text):
        # Blank lines separate paragraphs; single line breaks are hard wraps (e.g. copied from a PDF).
        paragraphs = _clean(text).split("\n\n")
    else:
        # No blank lines: each line is its own paragraph (e.g. copied from a web page).
        paragraphs = [re.sub(r"\s+", " ", l).strip() for l in text.split("\n")]
    paragraphs = [p for p in paragraphs if p]
    if not paragraphs:
        raise ValueError("There's no text to read")
    if not title:
        title = paragraphs[0]
        if len(title) > TEXT_TITLE_CHARS:
            title = title[:TEXT_TITLE_CHARS].rsplit(" ", 1)[0].rstrip(" ,.;:-") + "…"
    return title, _paginate(paragraphs)


def extract(path: Path):
    ext = path.suffix.lower()
    if ext == ".pdf":
        return "pdf", *extract_pdf(path)
    if ext == ".epub":
        return "epub", *extract_epub(path)
    raise ValueError("Only .pdf and .epub files are supported")
