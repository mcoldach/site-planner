"""READ-ONLY. For each titleless 3-col zoning fragment (top of pp.214/217/219/226),
find the most recent PRIOR (document-order) titled 3-col table and show its tail
against the fragment's head — to prove the cross-page continuation join by content
dovetail. Walks raw tables in page+bbox order (document order). No writes."""
from __future__ import annotations
import os, sys, tempfile
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
load_dotenv()
sb: Client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
def ncols(rows): return max((len(r) for r in rows), default=0)
def cap(s,n=26): return str(s).replace(chr(10)," ")[:n]
def main():
    docs=sb.table("documents").select("id,title,storage_path").execute().data
    doc=docs[0] if len(docs)==1 else next(d for d in docs if d["id"]==sys.argv[1])
    b=sb.storage.from_("documents").download(doc["storage_path"])
    with tempfile.NamedTemporaryFile(suffix=".pdf",delete=False) as f: f.write(b); path=f.name
    raw=[]
    with pdfplumber.open(path) as pdf:
        _,strat=detect_strategy(pdf.pages[0].extract_text() or "")
        st=strat.table_settings().as_kwargs()
        for pi,page in enumerate(pdf.pages):
            for t in page.find_tables(table_settings=st):
                rr=t.extract()
                if not rr: continue
                m=strat.detect_metadata(rr)
                raw.append({"page":pi+1,"tnum":m.table_number,"ncols":ncols(rr),
                            "rows":rr,"bbox_top":round(t.bbox[1],1)})
    # document order = page, then bbox_top
    raw.sort(key=lambda r:(r["page"], r["bbox_top"]))
    for i,r in enumerate(raw):
        if r["tnum"] or r["ncols"]!=3 or r["page"] not in (214,217,219,226): continue
        # is it a top-of-page fragment?
        if r["bbox_top"] > 120: continue
        print(f"\n===== FRAG p{r['page']} bbox_top={r['bbox_top']} =====")
        print(f"  FRAG head:")
        for rr in r["rows"][:3]: print(f"      {[cap(c) for c in rr]}")
        # nearest prior titled 3-col table in document order
        parent=None
        for j in range(i-1,-1,-1):
            if raw[j]["tnum"] and raw[j]["ncols"]==3:
                parent=raw[j]; break
        if parent:
            print(f"  NEAREST PRIOR titled 3-col: {parent['tnum']} (p{parent['page']}) tail:")
            for rr in parent["rows"][-3:]: print(f"      {[cap(c) for c in rr]}")
        else:
            print("  no prior titled 3-col found")
    print("\n  (read-only)")
if __name__=="__main__": sys.exit(main())
