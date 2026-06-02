"""Shape detectors for document_tables rows.

Each detector is a pure function over the headers + caption + rows of a
single document_tables row. Returns a Detection if confident, or None.
detect_shape runs detectors in order; first hit wins.

NOTE on ordering: per-zone-matrix MUST be checked before per-zone-dimensional.
The dimensional detector keys on label_path[0] category prefixes, which the
matrix tables also satisfy (their rows are Lot/Setbacks/Height/Other too), so
dimensional would otherwise claim the matrix tables first and extract nothing.
Matrix uses a precise headers[0]=="Zone District" signature that the genuine
dimensional tables (empty/label header[0]) do not match.
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any
import re


class Shape(str, Enum):
    PER_ZONE_DIMENSIONAL = "per_zone_dimensional"
    PER_ZONE_MATRIX = "per_zone_matrix"
    PER_USE_RATIO = "per_use_ratio"
    PER_USE_LOADING = "per_use_loading"
    UNKNOWN = "unknown"


@dataclass
class Detection:
    shape: Shape
    confidence: str  # "high" | "medium" | "low"
    reason: str


def _norm(s: Any) -> str:
    return " ".join(str(s or "").lower().split())


_FOOTNOTE_RE = re.compile(r"\s*\[\d+\]")
_SIMPLE_ZONE_RE = re.compile(r"[A-Z0-9][A-Z0-9 \-]*")
_PER_USE_HEADER_RE = re.compile(r"per\s+[\d,]+\s+\w+", re.IGNORECASE)
_PER_USE_LABELS = {"use", "use type", "use category"}


def _clean_header_zone(s: Any) -> str:
    out = _FOOTNOTE_RE.sub("", str(s or ""))
    return " ".join(out.replace("\n", " ").split()).strip()


def _is_simple_zone(z: str) -> bool:
    """Short, all-caps/digit/hyphen code. Rejects compound use-class columns
    like 'R-Flex Low Residential Uses' (deferred shape)."""
    if not z or len(z) > 10:
        return False
    return _SIMPLE_ZONE_RE.fullmatch(z) is not None


def detect_shape(table_row: dict[str, Any]) -> Detection:
    """Dispatch to detectors. First hit wins; falls through to UNKNOWN."""
    # Loading's precise cell signature must precede dimensional's broad
    # label_path heuristic, mirroring matrix-before-dimensional precedence.
    for detector in (_detect_per_zone_matrix, _detect_per_use_ratio,
                     _detect_loading_ratio, _detect_per_zone_dimensional):
        result = detector(table_row)
        if result is not None:
            return result
    return Detection(Shape.UNKNOWN, "low", "no detector matched")


def _detect_per_zone_matrix(table_row: dict[str, Any]) -> Detection | None:
    """Per-zone matrix table.

    Signature:
      - headers[0] normalizes to "zone district"
      - >= 3 columns total
    Confidence reflects how many of headers[1:] are simple zone codes. A
    table with the right header[0] but no simple zone columns (e.g. 7.4.2-B's
    compound 'R-Flex Low Residential Uses' columns) is still claimed as matrix
    so the dimensional detector can't grab it — the extractor then defers it
    by emitting nothing for non-simple zone columns.
    """
    headers = table_row.get("headers") or []
    rows = table_row.get("rows") or []
    if len(headers) < 3 or len(rows) == 0:
        return None
    if _norm(headers[0]) != "zone district":
        return None

    simple = sum(1 for h in headers[1:] if _is_simple_zone(_clean_header_zone(h)))
    if simple >= 2:
        return Detection(Shape.PER_ZONE_MATRIX, "high",
                         f"headers[0]='Zone District'; {simple} simple zone columns")
    return Detection(Shape.PER_ZONE_MATRIX, "low",
                     "headers[0]='Zone District' but no simple zone columns "
                     "(compound headers?) — extractor will defer")


def _detect_per_zone_dimensional(table_row: dict[str, Any]) -> Detection | None:
    """Per-zone dimensional table.

    K fix: transposed KV header + headerless dimensional detect.

    Signature is label_path category prefixes (Setbacks/Lot/Height/Other), not
    column headers — headerless 7.2.x tables have headers == [] after ingest.

    Robust check: at least 30% of rows have a label_path whose first element
    starts with "Setbacks", "Lot", "Height", or "Other".
    """
    rows = table_row.get("rows") or []

    if len(rows) == 0:
        return None

    expected_category_prefixes = ("Setbacks", "Lot", "Height", "Other")
    matching = 0
    total_with_label = 0
    for r in rows:
        lp = r.get("label_path")
        if not lp or not isinstance(lp, list) or not lp:
            continue
        total_with_label += 1
        first = str(lp[0])
        if first.startswith(expected_category_prefixes):
            matching += 1

    if total_with_label == 0:
        return None
    ratio = matching / total_with_label
    if ratio >= 0.5:
        return Detection(Shape.PER_ZONE_DIMENSIONAL, "high",
                         f"{matching}/{total_with_label} rows match expected categories")
    if ratio >= 0.3:
        return Detection(Shape.PER_ZONE_DIMENSIONAL, "medium",
                         f"{matching}/{total_with_label} rows match expected categories")
    return None


def _detect_per_use_ratio(table_row: dict[str, Any]) -> Detection | None:
    """Per-use ratio table (CS UDC 7.4.10-E parking-by-use).

    Signature:
      - headers[0] normalizes to one of "use" / "use type" / "use category"
      - headers[1] carries a 'per N unit' ratio basis, e.g. "Min. Spaces
        per 1,000 GFA" (regex r"per\\s+[\\d,]+\\s+\\w+", case-insensitive)

    Registered LAST so it can never poach a matrix/dimensional table — those
    detectors get first refusal on their own signatures.
    """
    headers = table_row.get("headers") or []
    rows = table_row.get("rows") or []
    if len(headers) < 2 or len(rows) == 0:
        return None
    if _norm(headers[0]) not in _PER_USE_LABELS:
        return None
    if not _PER_USE_HEADER_RE.search(str(headers[1] or "")):
        return None
    return Detection(Shape.PER_USE_RATIO, "high",
                     f"headers[0]={headers[0]!r}; ratio basis header {headers[1]!r}")


def _detect_loading_ratio(table_row: dict[str, Any]) -> Detection | None:
    """Per-use loading ratio table (CS UDC 7.4.10-G off-street loading).

    Signature:
      - any cell value/raw_text normalizes to "required loading spaces"

    Registered after the existing detectors so matrix, dimensional, and
    per-use-ratio shapes keep first refusal on their signatures.
    """
    for row in table_row.get("rows") or []:
        for cell in row.get("cells") or []:
            if (_norm(cell.get("value")) == "required loading spaces" or
                    _norm(cell.get("raw_text")) == "required loading spaces"):
                return Detection(Shape.PER_USE_LOADING, "high",
                                 "cell 'Required Loading Spaces' present")
    return None
