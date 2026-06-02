"""
Step 3c — Parse all tables in a document and write document_tables rows.

Usage:
    python parse_tables.py <document_id> [--dry-run]

Idempotent: deletes existing document_tables rows for this document and
re-inserts. Re-run after strategy improvements without re-uploading.

Flow:
  1. Download PDF from Storage.
  2. Detect strategy from first-page text.
  3. Walk every page, extract tables via the strategy's table_settings.
  4. For each detected pdfplumber table:
       - Parse metadata (table_number, caption, legend).
       - Find header row.
       - Walk data rows, maintaining a label_path stack.
       - Build rich JSONB: headers + rows[].label_path + cells[].
  5. Merge continuation tables (same table_number, consecutive pages).
  6. Compute parser_confidence + warnings per logical table.
  7. Write to document_tables; update documents.parser_strategy +
     ingest_status='ingested' (or 'failed' on exception).
"""
from __future__ import annotations
import os
import sys
import json
import argparse
import tempfile
import traceback
from typing import Any
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy, REGISTRY
from strategies.base import parse_cell, TableMeta, Strategy

load_dotenv()
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("doc_id")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + print summary, but don't write to DB")
    args = ap.parse_args()

    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    doc = sb.table("documents").select(
        "id, filename, storage_path, title"
    ).eq("id", args.doc_id).maybe_single().execute().data
    if doc is None:
        print(f"no documents row with id {args.doc_id}", file=sys.stderr)
        return 2

    # Set processing status
    if not args.dry_run:
        sb.table("documents").update({
            "ingest_status": "processing", "ingest_error": None,
        }).eq("id", args.doc_id).execute()

    try:
        pdf_bytes = sb.storage.from_("documents").download(doc["storage_path"])
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            pdf_path = f.name

        logical_tables = extract_logical_tables(pdf_path)

        # Determine strategy name from first page
        with pdfplumber.open(pdf_path) as pdf:
            first_text = pdf.pages[0].extract_text() or ""
        strategy_name, _ = detect_strategy(first_text)

        print(f"\n== Parsed: {doc['title']!r} ==")
        print(f"   strategy: {strategy_name}")
        print(f"   raw pdfplumber tables: {sum(len(t['raw_extracted']) for t in logical_tables):,}")
        print(f"   logical tables (after continuation merge): {len(logical_tables):,}\n")

        # confidence breakdown
        conf = {"high": 0, "medium": 0, "low": 0}
        for t in logical_tables:
            conf[t["parser_confidence"]] += 1
        print(f"   confidence: high={conf['high']} medium={conf['medium']} low={conf['low']}")

        # show first three for inspection
        print("\n   --- first 3 logical tables ---")
        for t in logical_tables[:3]:
            print(f"   {t['table_number'] or '(no #)':<12} p{t['page_number']}  rows={len(t['rows'])}  conf={t['parser_confidence']}  caption={(t['caption'] or '')[:60]!r}")

        if args.dry_run:
            print("\n   dry-run: not writing to DB")
            return 0

        # Wipe existing tables for this doc (idempotency)
        sb.table("document_tables").delete().eq("document_id", args.doc_id).execute()

        # Bulk insert
        payload = []
        for t in logical_tables:
            payload.append({
                "document_id": args.doc_id,
                "table_number": t["table_number"],
                "caption": t["caption"],
                "page_number": t["page_number"],
                "headers": t["headers"],
                "rows": t["rows"],
                "raw_extracted": t["raw_extracted"],
                "parser_confidence": t["parser_confidence"],
                "warnings": t["warnings"],
            })
        # Insert in batches (PostgREST has request-size limits)
        BATCH = 50
        for i in range(0, len(payload), BATCH):
            sb.table("document_tables").insert(payload[i:i+BATCH]).execute()
            print(f"   inserted {min(i+BATCH, len(payload))}/{len(payload)}", file=sys.stderr)

        # Record strategy + status. ingest_status='ingested' will be set in 3d
        # after chunks/embeddings too; for now mark partial completion via the
        # parser_strategy field. (Status stays 'processing' until 3d runs.)
        sb.table("documents").update({
            "parser_strategy": strategy_name,
        }).eq("id", args.doc_id).execute()

        print(f"\n   wrote {len(payload)} document_tables rows.")
        return 0

    except Exception as e:
        traceback.print_exc()
        if not args.dry_run:
            sb.table("documents").update({
                "ingest_status": "failed",
                "ingest_error": f"parse_tables: {e}",
            }).eq("id", args.doc_id).execute()
        return 1


