"""
Step 3e — Full ingest wrapper.

Composes the two phases of document ingestion into a single command:

  1. parse_tables: pdfplumber → strategies → document_tables
  2. embed_chunks: prose → LM Studio → document_chunks (vectors)

Sets documents.ingest_status across the pipeline:
  uploaded   → processing → ingested        (success)
  uploaded   → processing → failed          (any error; sets ingest_error)

The two sub-runners (parse_tables.py and embed_chunks.py) are designed to
be safe to call standalone; this wrapper just sequences them and owns the
top-level status transitions. Both are idempotent — they delete existing
rows for the document before re-inserting.

Usage:
    python ingest.py <document_id> [--dry-run]
    python ingest.py <document_id> --skip-tables   (only re-embed prose)
    python ingest.py <document_id> --skip-chunks   (only re-parse tables)
"""
from __future__ import annotations
import os
import sys
import argparse
import time
import traceback

from dotenv import load_dotenv
from supabase import create_client, Client

# We import the helpers from the sibling runners rather than shelling out.
# This keeps everything in-process: one DB connection, one tempfile, no
# duplicated download. The runners' main() functions ARE the per-step
# CLIs; we use their pure functions directly.
import parse_tables
import embed_chunks

load_dotenv()
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("doc_id")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + embed but don't write to DB")
    ap.add_argument("--skip-tables", action="store_true",
                    help="skip table parsing (only run prose chunker/embedder)")
    ap.add_argument("--skip-chunks", action="store_true",
                    help="skip prose chunking (only run table parser)")
    args = ap.parse_args()

    if args.skip_tables and args.skip_chunks:
        print("--skip-tables and --skip-chunks together leave nothing to do.",
              file=sys.stderr)
        return 2

    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    doc = sb.table("documents").select(
        "id, title, ingest_status"
    ).eq("id", args.doc_id).maybe_single().execute().data
    if doc is None:
        print(f"no documents row with id {args.doc_id}", file=sys.stderr)
        return 2

    print(f"== Ingest: {doc['title']!r} ==")
    print(f"   current status: {doc['ingest_status']}")
    started = time.time()

    if not args.dry_run:
        sb.table("documents").update({
            "ingest_status": "processing",
            "ingest_error": None,
        }).eq("id", args.doc_id).execute()

    # We invoke each sub-runner's main() with a built argv. They handle
    # their own status updates internally, which is fine — the final
    # 'ingested' state is set by embed_chunks at the end of its main().
    # If chunks is skipped, we set 'ingested' ourselves at the bottom.

    saved_argv = sys.argv

    try:
        if not args.skip_tables:
            print("\n-- 3c: parsing tables --")
            sys.argv = ["parse_tables.py", args.doc_id]
            if args.dry_run:
                sys.argv.append("--dry-run")
            rc = parse_tables.main()
            if rc != 0:
                raise RuntimeError(f"parse_tables exited with code {rc}")

        if not args.skip_chunks:
            print("\n-- 3d: embedding chunks --")
            sys.argv = ["embed_chunks.py", args.doc_id]
            if args.dry_run:
                sys.argv.append("--dry-run")
            rc = embed_chunks.main()
            if rc != 0:
                raise RuntimeError(f"embed_chunks exited with code {rc}")

        # If we skipped chunks, embed_chunks did not flip status to ingested.
        # Set it manually for completeness.
        if args.skip_chunks and not args.dry_run:
            sb.table("documents").update({
                "ingest_status": "ingested",
            }).eq("id", args.doc_id).execute()

        elapsed = time.time() - started
        print(f"\n== Ingest complete in {elapsed:.1f}s ==")
        return 0

    except Exception as e:
        traceback.print_exc()
        if not args.dry_run:
            sb.table("documents").update({
                "ingest_status": "failed",
                "ingest_error": f"ingest: {e}",
            }).eq("id", args.doc_id).execute()
        return 1

    finally:
        sys.argv = saved_argv


if __name__ == "__main__":
    sys.exit(main())
