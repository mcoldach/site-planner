-- Add edit_note column on claims for ordinance-level corrections.
-- Required on edited versions, NULL on transformer-generated or seed rows.
-- Enforcement (NOT NULL on edits) lives in the edit RPC, not at the column
-- level — the column must permit NULL on initial inserts.

alter table public.claims add column edit_note text;

comment on column public.claims.edit_note is
  'Required note when a claim is edited from its transformer-generated or source-derived form. NULL on rows created by the transformer or seed/initial ingest. Edits flow through an RPC that enforces non-null.';
