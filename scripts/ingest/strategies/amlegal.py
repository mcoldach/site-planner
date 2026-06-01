"""
American Legal Publishing strategy.

What we observed in CS City Code (the real document):
  - Row 0's first cell contains the table title block (table_number + caption
    + legend), separated by newlines. Generic's detect_metadata works.
  - Header row is row 1.
  - Tables that span pages REPEAT row 0 and row 1 inside pdfplumber's output
    (we saw this in Table 7.4.2-A's rows 0+2 and 1+3). Generic's classify_row
    handles this via header_repeat detection.
  - Section headers ('Lot Standards', 'Setbacks') are col-0-only rows.
  - The table-number regex needs to be slightly more permissive: AmLegal
    sometimes appends two letters (e.g. '7.3.303B'), or just a single letter.
"""
from __future__ import annotations
import re
from .base import GenericStrategy, TableMeta, parse_cell


_TABLE_NUM_RE = re.compile(r"Table\s+([\d.]+-?[A-Z0-9]{0,3})\s*$", re.IGNORECASE)
# Short CS UDC zone-district column labels (7.4.2-A matrix headers), not rule names.
_ZONE_CODE_RE = re.compile(
    r"^(A|R-E|R-\d|R-\d \d|PUD|OR|MX-[A-Z]|BP|LI|OC|C-\d|M-\d)$"
)


class AmLegalStrategy(GenericStrategy):
    name = "amlegal"

    def detect_metadata(self, rows):
        if not rows or not rows[0] or not isinstance(rows[0][0], str):
            return TableMeta(None, None, None)
        lines = [ln.strip() for ln in rows[0][0].split("\n") if ln.strip()]
        if not lines:
            return TableMeta(None, None, None)
        m = _TABLE_NUM_RE.match(lines[0])
        if m:
            return TableMeta(
                table_number=m.group(1),
                caption=lines[1] if len(lines) > 1 else None,
                legend="\n".join(lines[2:]) if len(lines) > 2 else None,
            )
        return TableMeta(None, lines[0], None)

    def find_header_row(self, rows: list[list]) -> tuple[int, list[str]] | None:
        """K fix: transposed KV header + headerless dimensional detect.

        Per-zone dimensional tables (7.2.2-*, 7.2.3-*, 7.2.4-*) are 3-column
        key-value rows with no column-header row; GenericStrategy would promote
        the first data row to headers. Return None so parse_tables keeps col_N
        names and preserves the first rule row.
        """
        if self._is_transposed_kv_table(rows):
            return None
        return super().find_header_row(rows)

    def is_intentionally_headerless(self, rows: list[list]) -> bool:
        """True when find_header_row returns None by design (transposed KV table)."""
        return self._is_transposed_kv_table(rows)

    @staticmethod
    def _ncols(rows: list[list]) -> int:
        return max((len(r) for r in rows), default=0)

    @classmethod
    def _row_has_zone_code_header_cells(cls, row: list) -> bool:
        """True when cells[1:] look like a matrix of zone-district column labels."""
        if len(row) < 3:
            return False
        vals = [
            str(c).strip()
            for c in row[1:]
            if isinstance(c, str) and c.strip()
        ]
        if len(vals) < 2:
            return False
        zone_hits = sum(1 for v in vals if _ZONE_CODE_RE.match(v))
        return zone_hits >= 2

    @classmethod
    def _is_transposed_kv_table(cls, rows: list[list]) -> bool:
        if cls._ncols(rows) != 3:
            return False
        if any(cls._row_has_zone_code_header_cells(r) for r in rows):
            return False
        good = 0
        total = 0
        for r in rows:
            if len(r) < 3:
                continue
            c1 = parse_cell(r[1] if isinstance(r[1], str) else None)
            c2 = parse_cell(r[2] if isinstance(r[2], str) else None)
            if c1["parse_status"] in ("non_numeric", "empty") and c2["parse_status"] != "empty":
                good += 1
            total += 1
        return total >= 2 and good >= max(2, total * 0.5)
