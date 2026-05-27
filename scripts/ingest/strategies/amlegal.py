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
from .base import GenericStrategy, TableMeta


_TABLE_NUM_RE = re.compile(r"Table\s+([\d.]+-?[A-Z0-9]{0,3})\s*$", re.IGNORECASE)


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
