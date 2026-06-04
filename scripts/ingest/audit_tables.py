"""
audit_tables.py — READ-ONLY diagnostic. No DB writes, no edits to any existing
file. Replays Phase 1 of parse_tables.extract_logical_tables (page-order raw
pdfplumber extraction) and reports the two populations needed to design the
K (header-eats-data) and F (titleless continuation fragment) fixes safely
across the WHOLE document.

Usage:
    python audit_tables.py            # auto-picks if exactly one document
    python audit_tables.py <doc_id>   # otherwise pass the id
"""
from __future__ import annotations
import os, sys, tempfile
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
from strategies.base import parse_cell

load_dotenv()
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def ncols(rows):
    return max((len(r) for r in rows), default=0)


def header_looks_like_data(rows, header_pair) -> bool:
    if not header_pair:
        return False
    idx, _vals = header_pair
    if idx is None or idx >= len(rows):
        return False
    numeric = 0
    for c in rows[idx][1:]:
        pc = parse_cell(c if isinstance(c, str) else None)
        if pc["parse_status"] == "numeric":
            numeric += 1
    return numeric >= 1


def preview(rows):
    if not rows:
        return ""
    cells = [str(c).replace("\n", " ")[:22] for c in rows[0][:3]]
    return " | ".join(cells)


def main() -> int:
    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    docs = sb.table("documents").select("id, title, storage_path").execute().data
    if not docs:
        print("no documents.", file=sys.stderr); return 2
    if len(sys.argv) >= 2:
        doc = next((d for d in docs if d["id"] == sys.argv[1]), None)
        if not doc:
            print("no such document id", file=sys.stderr); return 2
    elif len(docs) == 1:
        doc = docs[0]
    else:
        print("multiple documents — pass an id:")
        for d in docs:
            print(f"   {d['id']}  {d['title']!r}")
        return 0

    pdf_bytes = sb.storage.from_("documents").download(doc["storage_path"])
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        pdf_path = f.name

    with pdfplumber.open(pdf_path) as pdf:
        first_text = pdf.pages[0].extract_text() or ""
        strat_name, strategy = detect_strategy(first_text)
        settings = strategy.table_settings().as_kwargs()

        raw = []  # page order — exactly what extract_logical_tables Phase 1 builds
        for pi, page in enumerate(pdf.pages):
            for t in page.find_tables(table_settings=settings):
                rows = t.extract()
                if not rows:
                    continue
                meta = strategy.detect_metadata(rows)
                hp = strategy.find_header_row(rows)
                raw.append({
                    "page": pi + 1,
                    "tnum": meta.table_number,
                    "ncols": ncols(rows),
                    "nrows": len(rows),
                    "hp": hp,
                    "k": header_looks_like_data(rows, hp),
                    "prev": preview(rows),
                })

    print(f"== AUDIT: {doc['title']!r}  strategy={strat_name} ==")
    print(f"   total raw pdfplumber tables (page order): {len(raw)}")
    titleless = [i for i, r in enumerate(raw) if not r["tnum"]]
    kflag = [i for i, r in enumerate(raw) if r["k"]]
    print(f"   titleless (table_number=None): {len(titleless)}")
    print(f"   header-looks-like-data (K suspects): {len(kflag)}")

    print("\n-- TITLELESS (F population) + immediate prior --")
    print("   idx page ncols nrows | prior_tnum prior_ncols match | first_row_preview")
    ambiguous = 0
    for i in titleless:
        r = raw[i]
        if i == 0:
            ptn, pnc, match = "(NONE)", "-", "NO-PRIOR"; ambiguous += 1
        else:
            p = raw[i - 1]
            ptn = p["tnum"] or "None"
            pnc = p["ncols"]
            ok = (p["tnum"] is not None) and (p["ncols"] == r["ncols"])
            match = "yes" if ok else "NO"
            if not ok:
                ambiguous += 1
        print(f"   {i:>4} p{r['page']:<4} {r['ncols']:<5} {r['nrows']:<5} | "
              f"{str(ptn):<11} {str(pnc):<5} {match:<8} | {r['prev']}")
    print(f"   --> safe (titled, col-matching prior): {len(titleless) - ambiguous}")
    print(f"   --> AMBIGUOUS (no prior / titleless prior / col mismatch): {ambiguous}")

    print("\n-- HEADER-LOOKS-LIKE-DATA (K population) --")
    print("   idx page tnum ncols | chosen_idx chosen_header_values[:5]")
    for i in kflag:
        r = raw[i]
        idx, vals = r["hp"] if r["hp"] else (None, None)
        print(f"   {i:>4} p{r['page']:<4} {str(r['tnum'] or 'None'):<9} {r['ncols']:<5} | "
              f"idx={idx} {vals[:5] if vals else vals}")

    print("\n   (read-only: no DB writes, no files modified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
