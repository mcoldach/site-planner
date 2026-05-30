"""Per-shape extractors. Convert detected-shape document_tables rows into
neutral RawExtraction tuples that the mapper can act on."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
import re

from detect import Shape


@dataclass
class RawExtraction:
    document_table_id: str
    table_number: str | None
    section_ref: str
    label_path: list[str]
    row_label: str | None
    value: Any
    unit: str | None
    parse_status: str
    footnotes: list = field(default_factory=list)
    zone: str | None = None
    row_index: int = -1


_ZONE_RE = re.compile(r"^\s*([^:]+?)\s*:")


def extract_zone_from_caption(caption: str | None) -> str | None:
    if not caption:
        return None
    m = _ZONE_RE.match(caption)
    if m:
        return m.group(1).strip()
    return None


def extract(shape: Shape, table_row: dict[str, Any]) -> list[RawExtraction]:
    if shape == Shape.PER_ZONE_DIMENSIONAL:
        return _extract_per_zone_dimensional(table_row)
    return []


def _extract_per_zone_dimensional(table_row: dict[str, Any]) -> list[RawExtraction]:
    rows = table_row.get("rows") or []
    table_id = table_row.get("id")
    table_number = table_row.get("table_number")
    caption = table_row.get("caption")
    zone = extract_zone_from_caption(caption)
    section_ref = f"UDC §{table_number}" if table_number else "unknown"

    extractions: list[RawExtraction] = []
    for idx, row in enumerate(rows):
        cells = row.get("cells") or []
        if len(cells) < 2:
            continue

        label_cell = cells[0]
        value_cell = cells[1]

        row_label = label_cell.get("value")
        if not isinstance(row_label, str):
            continue

        status = value_cell.get("parse_status")
        if status in ("not_applicable", "empty"):
            continue

        extractions.append(RawExtraction(
            document_table_id=table_id,
            table_number=table_number,
            section_ref=section_ref,
            label_path=row.get("label_path") or [],
            row_label=row_label,
            value=value_cell.get("value"),
            unit=value_cell.get("unit"),
            parse_status=status,
            footnotes=value_cell.get("footnotes") or [],
            zone=zone,
            row_index=idx,
        ))

    return extractions
