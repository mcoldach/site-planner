"""
Step 3a sanity check — proves the three connections work before any ingest
logic is written:
  1. Supabase (service role, bypasses RLS) — can read the documents table.
  2. Supabase Storage — can list and download from the documents bucket.
  3. LM Studio — can produce a 768-dim embedding from the loaded model.

Usage:
    python check.py <document_id>

Reads <document_id> from the documents table, downloads the PDF to /tmp to
prove Storage access, and calls LM Studio with a tiny string. Writes nothing
back. If all three sections print OK, the next sub-step (3b) is safe.
"""
import os
import sys
import tempfile
import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
LM_STUDIO_URL = os.environ["LM_STUDIO_URL"]
EMBEDDING_MODEL = os.environ["EMBEDDING_MODEL"]


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python check.py <document_id>", file=sys.stderr)
        return 1
    doc_id = sys.argv[1]

    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    # 1. Read documents row (service role bypasses RLS — should always succeed
    #    for a valid id, regardless of which user owns it).
    print("== 1. Supabase: read documents row ==")
    res = sb.table("documents").select(
        "id, jurisdiction_id, filename, storage_path, title, ingest_status, owner_id"
    ).eq("id", doc_id).maybe_single().execute()
    if res.data is None:
        print(f"FAIL: no documents row with id {doc_id}", file=sys.stderr)
        return 2
    row = res.data
    print(f"  ok — title: {row['title']!r}")
    print(f"      filename: {row['filename']}")
    print(f"      storage_path: {row['storage_path']}")
    print(f"      ingest_status: {row['ingest_status']}")

    # 2. Download the PDF from Storage to /tmp (proves bucket read works,
    #    bytes flow). Don't keep it — we just want to confirm we can.
    print("\n== 2. Supabase Storage: download PDF ==")
    pdf_bytes = sb.storage.from_("documents").download(row["storage_path"])
    if not pdf_bytes or len(pdf_bytes) < 100:
        print(f"FAIL: downloaded {len(pdf_bytes) if pdf_bytes else 0} bytes", file=sys.stderr)
        return 3
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = f.name
    print(f"  ok — downloaded {len(pdf_bytes):,} bytes -> {tmp_path}")

    # 3. LM Studio — embed a tiny test string, confirm 768 dimensions and the
    #    loaded model is the one the schema's vector(768) column expects.
    print("\n== 3. LM Studio: embeddings ==")
    r = httpx.post(
        f"{LM_STUDIO_URL}/embeddings",
        json={"model": EMBEDDING_MODEL, "input": "hello world"},
        timeout=30.0,
    )
    r.raise_for_status()
    data = r.json()
    vec = data["data"][0]["embedding"]
    dim = len(vec)
    print(f"  ok — model: {EMBEDDING_MODEL}")
    print(f"      dimensions: {dim} (schema expects 768)")
    if dim != 768:
        print(f"FAIL: dimension mismatch — schema is vector(768), got {dim}", file=sys.stderr)
        return 4

    print("\nAll three checks passed. Ready for Step 3b (pdfplumber extraction).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
