# Claim Transformer

Deterministic pipeline: `document_tables` → `claims`. No LLM in the
generation path; the LLM is for navigation in the Sources tab (separate
pipeline, separate session).

## Four seams

1. `detect.py` — shape detectors. Pure functions over a `document_tables`
   row → returns shape id + confidence. No jurisdiction knowledge.
2. `extract.py` — per-shape extractors. Turns a typed row into neutral
   `RawExtraction` tuples (label_path, value, unit, footnotes, scope_hints,
   zone). Still no jurisdiction or rule_key knowledge.
3. `map.py` — label mapper. Reads `label_mapping.yaml`. Returns
   `(rule_key, constraint_kind, scope_keys)` or None. Data-driven; the
   YAML is the file every new jurisdiction grows.
4. `build.py` — claim builder. Combines extraction + mapping +
   table-level context → claim dict matching the ontology. Validates
   against `claim_value_shape_valid` shape rules before insert.

Anything `map.py` returns None for is logged to `unmapped_table_labels`.

## Entry point
python transform.py <document_id>

Reads document_tables for the doc, runs all four seams, writes draft
claims, logs unmapped labels.

## Out of scope

- The Sources tab UI for editing claims and resolving unmapped labels.
- Project overrides (see `_pending_project_overrides.sql.todo`).
- LLM navigation in Sources tab.
- Re-running the transformer on documents with edited claims (transformer
  always inserts new drafts; never updates existing rows).
