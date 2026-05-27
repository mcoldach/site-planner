"""
Step 3b — inspect what pdfplumber sees in a document, no DB writes.

Usage:
    python inspect.py <document_id> [--page N]            # page N detail
    python inspect.py <document_id> --tables              # all tables, brief
    python inspect.py <document_id> --table N             # detailed view of Nth table
    python inspect.py <document_id> --summary             # default: counts + first/last page

The City Code is 10.7 MB / many pages — default mode prints a high-level
summary (page count, total tables detected, sample first/last page) so we can
see the shape before drilling in. Then drill in with --table N to look at
specific tables (we'll want to see how a real dimensional-standards table
maps to pdfplumber's row/col grid).
"""
import os
import sys
import argparse
import tempfile
import pdfplumber
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def download_pdf(doc_id: str) -> tuple[str, dict]:
    sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    res = sb.table("documents").select(
        "id, filename, storage_path, title"
    ).eq("id", doc_id).maybe_single().execute()
    if res.data is None:
        raise SystemExit(f"no documents row with id {doc_id}")
    row = res.data
    pdf_bytes = sb.storage.from_("documents").download(row["storage_path"])
    f = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    f.write(pdf_bytes)
    f.close()
    return f.name, row


def print_summary(pdf_path: str, row: dict) -> None:
    """High-level: page count, table count per page, total tables."""
    print(f"\n== Summary: {row['title']!r} ==")
    print(f"   filename: {row['filename']}")
    print(f"   local path: {pdf_path}\n")

    with pdfplumber.open(pdf_path) as pdf:
        n_pages = len(pdf.pages)
        print(f"   pages: {n_pages:,}")

        # Count tables per page (just first 20 pages + last 5 for a sample,
        # since extracting tables across hundreds of pages is slow).
        sample_pages = list(range(min(20, n_pages))) + (
            list(range(max(20, n_pages - 5), n_pages)) if n_pages > 25 else []
        )
        print(f"\n   Table-detection sample (showing pages 0-19 and last 5):")
        total_sampled_tables = 0
        for i in sample_pages:
            page = pdf.pages[i]
            tables = page.find_tables()
            if tables:
                total_sampled_tables += len(tables)
                print(f"     page {i+1:>4}: {len(tables)} table(s)")
        print(f"\n   Tables in sampled pages: {total_sampled_tables}")
        print(f"   (Full page-by-page table extraction skipped — would take minutes")
        print(f"    on a {n_pages}-page document. Use --tables to scan all pages.)")

        # A peek at the first and last page's text — confirm extraction works
        print(f"\n   --- First page text (first 400 chars) ---")
        first_text = pdf.pages[0].extract_text() or ""
        print(f"   {first_text[:400]!r}")
        if len(first_text) > 400:
            print(f"   ... [+{len(first_text) - 400} more chars]")


def print_all_tables(pdf_path: str) -> None:
    """Scan EVERY page, report tables found. Slow on large docs but
    gives the true count we'll deal with at ingest time."""
    print("\n== All tables (full scan) ==")
    total = 0
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            tables = page.find_tables()
            if tables:
                for t in tables:
                    total += 1
                    bbox = t.bbox
                    print(f"   table {total:>4} on page {i+1:>4} (bbox: {bbox[0]:.0f},{bbox[1]:.0f}-{bbox[2]:.0f},{bbox[3]:.0f})")
            if i % 50 == 0 and i > 0:
                print(f"   ... scanned page {i+1}/{len(pdf.pages)}, tables so far: {total}", file=sys.stderr)
    print(f"\n   TOTAL tables across full document: {total}")


def print_table_n(pdf_path: str, n: int) -> None:
    """Detailed view of the Nth table found (1-indexed). Shows headers + rows."""
    print(f"\n== Table #{n} (1-indexed, found by full scan) ==")
    seen = 0
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            tables = page.find_tables()
            for t in tables:
                seen += 1
                if seen == n:
                    print(f"   page: {i+1}")
                    print(f"   bbox: {t.bbox}")
                    extracted = t.extract()
                    if not extracted:
                        print("   (no rows extracted)")
                        return
                    print(f"   rows: {len(extracted)}")
                    print(f"   cols: {max(len(r) for r in extracted)}\n")
                    print("   --- raw extracted (each row is a list of cells) ---")
                    for ri, row in enumerate(extracted[:25]):
                        print(f"   row {ri}: {row}")
                    if len(extracted) > 25:
                        print(f"   ... [+{len(extracted) - 25} more rows]")

                    # Print the page text around the table for context
                    print(f"\n   --- page text around table (first 800 chars of page) ---")
                    page_text = page.extract_text() or ""
                    print(f"   {page_text[:800]!r}")
                    return
    print(f"   FAIL: only found {seen} tables, can't show #{n}")


def print_page(pdf_path: str, page_num: int) -> None:
    """Detailed view of a single page: text + any tables."""
    print(f"\n== Page {page_num} ==")
    with pdfplumber.open(pdf_path) as pdf:
        if page_num < 1 or page_num > len(pdf.pages):
            print(f"   FAIL: doc has {len(pdf.pages)} pages, asked for {page_num}")
            return
        page = pdf.pages[page_num - 1]
        text = page.extract_text() or ""
        print(f"   --- page text ({len(text)} chars) ---")
        print(f"   {text[:1500]!r}")
        if len(text) > 1500:
            print(f"   ... [+{len(text) - 1500} more chars]")
        tables = page.find_tables()
        print(f"\n   tables on this page: {len(tables)}")
        for ti, t in enumerate(tables):
            rows = t.extract()
            print(f"   table {ti+1}: {len(rows)} rows × {max(len(r) for r in rows) if rows else 0} cols")
            for ri, row in enumerate(rows[:10]):
                print(f"     row {ri}: {row}")
            if rows and len(rows) > 10:
                print(f"     ... [+{len(rows) - 10} more rows]")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("doc_id")
    p.add_argument("--page", type=int)
    p.add_argument("--tables", action="store_true")
    p.add_argument("--table", type=int)
    args = p.parse_args()

    pdf_path, row = download_pdf(args.doc_id)

    if args.tables:
        print_all_tables(pdf_path)
    elif args.table:
        print_table_n(pdf_path, args.table)
    elif args.page:
        print_page(pdf_path, args.page)
    else:
        print_summary(pdf_path, row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
