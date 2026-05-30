create table public.unmapped_table_labels (
  id                uuid primary key default gen_random_uuid(),
  document_table_id uuid not null references public.document_tables(id) on delete cascade,
  label_path        jsonb not null,
  label_path_text   text generated always as (label_path::text) stored,
  first_seen_at     timestamptz not null default now(),
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now()
);

create index unmapped_label_path_text_idx
  on public.unmapped_table_labels (label_path_text);

create index unmapped_unresolved_idx
  on public.unmapped_table_labels (resolved_at)
  where resolved_at is null;

comment on table public.unmapped_table_labels is
  'Queue of label_path values the transformer could not map to a rule_key. Populated by transform.py.';
