"""
Resume text + hyperlink extraction for .pdf and .docx files, plus a cheap
regex pass that finds the candidate's emails and phone numbers (used to match
the resume to a Google Form response before spending any AI tokens).

PDF text comes from pdfium (C library, fast, low memory, releases the GIL),
so a big batch doesn't starve the web server. pdfplumber is used only to read
link annotations, which skips its slow layout analysis.
"""
import io
import re

import pdfplumber
import pypdfium2 as pdfium
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT


class UnsupportedResumeFormat(Exception):
    pass


# URLs written out in the resume text (not hyperlinked).
_URL_IN_TEXT = re.compile(
    r"(?:https?://|www\.)[^\s<>()\"']+|"
    r"\b(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|"
    r"leetcode\.com|hackerrank\.com|codechef\.com|codeforces\.com|kaggle\.com|"
    r"medium\.com|stackoverflow\.com)/[^\s<>()\"']+",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Runs of digits with the usual separators: +91 98765 43210, (987) 654-3210, 98765-43210
_PHONE = re.compile(r"\+?\d[\d\s().-]{8,}\d")


def extract(file_bytes: bytes, filename: str) -> dict:
    """Returns {"text": str, "links": [str]}; links are de-duplicated and
    include both clickable annotations and URLs written out in the text."""
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

    if ext == "pdf":
        text, links = _extract_pdf(file_bytes)
    elif ext == "docx":
        text, links = _extract_docx(file_bytes)
    else:
        raise UnsupportedResumeFormat(
            f"'{filename}' is a .{ext} file - only .pdf and .docx resumes are supported."
        )

    links.extend(m.group(0).rstrip(".,;:") for m in _URL_IN_TEXT.finditer(text))
    return {"text": text, "links": _dedupe_links(links)}


def extract_text(file_bytes: bytes, filename: str) -> str:
    return extract(file_bytes, filename)["text"]


def build_ai_input(parsed: dict) -> str:
    """Text for the AI, with every link appended in its own section so hidden
    URLs are visible to the model."""
    text = parsed["text"]
    if parsed["links"]:
        text += "\n\n--- HYPERLINKS FOUND IN THE DOCUMENT (including hidden clickable links) ---\n"
        text += "\n".join(parsed["links"])
    return text


def normalise_phone(value) -> str:
    """Last 10 digits, the part that identifies an Indian mobile whatever
    prefix was written (+91, 0, 91). '' when there aren't enough digits."""
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[-10:] if len(digits) >= 10 else ""


def find_contacts(parsed: dict) -> dict:
    """Every email and phone number on the resume, no AI involved.
    {"emails": [lowercase], "phones": [last 10 digits]}"""
    text = parsed.get("text") or ""
    emails = [e.lower().rstrip(".") for e in _EMAIL.findall(text)]
    emails += [l[7:].lower() for l in parsed.get("links") or [] if l.lower().startswith("mailto:")]
    phones = [normalise_phone(p) for p in _PHONE.findall(text)]
    # Years ("2019 - 2023") and dates also look like digit runs; a real mobile
    # has 10+ digits once separators are gone, which normalise_phone enforces.
    return {"emails": list(dict.fromkeys(e for e in emails if e)),
            "phones": list(dict.fromkeys(p for p in phones if p))}


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def render_pdf_pages(file_bytes: bytes, max_pages: int = 3) -> list[bytes]:
    """JPEG images of the first pages, for AI OCR of scanned / photographed resumes."""
    out = []
    pdf = pdfium.PdfDocument(file_bytes)
    try:
        for i in range(min(len(pdf), max_pages)):
            page = pdf[i]
            try:
                w, h = page.get_size()
                scale = min(2.0, 1600 / max(w, h, 1))  # ~1600px on the long side: readable, few tokens
                img = page.render(scale=scale).to_pil().convert("RGB")
            finally:
                page.close()
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=85)
            out.append(buf.getvalue())
    finally:
        pdf.close()
    return out


def images_to_pdf(images: list[bytes]) -> bytes:
    """Phone photos of a printed resume (one per page) -> one PDF. Rotation
    from the camera is applied and pages are scaled to ~2000px."""
    from PIL import Image, ImageOps

    pages = []
    for raw in images:
        try:
            img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        except Exception:
            raise UnsupportedResumeFormat("One of the photos couldn't be opened - use JPG or PNG.")
        img.thumbnail((2000, 2000))
        pages.append(img)
    if not pages:
        raise UnsupportedResumeFormat("No photos were given.")
    buf = io.BytesIO()
    pages[0].save(buf, "PDF", save_all=True, append_images=pages[1:], resolution=150)
    return buf.getvalue()


def _extract_pdf(file_bytes: bytes) -> tuple[str, list]:
    text_parts = []
    pdf = pdfium.PdfDocument(file_bytes)
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            textpage = page.get_textpage()
            try:
                text_parts.append(textpage.get_text_range() or "")
            finally:
                textpage.close()
                page.close()
    finally:
        pdf.close()
    text = "\n".join(text_parts).replace("\r\n", "\n").replace("\r", "\n").strip()

    links = []
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as doc:
            for page in doc.pages:
                for link in page.hyperlinks or []:
                    if link.get("uri"):
                        links.append(link["uri"])
                page.close()
    except Exception:
        pass  # links are a bonus; the text above is what matters
    return text, links


def _extract_docx(file_bytes: bytes) -> tuple[str, list]:
    doc = Document(io.BytesIO(file_bytes))
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                if cell.text:
                    parts.append(cell.text)
    for section in doc.sections:
        for part in (section.header, section.footer):
            parts.extend(p.text for p in part.paragraphs if p.text)

    links = [
        rel.target_ref
        for rel in doc.part.rels.values()
        if rel.reltype == RT.HYPERLINK and rel.is_external
    ]
    return "\n".join(parts).strip(), links


def _dedupe_links(links: list) -> list:
    seen, out = set(), []
    for link in links:
        link = (link or "").strip()
        if not link:
            continue
        key = re.sub(r"^(https?://)?(www\.)?", "", link.lower()).rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        out.append(link)
    return out
