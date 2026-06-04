"""READ-ONLY. Dump every raw table on pp.216-217 in document order with title,
zone-from-caption, bbox_top, and first+last 3 rows — to resolve the p217
fragment's true parent (zone-match + dovetail) without cross-referencing other
audits. No writes."""
from __future__ import annotations
import os, sys, tempfile, re
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
load_dotenv()
sb: Client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
ZRE=re.compile(r"^\s*([^:]+?)\s*:")
def ncols(rows): return max((len(r) for r in rows), default=0)
def cap(s,n=30): return str(s).replace(chr(10)," ")[:n]
def main():
    docs=sb.table("documents").select("id,title,storage_path").execute().data
    doc=docs[0] if len(docs)==1 else next(d for d in docs if d["id"]==sys.argv[1])
    b=sb.storage.from_("documents").download(doc["storage_path"])
    with tempfile.NamedTemporaryFile(suffix=".pdf",delete=False) as f: f.write(b); path=f.name
    out=[]
    with pdfplumber.open(path) as pdf:
        _,strat=detect_strategy(pdf.pages[0].extract_text() or "")
        st=strat.table_settings().as_kwargs()
        for pi,page in enumerate(pdf.pages):
            if pi+1 not in (216,217): continue
            for t in page.find_tables(table_settings=st):
                rr=t.extract()
                if not rr: continue
                m=strat.detect_metadata(rr)
                cap0=str(rr[0][0]) if rr and rr[0] else ""
                zm=ZRE.search(m.caption or cap0 or "")
                out.append((pi+1, round(t.bbox[1],1), m.table_number, zm.group(1).strip() if zm else None, ncols(rr), rr))
    out.sort(key=lambda x:(x[0],x[1]))
    for pg,top,tnum,zone,nc,rr in out:
        print(f"\np{pg} bbox_top={top} tnum={tnum} zone={zone!r} ncols={nc}")
        print("  first3:", [[cap(c) for c in row] for row in rr[:3]])
        print("  last3: ", [[cap(c) for c in row] for row in rr[-3:]])
    print("\n  (read-only)")
if __name__=="__main__": sys.exit(main())
