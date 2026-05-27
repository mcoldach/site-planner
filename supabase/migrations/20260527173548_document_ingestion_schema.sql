-- =============================================================================
-- Phase 1 document ingestion skeleton — schema only (no UI, no ingest script yet).
--
-- Three new tables capture the ingestion pipeline:
--   documents         -- the uploaded PDF, linked to a jurisdiction + source_snapshot
--   document_tables   -- tables EXTRACTED from a document (rich JSONB; cells are
--                        individually addressable later when Phase 2 claim-proposal
--                        lands)
--   document_chunks   -- prose chunks + embeddings (pgvector) for semantic retrieval
--
-- documents <-> source_snapshots: separate tables, documents.source_snapshot_id FK.
-- source_snapshots remains the provenance authority for claim citations; documents
-- is the ingestion-pipeline object that links to a snapshot. Claims still cite
-- source_snapshots unchanged.
--
-- RLS classification: jurisdiction knowledge — shared-reference. Authenticated
-- users may READ. Writes restricted to the owner (the uploader) — consistent
-- with the auth layer just landed. This is the third-module data layer.
-- =============================================================================

-- pgvector for the embeddings column. (Already present in the project per
-- the stack decisions; this is idempotent.)
create extension if not exists vector with schema extensions;

-- ---- documents -----------------------------------------------------------
create table documents (
  id                  uuid primary key default gen_random_uuid(),
  jurisdiction_id     uuid not null references jurisdictions(id) on delete restrict,
  source_snapshot_id  uuid references source_snapshots(id) on delete set null,
    -- The provenance snapshot this document represents (or null until
    -- ingested/registered). Claims continue to cite source_snapshots directly;
    -- this link lets us trace a snapshot back to its uploaded PDF.

  owner_id            uuid default auth.uid(),
    -- Uploader. Auto-stamped via the same pattern as projects/schemes.

  filename            text not null,            -- the original PDF filename
  storage_path        text not null,            -- path in the 'documents' Storage bucket
  title               text,                     -- "El Paso County Land Development Code"
  code_type           text,                     -- 'ordinance' | 'code' | 'statute' | 'master_plan' | 'guideline' (free text)
  version             text,                     -- "2024-03 amendment" — code amendments matter for cited truth
  effective_date      date,                     -- when this version took effect
  source_url          text,                     -- official source URL (Municode, AmLegal, etc.)

  ingest_status       text not null default 'uploaded',
    -- 'uploaded' (file in Storage, not yet processed)
    -- 'processing' (ingest script running)
    -- 'ingested'   (tables + chunks captured)
    -- 'failed'     (with error in ingest_error)
  ingest_error        text,
  ingested_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index documents_jurisdiction_id_idx on documents (jurisdiction_id);
create index documents_owner_id_idx on documents (owner_id);

create trigger documents_set_updated_at
  before update on documents for each row execute function set_updated_at();

-- ---- document_tables -----------------------------------------------------
-- Tables EXTRACTED from a document. Rich JSONB preserves the table's structure
-- (headers + hierarchical row labels + cells with values, units, raw text) so
-- Phase 2 claim-proposal can derive proposed_claims from cells with full context.
create table document_tables (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  table_number    text,        -- "Table 7.4.2-A"
  caption         text,        -- "Single-Family and Two-Family Residential District Dimensional Standards"
  page_number     integer,     -- where it was found in the PDF

  headers         jsonb not null default '[]'::jsonb,
    -- array of column headers, e.g. ["Zone District", "A", "R-E", "R-1 9", "R-1 6", "R-2", "R-4", "R-5"]

  rows            jsonb not null default '[]'::jsonb,
    -- array of {label_path: [string], cells: [{column, value, unit, raw_text}]}
    -- e.g. {
    --   "label_path": ["Lot Standards","Lot area (minimum)","Single-Family Detached"],
    --   "cells": [
    --     {"column":"A","value":5,"unit":"ac","raw_text":"5 ac"},
    --     {"column":"R-1 9","value":9000,"unit":"sf","raw_text":"9,000 sf"},
    --     ...
    --   ]
    -- }

  raw_extracted   jsonb,
    -- full pdfplumber output for re-processing if the parser improves later

  created_at      timestamptz not null default now()
);

create index document_tables_document_id_idx on document_tables (document_id);
create index document_tables_rows_gin on document_tables using gin (rows);
create index document_tables_headers_gin on document_tables using gin (headers);

-- ---- document_chunks -----------------------------------------------------
-- Prose chunks from a document, with embeddings, for semantic retrieval.
-- Tables are NOT chunked into here — they live as structured data in
-- document_tables. This is the "non-table prose" pipeline.
create table document_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  chunk_index     integer not null,                 -- order within the document
  page_number     integer,                          -- starting page (chunks may span)
  section_ref     text,                             -- best-effort section ref if detectable
  text            text not null,
  embedding       extensions.vector(768),           -- nomic-embed-text dimensions
  token_count     integer,                          -- for budget/inspection
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index document_chunks_document_id_idx on document_chunks (document_id);
-- A vector similarity index is deferred until there's enough data to warrant
-- one (HNSW or IVFFlat). At pilot scale (handful of docs), seq scan is fine.

-- =============================================================================
-- RLS — shared-reference reads, owner-restricted writes. Same pattern as the
-- distinction we drew in the auth step: reference data readable by any
-- authenticated user, writes scoped to the owner who created the row.
-- =============================================================================

alter table documents enable row level security;
create policy documents_select on documents for select
  to authenticated using (true);
create policy documents_insert on documents for insert
  to authenticated with check (owner_id = auth.uid());
create policy documents_update on documents for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy documents_delete on documents for delete
  to authenticated using (owner_id = auth.uid());

-- document_tables / document_chunks inherit ownership transitively via the
-- parent document (they have no owner_id of their own — they're an extension
-- of the document's structure, same way sites/site_parcels are extensions of
-- a project).
alter table document_tables enable row level security;
create policy document_tables_select on document_tables for select
  to authenticated using (true);
create policy document_tables_insert on document_tables for insert
  to authenticated with check (exists (
    select 1 from documents d where d.id = document_tables.document_id and d.owner_id = auth.uid()
  ));
create policy document_tables_delete on document_tables for delete
  to authenticated using (exists (
    select 1 from documents d where d.id = document_tables.document_id and d.owner_id = auth.uid()
  ));

alter table document_chunks enable row level security;
create policy document_chunks_select on document_chunks for select
  to authenticated using (true);
create policy document_chunks_insert on document_chunks for insert
  to authenticated with check (exists (
    select 1 from documents d where d.id = document_chunks.document_id and d.owner_id = auth.uid()
  ));
create policy document_chunks_delete on document_chunks for delete
  to authenticated using (exists (
    select 1 from documents d where d.id = document_chunks.document_id and d.owner_id = auth.uid()
  ));

-- =============================================================================
-- Storage bucket for PDFs. The bucket is created here (idempotent). Per-object
-- access policies are set in the Supabase dashboard or via storage.objects
-- policies; for V1 we'll restrict via the documents-table RLS (the storage
-- bucket is private, accessed via signed URLs from the app/ingest script).
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
