"""Shape detectors for document_tables rows.

Each detector is a pure function over the headers + caption + rows of a
single document_tables row. Returns a Shape enum value if confident, or
None. The transformer runs all detectors in order; first hit wins.
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any


class Shape(str, Enum):
    PER_ZONE_DIMENSIONAL = "per_zone_dimensional"
    UNKNOWN = "unknown"


@dataclass
class Detection:
    shape: Shape
    confidence: str  # "high" | "medium" | "low"
    reason: str


def detect_shape(table_row: dict[str, Any]) -> Detection:
    """Dispatch to detectors. First hit wins; falls through to UNKNOWN."""
    for detector in (_detect_per_zone_dimensional,):
        result = detector(table_row)
        if result is not None:
            return result
    return Detection(Shape.UNKNOWN, "low", "no detector matched")


def _detect_per_zone_dimensional(table_row: dict[str, Any]) -> Detection | None:
    """Per-zone dimensional table.

    Signature:
      - 3-column structure (parser-confirmed; we don't trust this strictly)
      - headers[0] is the empty/label column
      - headers[1] is "District area (minimum)" or similar zone identifier
      - headers[2] is the zone-area value (e.g. "10 ac.")
      - rows have label_path entries from a small known vocabulary

    A more robust check: at least 30% of rows have a label_path whose
    first element starts with "Setbacks", "Lot", "Height", or "Other".
    """
    headers = table_row.get("headers") or []
    rows = table_row.get("rows") or []

    if len(headers) < 2 or len(rows) == 0:
        return None

    # The CS UDC per-zone dimensional shape uses these category prefixes.
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
