"""
Page-aware prose chunker.

Walks pdfplumber pages and emits chunks of ~CHUNK_TOKENS tokens with
~CHUNK_OVERLAP tokens of overlap. Skips text that falls inside detected
table bounding boxes — those are already in document_tables; embedding
them again would dilute prose-vs-table retrieval.

Token counting is approximate (chars/4) — we don't need a tokenizer for
chunk sizing at this scale, and avoiding tiktoken keeps the dep tree
small.

Each chunk's page_number is the page where the chunk's FIRST character
originated. We track per-character page provenance through the buffer
so overlap and flushing don't corrupt the page tag.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Iterable

import pdfplumber

CHUNK_TOKENS = 500
CHUNK_OVERLAP = 50
CHARS_PER_TOKEN = 4  # rough approx for English prose

_SECTION_RE = re.compile(r"(?:§\s*|Section\s+)([\d]+\.[\d.]+)", re.IGNORECASE)


@dataclass
class Chunk:
    chunk_index: int
    page_number: int
    section_ref: str | None
    text: str
    token_count: int


def _bbox_contains(table_bbox: tuple, x: float, y: float) -> bool:
    x0, top, x1, bottom = table_bbox
    return x0 <= x <= x1 and top <= y <= bottom


def _extract_prose_by_page(pdf_path: str) -> Iterable[tuple[int, str]]:
    """Yield (page_number, prose_text) per page, with text inside detected
    table bboxes removed (word-level filter)."""
    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            page_num = page_idx + 1
            table_bboxes = [t.bbox for t in page.find_tables()]
            if not table_bboxes:
                yield page_num, page.extract_text() or ""
                continue
            words = page.extract_words()
            keep = []
            for w in words:
                cx = (w["x0"] + w["x1"]) / 2
                cy = (w["top"] + w["bottom"]) / 2
                if any(_bbox_contains(bb, cx, cy) for bb in table_bboxes):
                    continue
                keep.append(w)
            if not keep:
                yield page_num, ""
                continue
            keep.sort(key=lambda w: (round(w["top"]), w["x0"]))
            lines: list[list[str]] = []
            current_top = None
            current_line: list[str] = []
            for w in keep:
                t = round(w["top"])
                if current_top is None or abs(t - current_top) > 2:
                    if current_line:
                        lines.append(current_line)
                    current_line = [w["text"]]
                    current_top = t
                else:
                    current_line.append(w["text"])
            if current_line:
                lines.append(current_line)
            yield page_num, "\n".join(" ".join(line) for line in lines)


def _detect_section_ref(text: str) -> str | None:
    m = _SECTION_RE.search(text[:300])
    return m.group(1) if m else None


def chunk_document(pdf_path: str) -> list[Chunk]:
    """Walk the PDF, accumulate prose, emit chunks with correct page tags.

    Implementation: maintain TWO parallel arrays — `buffer` (str) and
    `pages` (list[int]), where pages[i] is the source page of buffer[i].
    Flushing slices both arrays in lockstep, so each chunk's reported
    page_number is the page where its first character actually came from.
    """
    chunk_chars = CHUNK_TOKENS * CHARS_PER_TOKEN
    overlap_chars = CHUNK_OVERLAP * CHARS_PER_TOKEN

    chunks: list[Chunk] = []
    buffer: list[str] = []   # one char per slot
    pages: list[int] = []    # source page for each buffer char

    def append_text(text: str, page_num: int) -> None:
        if buffer:
            buffer.extend("\n\n")
            pages.extend([page_num, page_num])
        buffer.extend(text)
        pages.extend([page_num] * len(text))

    def flush_one(min_size: int) -> bool:
        """Emit one chunk if the buffer has >= min_size chars. Returns True
        if a chunk was emitted."""
        if len(buffer) < min_size:
            return False
        piece = "".join(buffer[:chunk_chars]).rstrip()
        if not piece:
            del buffer[:chunk_chars]
            del pages[:chunk_chars]
            return False
        page_number = pages[0] if pages else 1
        chunks.append(Chunk(
            chunk_index=len(chunks),
            page_number=page_number,
            section_ref=_detect_section_ref(piece),
            text=piece,
            token_count=max(1, len(piece) // CHARS_PER_TOKEN),
        ))
        advance = max(1, chunk_chars - overlap_chars)
        del buffer[:advance]
        del pages[:advance]
        return True

    for page_num, prose in _extract_prose_by_page(pdf_path):
        if not prose.strip():
            continue
        append_text(prose, page_num)
        # Emit as many full-sized chunks as the buffer supports.
        while flush_one(chunk_chars):
            pass

    # Final partial chunk: emit if substantial (≥ overlap).
    flush_one(overlap_chars)
    return chunks
