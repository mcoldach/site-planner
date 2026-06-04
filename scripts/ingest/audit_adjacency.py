"""READ-ONLY. (1) For each titleless fragment, show the page-order PRIOR raw
table's last 2 rows + its table_number, to test content-adjacency as F's
signal. (2) Re-list K_shape hits WITH a zone-in-title flag, to test scoping K
to zone-bearing tables. No writes, no edits."""
from __future__ import annotations
import os, sys, tempfile, re
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client
from strategies import detect_strategy
from strategies.base import parse_cell

load_dotenv()
sb: Client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
ZONE_IN_TITLE = re.compile(r"\b(A|R-E|R-\d| R-\d \d|R-Flex|PUD|OR|MX-[A-Z]|BP|LI|OC|C-\d|M-\d)\b")

def ncols(rows): return max((len(r) for r in rows), default=0)
def cap(s,n=26): return str(s).replace(chr(10)," ")[:n]

def k_shape(rows):
    if ncols(rows)!=3: return False
    good=tot=0
    for r in rows:
        if len(r)<3: continue
        c1=parse_cell(r[1] if isinstance(r[1],str) else None)
        c2=parse_cell(r[2] if isinstance(r[2],str) else None)
        if c1["parse_status"] in ("non_numeric","empty") and c2["parse_status"]!="empty": good+=1
        tot+=1
    return tot>=2 and good>=max(2,tot*0.5)

def main():
    docs=sb.table("documents").select("id,title,storage_path").execute().data
    doc=next((d for d in docs if d["id"]==sys.argv[1]),docs[0]) if len(sys.argv)>=2 else (docs[0] if len(docs)==1 else None)
    if not doc:
        for d in docs: print(d["id"],d["title"])
        return 0
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
                title0=cap(rr[0][0] if rr and rr[0] else "",40)
                raw.append({"page":pi+1,"tnum":m.table_number,"ncols":ncols(rr),"rows":rr,"title0":title0})
    print(f"== {doc['title']!r} ==\n")
    print("-- F: each titleless frag on pp.213-227 + its PAGE-ORDER PRIOR tail --")
    for i,r in enumerate(raw):
        if r["tnum"] or not (213<=r["page"]<=227): continue
        print(f"\n  FRAG idx{i} p{r['page']} ncols{r['ncols']}  first2:")
        for rr in r["rows"][:2]: print(f"      {[cap(c,24) for c in rr]}")
        if i>0:
            p=raw[i-1]
            print(f"  PRIOR idx{i-1} p{p['page']} tnum={p['tnum']} ncols{p['ncols']}  last2:")
            for rr in p["rows"][-2:]: print(f"      {[cap(c,24) for c in rr]}")
    print("\n\n-- K: shape hits with zone-in-title flag --")
    for i,r in enumerate(raw):
        if not k_shape(r["rows"]): continue
        zt = bool(ZONE_IN_TITLE.search(r["title0"])) if r["tnum"] else "frag"
        print(f"  idx{i:>3} p{r['page']:<4} tnum={str(r['tnum'] or 'None'):<9} zone_in_title={str(zt):<5} | {r['title0']}")
    print("\n  (read-only)")
    return 0
if __name__=="__main__": sys.exit(main())