# UDC per-zone dimensional tables (7.2.x) run their sections in a fixed order:
#   Lot/Density/District (0) < Setbacks (1) < Height (2) < Other/Notes (3).
# A table is "complete" once it reaches Height / Other / Notes; anything after
# that starts a NEW table, so those sections are terminal for dovetail purposes.
_SECTION_ORDER = {
    "lot": 0, "density": 0, "district": 0,
    "setbacks": 1,
    "height": 2,
    "other": 3, "notes": 3,
}
_TERMINAL_SECTIONS = {"height", "other", "notes"}
# The category prefixes that mark a section header's col-0 label.
_SECTION_PREFIXES = ("setbacks", "height", "other", "density", "district", "lot")


def _section_key(label: Any) -> str | None:
    """Map a col-0 label to its UDC section keyword, or None if it isn't a
    recognized section header. Matching is case-insensitive on the category
    prefixes (plus the terminal 'Notes:' row)."""
    if not isinstance(label, str):
        return None
    s = label.strip().lower()
    if not s:
        return None
    if s.startswith("notes"):
        return "notes"
    for key in _SECTION_PREFIXES:
        if s.startswith(key):
            return key
    return None


def _is_titled_husk(rt: dict[str, Any]) -> bool:
    """A titled table pdfplumber emitted with no body — just its title block,
    because a page break split the title onto the prior page. Identified by:
    has a table_number, but every row is title-only (no recognized section
    header and no populated cell beyond col 0)."""
    if rt["meta"].table_number is None:
        return False
    rows = rt["rows"]
    if not rows:
        return True
    for r in rows:
        if _section_key(r[0] if r else None) is not None:
            return False  # a real section header → it has a body
        if any((c is not None and str(c).strip()) for c in r[1:]):
            return False  # a populated data cell → it has a body
    return True


