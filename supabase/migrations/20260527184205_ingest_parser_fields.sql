-- Step 3c prep: parser fields on documents + document_tables.
--
-- documents.parser_strategy — which strategy processed this doc
--   ('amlegal' | 'municode' | 'generic' | null=not yet parsed).
-- document_tables.parser_confidence — per-table heuristic
--   ('high' | 'medium' | 'low' | null).
-- document_tables.warnings — structured warnings the parser surfaces
--   for Phase-2 review prioritization. Array of {code, message}.

alter table documents       add column parser_strategy   text;
alter table document_tables add column parser_confidence text;
alter table document_tables add column warnings          jsonb not null default '[]'::jsonb;

create index document_tables_warnings_gin on document_tables using gin (warnings);
