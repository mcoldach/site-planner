"""READ-ONLY. For each titleless 3-col zoning fragment (pp.214/217/219/226),
list every same-page raw table (titled or not, with ncols) and show the
fragment's first 2 rows + each same-page titled 3-col candidate's last 2 rows,
so parent resolution (nearest 3-col zoning neighbor + dovetail) is proven per
fragment, not assumed. No writes."""
from __future__ import annotations
import os, sys, tempfile
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
load_dotenv()
sb: Client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
def ncols(rows): return max((len(r) for r in rows), default=0)
def cap(s,n=24): return str(s).replace(chr(10)," ")[:n]
def main():
    docs=sb.table("documents").select("id,title,storage_path").execute().data
    doc=docs[0] if len(docs)==1 else next(d for d in docs if d["id"]==sys.argv[1])
    b=sb.storage.from_("documents").download(doc["storage_path"])
    with tempfile.NamedTemporaryFile(suffix=".pdf",delete=False) as f: f.write(b); path=f.name
    with pdfplumber.open(path) as pdf:
        _,strat=detect_strategy(pdf.pages[0].extract_text() or "")
        st=strat.table_settings().as_kwargs()
        raw=[]
        for pi,page in enumerate(pdf.pages):
            for t in page.find_tables(table_settings=st):
                rr=t.extract()
                if not rr: continue
                m=strat.detect_metadata(rr)
                raw.append({"page":pi+1,"tnum":m.table_number,"ncols":ncols(rr),
                            "rows":rr,"bbox_top":round(t.bbox[1],1)})
    for pg in (214,217,219,226):
        print(f"\n===== PAGE {pg} =====")
        onpage=[r for r in raw if r["page"]==pg]
        onpage.sort(key=lambda r: r["bbox_top"])
        for r in onpage:
            tag = f"tnum={r['tnum']}" if r["tnum"] else "TITLELESS-FRAG" if r["ncols"]==3 else "(other)"
            print(f"  [{tag}] ncols={r['ncols']} bbox_top={r['bbox_top']}")
            if not r["tnum"]:
                for rr in r["rows"][:2]: print(f"      FRAG head: {[cap(c) for c in rr]}")
            elif r["ncols"]==3:
                for rr in r["rows"][-2:]: print(f"      cand tail: {[cap(c) for c in rr]}")
    print("\n  (read-only)")
if __name__=="__main__": sys.exit(main())
