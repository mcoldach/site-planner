"""
Base strategy + generic defaults.

A strategy provides five overridable behaviors:

  table_settings()      pdfplumber tuning per publisher.
  detect_metadata()     Pull table_number + caption from row 0 (or wherever).
  find_header_row()     Index + values of the header row.
  classify_row()        Tag a row as 'header_repeat' | 'section' | 'data'.
  is_continuation_of()  True if THIS table is a continuation of a PRIOR one.

Cell value parsing is shared (parse_cell) — it works on the textual content
of a cell and is unit/footnote aware. Strategies typically don't override it.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Any, Literal


# ---- Cell parser ---------------------------------------------------------

_FOOTNOTE_RE = re.compile(r"\[(\d+)\]")
# Matches a leading number (with thousands commas and optional decimals)
# followed optionally by a unit fragment. Captures (number, unit).
_NUM_UNIT_RE = re.compile(
    r"^\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*(.*?)\s*$"
)


def parse_cell(raw: str | None) -> dict[str, Any]:
    """Return a structured cell dict matching the schema's cell shape.

    Keys: value, unit, raw_text, footnotes, parse_status.
    parse_status: 'empty' | 'not_applicable' | 'numeric' | 'non_numeric'.
    """
    raw_text = raw if isinstance(raw, str) else ""
    if raw is None or raw_text.strip() == "":
        return {
            "value": None, "unit": None, "raw_text": raw_text,
            "footnotes": [], "parse_status": "empty",
        }

    # Strip footnote refs from the working text but preserve them.
    footnotes = [int(m) for m in _FOOTNOTE_RE.findall(raw_text)]
    work = _FOOTNOTE_RE.sub("", raw_text)
    # Collapse internal newlines to single spaces (cells frequently wrap).
    work = re.sub(r"\s+", " ", work).strip()

    # N/A in all its forms.
    if work.upper() in {"N/A", "NA", "N.A.", "—", "-"}:
        return {
            "value": None, "unit": None, "raw_text": raw_text,
            "footnotes": footnotes, "parse_status": "not_applicable",
        }

    m = _NUM_UNIT_RE.match(work)
    if m:
        num_str, unit = m.group(1), (m.group(2) or "").strip() or None
        # parse the number — strip commas
        try:
            value: Any = float(num_str.replace(",", ""))
            # int if whole number
            if value.is_integer():
                value = int(value)
        except ValueError:
            value = num_str
        return {
            "value": value, "unit": unit, "raw_text": raw_text,
            "footnotes": footnotes, "parse_status": "numeric",
        }

    # Non-numeric: prose cell, use-permission code ('P'/'C'/'R'), etc.
    return {
        "value": work, "unit": None, "raw_text": raw_text,
        "footnotes": footnotes, "parse_status": "non_numeric",
    }


# ---- Strategy types ------------------------------------------------------

@dataclass
class TableMeta:
    """What detect_metadata returns."""
    table_number: str | None
    caption: str | None
    legend: str | None     # the rest of row 0 (DU=Dwelling Unit etc.) if present


@dataclass
class TableSettings:
    """Subset of pdfplumber table_settings most likely to vary per publisher."""
    vertical_strategy: str = "lines"
    horizontal_strategy: str = "lines"
    snap_tolerance: int = 3
    join_tolerance: int = 3
    intersection_tolerance: int = 3

    def as_kwargs(self) -> dict[str, Any]:
        return {
            "vertical_strategy": self.vertical_strategy,
            "horizontal_strategy": self.horizontal_strategy,
            "snap_tolerance": self.snap_tolerance,
            "join_tolerance": self.join_tolerance,
            "intersection_tolerance": self.intersection_tolerance,
        }


RowKind = Literal["header_repeat", "header", "section", "data", "metadata"]


# ---- Generic strategy ----------------------------------------------------

class Strategy:
    """Abstract — every concrete strategy provides these."""
    name: str = "abstract"

    def table_settings(self) -> TableSettings:
        raise NotImplementedError

    def detect_metadata(self, rows: list[list]) -> TableMeta:
        raise NotImplementedError

    def find_header_row(self, rows: list[list]) -> tuple[int, list[str]] | None:
        raise NotImplementedError

    def classify_row(self, row: list, header_row: list[str] | None,
                     row0: list, header_row_values: list[str] | None) -> RowKind:
        raise NotImplementedError

    def is_continuation_of(self, this_meta: TableMeta, prior_meta: TableMeta) -> bool:
        raise NotImplementedError


class GenericStrategy(Strategy):
    """Defaults that work on most well-structured zoning tables."""
    name = "generic"

    def table_settings(self) -> TableSettings:
        return TableSettings()  # pdfplumber defaults

    def detect_metadata(self, rows: list[list]) -> TableMeta:
        # Default: assume row 0's first cell holds the table title block, with
        # the table-number on the first newline-separated line.
        if not rows or not rows[0]:
            return TableMeta(None, None, None)
        first = rows[0][0]
        if not isinstance(first, str):
            return TableMeta(None, None, None)
        lines = [ln.strip() for ln in first.split("\n") if ln.strip()]
        if not lines:
            return TableMeta(None, None, None)
        # "Table X.Y.Z-A" or "Table X.Y" — capture the suffix conservatively
        m = re.match(r"Table\s+([\d.]+-?[A-Z]?)\s*$", lines[0], re.IGNORECASE)
        if m:
            table_number = m.group(1)
            caption = lines[1] if len(lines) > 1 else None
            legend = "\n".join(lines[2:]) if len(lines) > 2 else None
            return TableMeta(table_number, caption, legend)
        return TableMeta(None, lines[0] if lines else None, None)

    def find_header_row(self, rows: list[list]) -> tuple[int, list[str]] | None:
        # First row after row 0 where >=2 cells are non-empty strings.
        for idx in range(1, min(6, len(rows))):
            r = rows[idx]
            non_empty = [c for c in r if isinstance(c, str) and c.strip()]
            if len(non_empty) >= 2:
                return idx, [str(c).strip() if c else "" for c in r]
        return None

    def classify_row(self, row: list, header_row: list[str] | None,
                     row0: list, header_row_values: list[str] | None) -> RowKind:
        # 'header_repeat': matches row 0 or the header row exactly.
        if row == row0:
            return "header_repeat"
        if header_row_values is not None and row == header_row_values:
            return "header_repeat"
        # Compare with normalization too (some repeats have small whitespace diffs)
        if header_row_values is not None:
            norm_row = [(c or "").strip() if isinstance(c, str) else "" for c in row]
            if norm_row == [(c or "").strip() for c in header_row_values]:
                return "header_repeat"
        # 'section': col 0 has content, all other cells are blank/None.
        if isinstance(row[0], str) and row[0].strip():
            rest = row[1:]
            if all(c is None or (isinstance(c, str) and c.strip() == "") for c in rest):
                return "section"
            return "data"
        return "data"  # data row even if col 0 is blank (rare but possible)

    def is_continuation_of(self, this_meta: TableMeta, prior_meta: TableMeta) -> bool:
        # Continuation iff both have a table_number and they match.
        if not this_meta.table_number or not prior_meta.table_number:
            return False
        return this_meta.table_number == prior_meta.table_number