def reattach_fragments(raw_tables: list[dict[str, Any]], strategy: Strategy) -> list[dict[str, Any]]:
    """Phase 1b — fold page-overflow continuation fragments back into their
    parent table (mutates and returns ``raw_tables``).

    Some 7.2.x per-zone dimensional tables overflow a page break; pdfplumber
    emits the overflow as a separate titleless 3-column table at the TOP of the
    next page (the zone/title only appeared on the page where the table began).
    Those fragments otherwise become standalone titleless rows with no zone.

    A fragment is reattached to the nearest preceding titled 3-column table only
    when content dovetails by UDC section order — which prevents folding an
    unrelated fragment into a table that is already complete (ends in
    Height/Other/Notes)."""
    headerless_check = getattr(strategy, "is_intentionally_headerless", None)

    def ncols(rows: list[list]) -> int:
        return max((len(r) for r in rows), default=0)

    def is_candidate(rt: dict[str, Any]) -> bool:
        # Titleless.
        if rt["meta"].table_number is not None:
            return False
        # Exactly 3 columns.
        if ncols(rt["rows"]) != 3:
            return False
        # Sits at the top of the page (bbox is (x0, top, x1, bottom)).
        bbox = rt.get("bbox")
        if not bbox or bbox[1] >= 120:
            return False
        # Transposed-KV zoning shape (headerless by design).
        if headerless_check is None:
            return False
        return bool(headerless_check(rt["rows"]))

    def last_section_key(rows: list[list]) -> str | None:
        found: str | None = None
        for r in rows:
            if not r:
                continue
            k = _section_key(r[0])
            if k is not None:
                found = k
        return found

    def first_section_key(rows: list[list]) -> str | None:
        for r in rows:
            if not r:
                continue
            k = _section_key(r[0])
            if k is not None:
                return k
        # No section header: the fragment's first row is a data row under an
        # implied (continuing) section — use its own col-0 label.
        if rows and rows[0]:
            return _section_key(rows[0][0])
        return None

    to_remove: list[int] = []
    for i, frag in enumerate(raw_tables):
        if not is_candidate(frag):
            continue

        # Husk-reunification: if the immediately-preceding table is a body-less
        # titled husk, this fragment is its body. Reunify and skip the dovetail
        # search. (A real, bodied parent is never a husk, so this cannot poach
        # the page-overflow dovetail cases.)
        prev = raw_tables[i - 1] if i > 0 else None
        if prev is not None and _is_titled_husk(prev):
            prev["rows"] = frag["rows"]   # husk adopts the body; its title rows are already in meta
            to_remove.append(i)
            print(f"reunified husk {prev['meta'].table_number} (p{prev['page_number']}) "
                  f"<- body p{frag['page_number']}, {len(frag['rows'])} rows")
            continue

        # Parent search: nearest preceding entry, in document order, that has a
        # table_number AND is exactly 3 columns. That is the ONLY candidate parent.
        parent: dict[str, Any] | None = None
        for j in range(i - 1, -1, -1):
            cand = raw_tables[j]
            if cand["meta"].table_number is not None and ncols(cand["rows"]) == 3:
                parent = cand
                break
        if parent is None:
            continue

        # Dovetail gate: accept only if the parent's content continues into the
        # fragment by UDC section order, and the parent isn't already complete.
        parent_key = last_section_key(parent["rows"])
        frag_key = first_section_key(frag["rows"])
        parent_order = _SECTION_ORDER.get(parent_key) if parent_key else None
        frag_order = _SECTION_ORDER.get(frag_key) if frag_key else None
        # A fragment with no recognizable section continues the parent's section.
        if frag_order is None:
            frag_order = parent_order

        accept = (
            parent_key is not None
            and parent_key not in _TERMINAL_SECTIONS
            and parent_order is not None
            and frag_order is not None
            and frag_order >= parent_order
        )

        if accept:
            n = len(frag["rows"])
            parent["rows"] = parent["rows"] + frag["rows"]
            to_remove.append(i)
            print(f"reattached fragment p{frag['page_number']} -> "
                  f"{parent['meta'].table_number} (p{parent['page_number']}), +{n} rows")
        else:
            print(f"orphan kept: titleless frag p{frag['page_number']} "
                  f"(nearest 3-col parent {parent['meta'].table_number} failed dovetail).")

    if to_remove:
        drop = set(to_remove)
        raw_tables[:] = [rt for k, rt in enumerate(raw_tables) if k not in drop]
    return raw_tables


