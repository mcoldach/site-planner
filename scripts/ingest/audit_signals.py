"""
audit_signals.py — READ-ONLY. Tests the two REFINED predicates against the
whole document before any parser change:
  F_trigger: titleless AND a titled table on the SAME page has matching ncols
  K_shape:   ncols==3 AND no row looks like a zone/column-label header
             (col1 is rule-prose, col2 is a single value) — the transposed
             key-value shape unique to the 7.2.x per-zone tables.
No DB writes, no edits to existing files.
"""
from __future__ import annotations
import os, sys, tempfile, re
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
from strategies.base import parse_cell

load_dotenv()
sb: Client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

ZONE_RE = re.compile(r"^(A|R-E|R-\d|R-\d \d|PUD|OC|C-\d|M-\d|[A-Z]{1,3}-?\d?)$")

def ncols(rows): return max((len(r) for r in rows), default=0)

def looks_like_zone_header(rows):
    """True if any of the first 4 rows is a row of short zone-code-like labels
    in cols 1..n (the 7.4.2-A matrix shape)."""
    for r in rows[:4]:
        if len(r) < 3: continue
        vals = [str(c).strip() for c in r[1:] if isinstance(c, str) and c.strip()]
        if len(vals) >= 3 and sum(1 for v in vals if ZONE_RE.match(v)) >= max(2, len(vals)//2):
            return True
    return False

def k_shape(rows):
    if ncols(rows) != 3: return False
    if looks_like_zone_header(rows): return False
    # majority of data rows: col2 parses to a single numeric/prose value,
    # col1 is non-numeric prose (a rule name)
    good = 0; tot = 0
    for r in rows:
        if len(r) < 3: continue
        c1 = parse_cell(r[1] if isinstance(r[1], str) else None)
        c2 = parse_cell(r[2] if isinstance(r[2], str) else None)
        if c1["parse_status"] in ("non_numeric","empty") and c2["parse_status"] != "empty":
            good += 1
        tot += 1
    return tot >= 2 and good >= max(2, tot*0.5)

def main():
    docs = sb.table("documents").select("id,title,storage_path").execute().data
    doc = next((d for d in docs if d["id"] == sys.argv[1]), docs[0]) if len(sys.argv)>=2 else (docs[0] if len(docs)==1 else None)
    if not doc:
        for d in docs: print(d["id"], d["title"])
        return 0
    b = sb.storage.from_("documents").download(doc["storage_path"])
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(b); path=f.name
    with pdfplumber.open(path) as pdf:
        _, strat = detect_strategy(pdf.pages[0].extract_text() or "")
        settings = strat.table_settings().as_kwargs()
        raw=[]
        for pi,page in enumerate(pdf.pages):
            for t in page.find_tables(table_settings=settings):
                rr=t.extract()
                if not rr: continue
                raw.append({"page":pi+1,"tnum":strat.detect_metadata(rr).table_number,
                            "ncols":ncols(rr),"rows":rr,
                            "prev":" | ".join(str(c).replace(chr(10)," ")[:20] for c in rr[0][:3])})
    # F: build per-page titled-ncols index
    bypage={}
    for r in raw:
        if r["tnum"]: bypage.setdefault(r["page"],[]).append(r["ncols"])
    print(f"== {doc['title']!r} ==  raw tables: {len(raw)}")
    print("\n-- F_trigger (titleless + same-page titled w/ matching ncols) --")
    fhits=[]
    for i,r in enumerate(raw):
        if r["tnum"]: continue
        if r["ncols"] in bypage.get(r["page"],[]):
            fhits.append(i)
            print(f"   idx {i:>3} p{r['page']:<4} ncols={r['ncols']:<3} | {r['prev']}")
    print(f"   F hits: {len(fhits)}  (expect the p214/217/219/226 + p257/258 fragments, ~6-8)")
    print("\n-- K_shape (transposed 3-col key-value, not zone-matrix) --")
    khits=[]
    for i,r in enumerate(raw):
        if k_shape(r["rows"]):
            khits.append(i)
            print(f"   idx {i:>3} p{r['page']:<4} tnum={str(r['tnum'] or 'None'):<9} | {r['prev']}")
    print(f"   K hits: {len(khits)}  (expect the 7.2.x per-zone family + their fragments)")
    print("\n   (read-only)")
    return 0

if __name__=="__main__":
    sys.exit(main())
