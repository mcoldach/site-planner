"""
Step 3d — Chunk a document's prose and write embeddings to document_chunks.

Usage:
    python embed_chunks.py <document_id> [--dry-run]

Idempotent: deletes existing document_chunks rows for this document and
re-inserts. Re-runs are safe (chunking is deterministic for a given PDF).

Flow:
  1. Fetch documents row + download PDF from Storage.
  2. Chunk prose (skipping content inside table bboxes).
  3. Embed all chunks in batches via LM Studio.
  4. Bulk-insert into document_chunks.
  5. Update documents.ingest_status='ingested'.
"""
from __future__ import annotations
import os
import sys
import argparse
import tempfile
import time
import traceback

from dotenv import load_dotenv
from supabase import create_client, Client

from chunker import chunk_document
from embedder import embed_all, BATCH_SIZE

load_dotenv()
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

INSERT_BATCH = 50  # rows per PostgREST insert


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("doc_id")
    ap.add_argument("--dry-run", action="store_true",
                    help="chunk + embed but don't write to DB")
    args = ap.parse_args()

    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    doc = sb.table("documents").select(
        "id, filename, storage_path, title"
    ).eq("id", args.doc_id).maybe_single().execute().data
    if doc is None:
        print(f"no documents row with id {args.doc_id}", file=sys.stderr)
        return 2

    if not args.dry_run:
        sb.table("documents").update({
            "ingest_status": "processing", "ingest_error": None,
        }).eq("id", args.doc_id).execute()

    try:
        print(f"== Embedding: {doc['title']!r} ==")
        t0 = time.time()
        pdf_bytes = sb.storage.from_("documents").download(doc["storage_path"])
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            pdf_path = f.name
        print(f"  downloaded {len(pdf_bytes):,} bytes in {time.time()-t0:.1f}s")

        # Chunk
        t0 = time.time()
        chunks = chunk_document(pdf_path)
        print(f"  chunked into {len(chunks)} chunks in {time.time()-t0:.1f}s")
        if not chunks:
            print("  no prose chunks produced — nothing to embed.")
            return 0
        # Quick distribution sanity
        pages_touched = sorted({c.page_number for c in chunks})
        print(f"  page range: {pages_touched[0]}-{pages_touched[-1]} "
              f"({len(pages_touched)} distinct pages)")
        avg_tokens = sum(c.token_count for c in chunks) / len(chunks)
        print(f"  avg token_count: {avg_tokens:.0f}")
        with_section = sum(1 for c in chunks if c.section_ref)
        print(f"  chunks with detected section_ref: {with_section}/{len(chunks)}")

        # Embed
        t0 = time.time()
        texts = [c.text for c in chunks]
        vectors: list[list[float] | None] = [None] * len(texts)
        n_batches = (len(texts) + BATCH_SIZE - 1) // BATCH_SIZE
        n_done = 0
        for idx, vec in embed_all(texts):
            vectors[idx] = vec
            if (idx + 1) % BATCH_SIZE == 0 or idx == len(texts) - 1:
                n_done = idx + 1
                print(f"  embedded {n_done}/{len(texts)} "
                      f"({n_done/len(texts)*100:.0f}%)", file=sys.stderr)
        print(f"  embedded {len(texts)} chunks in {time.time()-t0:.1f}s")

        # Verify all got vectors
        missing = [i for i, v in enumerate(vectors) if v is None]
        if missing:
            raise RuntimeError(f"missing embeddings for chunks: {missing[:10]}...")

        # Show first chunk for sanity
        c0 = chunks[0]
        print()
        print(f"  first chunk preview (idx=0, page={c0.page_number}, "
              f"section_ref={c0.section_ref!r}):")
        print(f"    {c0.text[:200]!r}...")

        if args.dry_run:
            print("\n  dry-run: not writing to DB")
            return 0

        # Wipe existing chunks for this doc (idempotency)
        sb.table("document_chunks").delete().eq("document_id", args.doc_id).execute()

        # Bulk insert
        t0 = time.time()
        payload = [
            {
                "document_id": args.doc_id,
                "chunk_index": c.chunk_index,
                "page_number": c.page_number,
                "section_ref": c.section_ref,
                "text": c.text,
                "embedding": vec,
                "token_count": c.token_count,
            }
            for c, vec in zip(chunks, vectors)
        ]
        for i in range(0, len(payload), INSERT_BATCH):
            sb.table("document_chunks").insert(payload[i:i+INSERT_BATCH]).execute()
            print(f"  inserted {min(i+INSERT_BATCH, len(payload))}/{len(payload)}",
                  file=sys.stderr)
        print(f"  inserted {len(payload)} chunks in {time.time()-t0:.1f}s")

        # Mark ingested
        sb.table("documents").update({
            "ingest_status": "ingested",
        }).eq("id", args.doc_id).execute()
        print(f"\n  documents.ingest_status = 'ingested'")
        return 0

    except Exception as e:
        traceback.print_exc()
        if not args.dry_run:
            sb.table("documents").update({
                "ingest_status": "failed",
                "ingest_error": f"embed_chunks: {e}",
            }).eq("id", args.doc_id).execute()
        return 1


if __name__ == "__main__":
    sys.exit(main())