def extract_logical_tables(pdf_path: str) -> list[dict[str, Any]]:
    """Walk every page, extract raw tables, parse via strategy, merge
    continuations. Returns one entry per LOGICAL table (continuations folded
    into the original)."""
    with pdfplumber.open(pdf_path) as pdf:
        first_text = pdf.pages[0].extract_text() or ""
        strategy_name, strategy = detect_strategy(first_text)
        settings = strategy.table_settings().as_kwargs()

        # Phase 1: extract raw pdfplumber tables and their metadata.
        raw_tables: list[dict[str, Any]] = []
        for page_idx, page in enumerate(pdf.pages):
            page_num = page_idx + 1
            for t in page.find_tables(table_settings=settings):
                rows = t.extract()
                if not rows:
                    continue
                meta = strategy.detect_metadata(rows)
                raw_tables.append({
                    "page_number": page_num,
                    "rows": rows,
                    "meta": meta,
                    "bbox": t.bbox,
                })
            if page_idx % 50 == 0 and page_idx > 0:
                print(f"   ... page {page_num}/{len(pdf.pages)}, raw tables: {len(raw_tables)}",
                      file=sys.stderr)

    # Phase 1b: fold page-overflow continuation fragments into their parent.
    reattach_fragments(raw_tables, strategy)

    # Phase 2: merge continuations.
    logical: list[dict[str, Any]] = []
    for raw in raw_tables:
        merged = False
        if logical and raw["meta"].table_number:
            prior = logical[-1]
            if strategy.is_continuation_of(raw["meta"], prior["_meta"]):
                # Continuation — append rows to prior's accumulator.
                prior["_all_rows"].append(raw["rows"])
                prior["_pages"].append(raw["page_number"])
                merged = True
        if not merged:
            logical.append({
                "_meta": raw["meta"],
                "_all_rows": [raw["rows"]],
                "_pages": [raw["page_number"]],
            })

    # Phase 3: process each logical table into the final shape.
    out: list[dict[str, Any]] = []
    for lt in logical:
        meta: TableMeta = lt["_meta"]
        rows_per_segment = lt["_all_rows"]
        pages = lt["_pages"]

        # Concatenate segments. First segment provides the canonical row 0/1;
        # subsequent segments' header repeats are skipped during classification.
        all_rows = [r for seg in rows_per_segment for r in seg]

        # Find header row using the FIRST segment.
        first_seg = rows_per_segment[0]
        header_pair = strategy.find_header_row(first_seg)
        header_row_idx, header_values = (
            header_pair if header_pair else (None, None)
        )
        row0 = first_seg[0] if first_seg else []

        # Walk data rows, building label_path + cells.
        out_rows: list[dict[str, Any]] = []
        label_stack: list[str] = []
        skipped_repeats = 0
        unclassified = 0

        for row in all_rows:
            kind = strategy.classify_row(row, header_values, row0, header_values)
            if kind == "header_repeat":
                skipped_repeats += 1
                continue
            if kind == "section":
                # Push col 0 as a new hierarchy level. Reset deeper levels —
                # simple model: section headers are siblings, not nested.
                label = str(row[0]).strip()
                if label_stack and not label.startswith(label_stack[-1]):
                    # New top-level section: reset stack
                    label_stack = [label]
                else:
                    label_stack = [label]
                continue
            if kind == "data":
                col0_label = (
                    str(row[0]).strip() if isinstance(row[0], str) and row[0].strip()
                    else None
                )
                # Build label_path: current section stack + this row's col-0 label
                label_path = list(label_stack)
                if col0_label:
                    label_path.append(col0_label)

                # Cells: each non-col-0 cell, paired with the header column name
                cells = []
                for col_idx in range(1, len(row)):
                    col_name = (
                        header_values[col_idx]
                        if header_values and col_idx < len(header_values)
                        else f"col_{col_idx}"
                    )
                    cells.append({
                        "column": col_name,
                        **parse_cell(row[col_idx]),
                    })
                # Skip rows that are entirely empty (no col_0 label AND no cells with content)
                if not col0_label and all(
                    c["parse_status"] == "empty" for c in cells
                ):
                    continue
                out_rows.append({"label_path": label_path, "cells": cells})
            else:
                unclassified += 1

        # Compute warnings + confidence.
        warnings = []
        if not meta.table_number:
            warnings.append({"code": "no_table_number",
                             "message": "Could not detect a Table X.Y.Z-A header."})
        if header_values is None:
            headerless_check = getattr(strategy, "is_intentionally_headerless", None)
            if headerless_check is not None and headerless_check(first_seg):
                warnings.append({"code": "headerless_by_design",
                                 "message": "Transposed key-value table; no column header expected."})
            else:
                warnings.append({"code": "no_header_row",
                                 "message": "Could not detect a header row."})
        if unclassified > 0:
            warnings.append({"code": "unclassified_rows",
                             "message": f"{unclassified} rows could not be classified."})
        # Suspected merged headers (table_7.4.2-D pattern):
        # any header row with internal None values amid populated ones.
        if header_values:
            internal_none = sum(
                1 for c in header_values[1:-1] if not c or not c.strip()
            )
            if internal_none > 0:
                warnings.append({"code": "possible_merged_header",
                                 "message": f"{internal_none} blank columns in header row — possible merged/sub-headers."})

        if len(warnings) == 0:
            confidence = "high"
        elif any(w["code"] in ("no_header_row", "no_table_number") for w in warnings):
            confidence = "low"
        else:
            confidence = "medium"

        out.append({
            "table_number": meta.table_number,
            "caption": meta.caption,
            "page_number": pages[0],
            "headers": header_values or [],
            "rows": out_rows,
            "raw_extracted": {
                "segments": rows_per_segment,
                "pages": pages,
                "legend": meta.legend,
            },
            "parser_confidence": confidence,
            "warnings": warnings,
        })

    return out


if __name__ == "__main__":
    sys.exit(main())
