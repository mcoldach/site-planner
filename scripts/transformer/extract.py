"""Per-shape extractors. Convert detected-shape document_tables rows into
neutral RawExtraction tuples that the mapper can act on."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
import re

from detect import Shape, _clean_header_zone, _is_simple_zone


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
    notes: str | None = None   # qualifier text split out of a polluted unit (§8.8)
    shape: str = ""            # detected shape; the mapper resolves per-shape
    denominator: float | None = None       # ratio denominator (e.g. 1000 GFA)
    denominator_unit: str | None = None     # ratio denominator unit (e.g. "sf")
    basis: str | None = None                 # ratio basis (e.g. "GFA")


_ZONE_RE = re.compile(r"^\s*([^:]+?)\s*:")
_QUALIFIER_MARKERS = (" or ", "average", "whichever")
_PER_USE_DENOM_RE = re.compile(r"per\s+([\d,]+)\s+(\w+)", re.IGNORECASE)


def extract_zone_from_caption(caption: str | None) -> str | None:
    if not caption:
        return None
    m = _ZONE_RE.match(caption)
    if m:
        return m.group(1).strip()
    return None


def _split_unit_qualifier(unit: str | None) -> tuple[str | None, str | None]:
    """The parser sometimes packs a prose qualifier into the unit field, e.g.
    'ft or average of two adjacent ... whichever is less'. Keep the leading
    unit token; return the full original text as a note. Per rule_keys.md §8.8
    the number is stored with the clean unit; the qualifier lives in notes."""
    if not unit:
        return unit, None
    low = unit.lower()
    if any(m in low for m in _QUALIFIER_MARKERS):
        clean = unit.split(" or ")[0].strip()
        return (clean or None), unit.strip()
    return unit, None


def extract(shape: Shape, table_row: dict[str, Any]) -> list[RawExtraction]:
    if shape == Shape.PER_ZONE_DIMENSIONAL:
        result = _extract_per_zone_dimensional(table_row)
    elif shape == Shape.PER_ZONE_MATRIX:
        result = _extract_per_zone_matrix(table_row)
    elif shape == Shape.PER_USE_RATIO:
        result = _extract_per_use_ratio(table_row)
    else:
        result = []
    # Single assignment point: stamp the shape so the mapper can resolve
    # against the right vocabulary block.
    for ex in result:
        ex.shape = shape.value
    return result


def _extract_per_zone_matrix(table_row: dict[str, Any]) -> list[RawExtraction]:
    """One RawExtraction per (zone-column, metric-row) cell that carries a
    value. Row identity is label_path[-1]; the full label_path is passed
    through untouched (the mapper resolves it — we never try to repair the
    parser's nesting here). Cells with parse_status not_applicable/empty are
    skipped. Zone comes from cell['column']; non-simple zone columns (compound
    use-class headers, blank columns) are skipped, which defers those tables
    cleanly without per-table special-casing."""
    rows = table_row.get("rows") or []
    table_id = table_row.get("id")
    table_number = table_row.get("table_number")
    section_ref = f"UDC §{table_number}" if table_number else "unknown"

    extractions: list[RawExtraction] = []
    for idx, row in enumerate(rows):
        label_path = row.get("label_path") or []
        if not label_path:                      # 7.4.2-D parser artifacts
            continue
        row_label = str(label_path[-1])
        cells = row.get("cells") or []

        for cell in cells:
            status = cell.get("parse_status")
            if status not in ("numeric", "non_numeric"):
                continue
            zone = _clean_header_zone(cell.get("column"))
            if not _is_simple_zone(zone):        # defers 7.4.2-B compound cols
                continue
            unit, note = _split_unit_qualifier(cell.get("unit"))
            extractions.append(RawExtraction(
                document_table_id=table_id,
                table_number=table_number,
                section_ref=section_ref,
                label_path=label_path,
                row_label=row_label,
                value=cell.get("value"),
                unit=unit,
                parse_status=status,
                footnotes=cell.get("footnotes") or [],
                zone=zone,
                row_index=idx,
                notes=note,
            ))

    return extractions


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


def _extract_per_use_ratio(table_row: dict[str, Any]) -> list[RawExtraction]:
    """One RawExtraction per use-category row of a parking-ratio-by-use table
    (CS UDC 7.4.10-E). The denominator + unit + basis are parsed ONCE from
    headers[1] (e.g. "Min. Spaces per 1,000 GFA"): the numeric value is the
    per-row numerator, the header supplies the shared denominator. Parking
    ratios are jurisdiction-wide, so zone is always None (rule_keys.md §8.5).

    Numeric rows carry the ratio fields; a non-numeric row (e.g. "Other → As
    determined by the Manager") is emitted with parse_status='non_numeric' and
    NO ratio fields, so build routes it to the existing prose_deferred path.
    """
    headers = table_row.get("headers") or []
    rows = table_row.get("rows") or []
    table_id = table_row.get("id")
    table_number = table_row.get("table_number")
    section_ref = f"UDC §{table_number}" if table_number else "unknown"

    header_text = str(headers[1]) if len(headers) > 1 else ""
    denominator: float | None = None
    denominator_unit: str | None = None
    basis: str | None = None
    m = _PER_USE_DENOM_RE.search(header_text)
    if m:
        denominator = int(m.group(1).replace(",", ""))
        unit_token = m.group(2)
        # GFA is an area in square feet (rule_keys.md §8.5):
        # {"denominator_unit":"sf","basis":"GFA"}.
        if unit_token.upper() == "GFA":
            denominator_unit = "sf"
            basis = "GFA"
        else:
            denominator_unit = unit_token

    extractions: list[RawExtraction] = []
    for idx, row in enumerate(rows):
        label_path = row.get("label_path") or []
        if not label_path:
            continue
        row_label = str(label_path[0])
        cells = row.get("cells") or []
        if not cells:
            continue
        cell = cells[0]
        status = cell.get("parse_status")

        if status == "numeric":
            extractions.append(RawExtraction(
                document_table_id=table_id,
                table_number=table_number,
                section_ref=section_ref,
                label_path=label_path,
                row_label=row_label,
                value=cell.get("value"),          # the numerator
                unit=cell.get("unit"),
                parse_status="numeric",
                footnotes=cell.get("footnotes") or [],
                zone=None,
                row_index=idx,
                notes=header_text or None,        # provenance: literal header
                denominator=denominator,
                denominator_unit=denominator_unit,
                basis=basis,
            ))
        elif status == "non_numeric":
            extractions.append(RawExtraction(
                document_table_id=table_id,
                table_number=table_number,
                section_ref=section_ref,
                label_path=label_path,
                row_label=row_label,
                value=cell.get("value"),
                unit=cell.get("unit"),
                parse_status="non_numeric",
                footnotes=cell.get("footnotes") or [],
                zone=None,
                row_index=idx,
            ))

    return extractions
