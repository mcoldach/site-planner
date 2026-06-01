"""Transform a document's tables into draft claims.

Usage:
  python transform.py <document_id>              # writes to DB
  python transform.py <document_id> --dry-run    # prints summary, no writes
"""

from __future__ import annotations
import os
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from supabase import create_client, Client
from dotenv import load_dotenv

from detect import detect_shape, Shape
from extract import extract
from mapping import LabelMapper, MapResult, MapOutput
from build import build_claim


HERE = Path(__file__).resolve().parent
# Reuse the ingest .env (same SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
load_dotenv(HERE.parent / "ingest" / ".env")


def get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def lookup_document_context(client: Client, document_id: str) -> tuple[str, str]:
    resp = (client.table("documents")
            .select("jurisdiction_id, source_snapshot_id")
            .eq("id", document_id).execute())
    if not resp.data:
        raise SystemExit(f"document {document_id} not found")
    row = resp.data[0]
    jid = row.get("jurisdiction_id")
    sid = row.get("source_snapshot_id")
    if not jid:
        raise SystemExit(f"document {document_id} has no jurisdiction_id")
    if not sid:
        raise SystemExit(f"document {document_id} has no source_snapshot_id")
    return jid, sid


def fetch_document_tables(client: Client, document_id: str) -> list[dict[str, Any]]:
    resp = (client.table("document_tables")
            .select("id, table_number, caption, page_number, headers, rows, parser_confidence")
            .eq("document_id", document_id)
            .execute())
    return resp.data or []


def clear_previous_extraction(
    client: Client, document_id: str, source_snapshot_id: str
) -> tuple[int, int]:
    """Wipe this document's previously-transformed output so a re-run replaces
    rather than duplicates it (mirrors parse_tables.py's idempotency).

    Only deletes machine-extracted artifacts:
      - claims for this source_snapshot_id with review_state = 'extracted'.
        Approved/rejected claims carry human review state and are never touched.
      - unmapped_table_labels for this document's tables, so the unmapped set is
        rebuilt from scratch rather than accumulated.

    Returns (claims_cleared, unmapped_cleared).
    """
    claims_resp = (client.table("claims")
                   .delete()
                   .eq("source_snapshot_id", source_snapshot_id)
                   .eq("review_state", "extracted")
                   .execute())
    claims_cleared = len(claims_resp.data or [])

    ids_resp = (client.table("document_tables")
                .select("id")
                .eq("document_id", document_id)
                .execute())
    table_ids = [t["id"] for t in (ids_resp.data or [])]
    unmapped_cleared = 0
    if table_ids:
        unmapped_resp = (client.table("unmapped_table_labels")
                         .delete()
                         .in_("document_table_id", table_ids)
                         .execute())
        unmapped_cleared = len(unmapped_resp.data or [])

    return claims_cleared, unmapped_cleared


def log_unmapped(client: Client, document_table_id: str, label_path: list[str]):
    try:
        client.table("unmapped_table_labels").insert({
            "document_table_id": document_table_id,
            "label_path": label_path,
        }).execute()
    except Exception as e:
        msg = str(e)
        if "23505" in msg or "duplicate key" in msg or "unmapped_dedup_idx" in msg:
            return
        raise


def insert_claim(client, claim, jurisdiction_id, source_snapshot_id):
    # Idempotent: dedup index claims_transformer_dedup_idx makes re-inserts a
    # no-op via on_conflict. Safe to re-run transform.py on the same document.
    row = {
        "jurisdiction_id":    jurisdiction_id,
        "zone_district_code": claim.zone_district_code,
        "rule_key":           claim.rule_key,
        "constraint_kind":    claim.constraint_kind,
        "value_kind":         claim.value_kind,
        "value":              claim.value,
        "scope":              claim.scope,
        "source_snapshot_id": source_snapshot_id,
        "section_ref":        claim.section_ref,
        "source_class":       "official",
        "review_state":       "extracted",
        "claim_version":      1,
        "retrieved_at":       datetime.now(timezone.utc).isoformat(),
        "notes":              claim.notes,
        "source_table_id":    claim.source_table_id,
    }
    client.table("claims").insert(row).execute()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("document_id")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--show-unmapped", action="store_true")
    args = ap.parse_args()

    client = get_client()
    jurisdiction_id, source_snapshot_id = lookup_document_context(client, args.document_id)
    mapper = LabelMapper(HERE / "label_mapping.yaml")

    if not args.dry_run:
        claims_cleared, unmapped_cleared = clear_previous_extraction(
            client, args.document_id, source_snapshot_id
        )
        print(f"Cleared {claims_cleared} extracted claims and "
              f"{unmapped_cleared} unmapped labels from prior run")

    tables = fetch_document_tables(client, args.document_id)
    print(f"Loaded {len(tables)} document_tables rows")

    stats = {
        "tables_seen": 0,
        "tables_by_shape": {},
        "rows_extracted": 0,
        "rows_ignored": 0,
        "rows_unmapped": 0,
        "claims_built": 0,
        "claims_inserted": 0,
        "claims_failed": 0,
    }

    insert_errors: list[str] = []
    unmapped_details: list[tuple] = []

    for table in tables:
        stats["tables_seen"] += 1
        det = detect_shape(table)
        stats["tables_by_shape"].setdefault(det.shape.value, 0)
        stats["tables_by_shape"][det.shape.value] += 1
        if det.shape == Shape.UNKNOWN:
            continue

        for ex in extract(det.shape, table):
            stats["rows_extracted"] += 1
            mo: MapOutput = mapper.map(ex)
            if mo.result == MapResult.IGNORED:
                stats["rows_ignored"] += 1
                continue
            if mo.result == MapResult.UNMAPPED:
                stats["rows_unmapped"] += 1
                unmapped_details.append((ex.label_path, ex.row_label, ex.zone, ex.table_number))
                if not args.dry_run:
                    try:
                        log_unmapped(client, ex.document_table_id, ex.label_path)
                    except Exception as e:
                        insert_errors.append(f"unmapped log failed: {e}")
                continue
            for m in mo.claims:
                claim = build_claim(ex, m)
                if claim is None:
                    stats["claims_failed"] += 1
                    continue
                stats["claims_built"] += 1
                if not args.dry_run:
                    try:
                        insert_claim(client, claim, jurisdiction_id, source_snapshot_id)
                        stats["claims_inserted"] += 1
                    except Exception as e:
                        msg = str(e)
                        if "23505" in msg or "duplicate key" in msg or "claims_transformer_dedup_idx" in msg:
                            stats.setdefault("claims_skipped_existing", 0)
                            stats["claims_skipped_existing"] += 1
                        else:
                            stats["claims_failed"] += 1
                            insert_errors.append(
                                f"{claim.rule_key} zone={claim.zone_district_code} scope={claim.scope}: {e}"
                            )

    print("\n=== Summary ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    if args.show_unmapped and unmapped_details:
        print(f"\n=== Unmapped rows ({len(unmapped_details)}) ===")
        for lp, rl, z, tn in unmapped_details:
            print(f"  table={tn} zone={z} label_path={lp} row_label={rl!r}")
    if insert_errors:
        print(f"\n=== First 10 errors (of {len(insert_errors)}) ===")
        for err in insert_errors[:10]:
            print(f"  {err}")


if __name__ == "__main__":
    main()
