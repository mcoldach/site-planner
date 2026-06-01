# Project Compass — Constraint-Aware Site Planning Workbench

Distilled working reference. The five strategy PDFs are the full source.

**How to use this file:** Only the **Current state** block below changes
session-to-session — update it in ~2 minutes at the end of a session (append a
decision line, move the phase pointer, edit the open list). Everything under
**Frozen reference** is write-once and rarely touched.

---

# CURRENT STATE

_The only part that changes regularly. Decisions log is append-only — never
delete a line. When an open question is resolved, delete it from the open list
and append the resolution to the decisions log._

## Where I am

**Phase 1 complete. Phase 2 — opener: multi-polygon schemes (data-model
change), then hybrid retrieval + claim-proposer.**

Last working session (2026-05-27): finished the document ingestion pipeline
end-to-end on the CS UDC, after a mid-session API key leak that was fully
remediated.

## Decisions log (append-only)

- **2026-04-19** — Project seeded. Stack, principles, vocabulary fixed from the
  five strategy PDFs. (See Frozen reference.)
- **2026-04** — Phase 0 done: 4 seeded parcels across 2 jurisdictions, MapLibre
  + OpenFreeMap positron basemap, parcel search w/ keyboard nav + fly-to,
  citation panel with live source links.
- **2026-04** — Authoritative data sources locked: CO statewide parcels
  FeatureServer (`gis.colorado.gov`) covers both jurisdictions; CS city limits
  `gis.coloradosprings.gov` (MapServer); EPC boundary
  `gisservices.elpasoco.com`. Both publish EPSG:2232 → reproject to 4326.
- **2026-04** — Real data diverges from assumptions: the 112-acre EPC parcel is
  I-2 industrial, not assumed A-35 rural. Always verify zone codes from
  authoritative GIS, never infer from parcel size.
- **2026-04** — Compound zoning strings (e.g. `"BP/CR CU HS SS"`) preserved in
  `raw_attrs.zoningCode`; `parcels.zone_district_code` holds only the
  normalized base zone for claim matching.
- **Phase 1** — Editor loop: schemes saved/loaded per project, **compliance
  re-run on load** (not cached). Save→check→render uses `save_scheme` RPC
  (geometry conversion server-side) + `check_scheme_compliance`. Scheme
  switching via dropdown selector (view-only). Footprint SF = **geodesic area
  of the drawn sketch** (feasibility-grade, honest it's a sketch).
- **Phase 1** — Terra Draw integrated raw (not the watergis control) +
  `terra-draw-maplibre-gl-adapter`, MapLibre 5.24.0. Edit-in-place works
  (`update_scheme`, not insert-new) — duplicate-scheme problem solved.
- **Phase 1** — Auth + RLS: shared-reference tables authenticated read-only,
  owner-scoped writes.
- **2026-05-27** — **PDF parsing tool is pdfplumber**, not Docling/PyMuPDF as
  originally speculated. Local Python ingest script is the right specialty tool
  even though the app is TS/Deno.
- **2026-05-27** — Table parser uses a **swappable strategy registry**
  (`generic` + `amlegal`; `municode` deferred to EPC ingest). Publisher detected
  from first-page text. Every `document_tables` row preserves `raw_extracted`
  so the parser can be re-run retroactively without re-ingesting. Added
  `documents.parser_strategy`, `document_tables.parser_confidence`,
  `document_tables.warnings`.
- **2026-05-27** — Prose chunker skips text inside detected table bboxes (no
  double-ingestion); ~500-token chunks, ~50 overlap; per-char page provenance.
  LM Studio batch embedder (nomic-embed-text-v1.5, 768-dim, 32/request).
- **2026-05-27** — `search_chunks` RPC: server-side cosine via pgvector `<=>`;
  needs `set search_path = public, extensions` (operators live in `extensions`).
  `ingest.py <doc_id>` wraps parse + embed into one command.
- **2026-05-27** — **KEY INSIGHT: claim-proposer needs HYBRID retrieval** —
  vector over `document_chunks` + structured query over `document_tables`.
  Embeddings alone can't surface a numeric rule whose value lives in a table
  cell (proven: lot-area query returned only mediocre prose hits because the
  value is in Table 7.4.2-A, not prose).
- **2026-05-27** — **API key rotation incident.** Service-role key was committed
  to git (GitHub secret scanning caught it). Remediated: broadened `.gitignore`
  to `.env`/`.env.*` w/ `!.env.example`; `git rm --cached scripts/ingest/.env`;
  migrated to Supabase new publishable+secret key system; disabled legacy keys
  (leaked key now dead). Required `supabase-py` 2.9.1 → 2.30.0 (older versions
  reject `sb_secret_` keys via client-side regex). **Lesson: verify env file
  *contents* after an edit, not just that an edit happened.**
- **2026-05-27** — Migration CLI works again: `supabase db push` succeeded. The
  Phase 0 migration-history desync appears resolved during Phase 1 auth work.
  _(Confirm with `supabase migration list`; if clean this is settled.)_

## Open / parked (delete when resolved → log the resolution above)

**Phase 2 openers:**
- **Multi-polygon schemes.** A Scheme should hold multiple footprints (vocab
  says "footprints" plural). Currently single-polygon. Data-model change —
  decide: child `scheme_footprints` table vs `MultiPolygon` column; how
  `check_scheme_compliance` handles it (per-footprint setbacks? summed coverage?
  union vs piecewise?); Terra Draw multi-feature save/load. Read schema + RPCs
  before proposing.
- **Hybrid retrieval + claim-proposer foundation.** Fuse `search_chunks` with
  structured `document_tables` queries; LLM proposes a Claim w/ provenance +
  review state; never truth until approved.

**Phase 2 backlog:**
- **EPC LDC ingest** — upload Municode PDF, run generic strategy, write
  `strategies/municode.py` for the diffs. The real test of the strategy registry.
- **`lookup-parcel` geometry bug** — new-APN lookups resolve jurisdiction +
  citations but parcel geometry doesn't render on map (Phase 0 only tested 4
  seeded parcels). Isolate to the geometry path.
- **EPC unincorporated boundary** — `ST_Difference` of county polygon minus
  union of incorporated municipalities (CS, Fountain, Monument, Manitou Springs,
  Palmer Lake, Green Mountain Falls, Calhan, Ramah). Expensive to get wrong.
- **Rule-keys ontology** — formalize before claims pass ~50; keys must be clean
  (a malformed `setback.front.max (build-to)` already had to be fixed). Plus
  logged `lot.area.min` → `scalar_min` engine fix.
- **Overlay / compound-zoning modeling** for claims — unresolved. Also: doc
  contains both per-zone tables (7.2.2-A…E) and combined matrix (7.4.2-A) for
  the same rules → claim-proposer needs an authoritative-table dedup policy.
- **Ingest cleanup** — `parse_tables` + `embed_chunks` each download the PDF;
  share it. Pin Python deps (`requirements.txt`). Chunker re-runs
  `find_tables()`; reuse 3c detection.
- **Parser refinements (low priority)** — `label_path` resets stack on new
  section header rather than nesting; 54 low-confidence `document_tables` rows
  are pre-zoning layout artifacts (correctly flagged, preserved).
- **Editor follow-ups** — delete-a-scheme; directional setbacks (needs
  road/frontage layer; engine currently uniform-conservative); basemap
  Protomaps swap if CORS recurs.
- **Vercel deployment** — deferred until there's a real reason to share a URL.

**Still-open original questions (unresolved):**
- Claim-conflict resolution when two authoritative sources disagree.
- Minimum claim schema that survives Phase 3 citation UX without refactor.
- Ground-truth set to curate first for testing the constraint extractor.
- UI line between "approved claim" and "AI draft" — what makes it legible.
- Google 3D Tiles gating granularity (per session / user / workspace).
- Minimum-viable honest BoE formula set for Phase 2.

---

# FROZEN REFERENCE

_Write-once. Settled in the strategy PDFs. Touch only if a core decision
genuinely changes (and then log it above)._

## One-paragraph pitch
A browser-first workbench that turns parcel geometry, governing rules, and
public records into a cited, editable site scheme with a linked first-pass
underwrite. Pilot: Colorado Springs (city) + unincorporated El Paso County.
Differentiation: source-traceable jurisdictional truth, not another site-plan
viewer or zoning chatbot.

## The wedge
**Are:** cited constraint register + editable parametric scheme + scheme-linked
BoE underwrite.
**Are not:** TestFit, Autodesk Forma, a zoning chatbot, a BIM tool, a
permit-ready platform, a survey-grade tool, a full "development OS."

## Eight decisions that must be right
1. Governing authority (city vs county) is first-class. Two jurisdiction packs
   from day one.
2. Postgres + PostGIS is the single canonical spatial truth store.
3. "Claims with provenance" — RAG alone is not enough; claims are approved,
   superseded, conflicted, and consumed downstream.
4. Schemes are parametric primitives (footprints, heights, parking fields), not
   meshes.
5. Every underwrite is linked to a specific Scheme version.
6. Default to open/cheap context (MapLibre + PMTiles + Overture). Gate expensive
   context (Google 3D Tiles) behind auth + metering.
7. Voice is an interface layer, not the architecture center. Chained pipeline
   only.
8. Version sources and outputs separately so you can explain why yesterday's
   answer changed today.

## Stack (decided)

| Layer | Choice |
|---|---|
| Shell | React + Vite + TypeScript |
| 2D map / editor | MapLibre GL JS + Terra Draw → custom editing tools |
| 3D scheme view | Three.js + React Three Fiber |
| Default context | PMTiles + Overture + open terrain |
| Premium context | Google Photorealistic 3D Tiles (gated review mode only) |
| Database | Supabase-managed Postgres + PostGIS + pgvector + JSONB |
| Jobs | Graphile Worker |
| Auth | Supabase Auth (magic links / OTP) + RLS |
| PDF parsing | **pdfplumber** (local Python ingest, strategy registry) |
| Embeddings | LM Studio local — nomic-embed-text-v1.5 (768-dim) |
| Memory / search | Postgres FTS + pgvector hybrid |
| Voice | Chained pipeline: STT + browser SpeechSynthesis |
| AI control | One copilot, deterministic tools, explicit approvals |
| Underwriting | Custom BoE engine; DCF later |
| Object storage | Cloudflare R2 (Supabase Storage in use for ingest now) |
| Export | SheetJS (Excel) first; PDF via Playwright later |
| Deployment | Web app first; Tauri wrapper later with sidecars |

## Data model (minimum viable)

- **Project** — container; people, roles, notes.
- **Site / Assemblage** — parcels + merged geometry + governing-authority
  membership. Operational truth.
- **Jurisdiction Pack** — authority-specific rules, portals, parser mappings,
  layer registry, freshness policy.
- **Source Snapshot** — retrieved artifact with URL, timestamp, checksum,
  license.
- **Claim** — structured statement + source links + geometry scope + review
  state + version.
- **Constraint** — approved datum derived from claims + geometry.
- **Scheme** — editable parametric design (primitives, not meshes; **multiple
  footprints** per scheme).
- **Underwrite** — scenario linked to a specific Scheme version + approved
  assumption set.
- **Review / Issue / Override** — first-class audit objects.

**Truth hierarchy:** official sources > third-party professional docs > project
notes > AI inference. Lower classes never silently overwrite higher ones. AI
inference is always marked as draft until approved.

## Phases

**Phase 0 — Setup & Validation** _(done)_: sample parcel in PostGIS via
MapLibre; ingest one zoning PDF; one cited zoning answer. Stack works
end-to-end.

**Phase 1 — Foundation** _(done)_: app shell + auth + schema + map + basic
geometry editing + document ingestion pipeline.

**Phase 2 — First workflow** _(current)_: parcel → upload code → extract
constraints with citations → draw scheme → BoE output, end to end.

**Phase 3 — Strengthen loop:** scheme versioning + editor polish + citation UX
+ richer BoE + light copilot assistance.

**Phase 4 — Extensions:** Tauri desktop, local AI sidecars, more jurisdictions,
full DCF, exports, scale.

## Top risks (one-liner each)

1. PDF parsing is brittle → human-review queues from day one.
2. pgvector scale pain at volume → hybrid search with FTS; don't over-index on
   embeddings.
3. Map performance with large GeoJSON → simplify, tile, chunk; no county-sized
   GeoJSON in the browser.
4. Solo-founder scope creep → the single biggest risk; delay, don't add.
5. Data-model tangling → each entity versioned and authority-scoped from the
   start.
6. Vendor lock-in → keep map and LLM providers swappable behind abstraction.
7. Trust breakdown without traceability → every UI number shows a because-chain.
8. Agent brittleness → one copilot, deterministic tools, no swarms.
9. Regulatory drift → packs are data/config, not code.
10. Cost surprises → meter Google tiles, cache LLM calls, watch token burn.

## Cost ladder
- Phase 0: ~$0–5 · Phase 1: ~$0 · Phase 2: $10–30 · Phase 3: $50–100 ·
  Phase 4: $100+

## Anti-patterns (refuse myself)
- "Dump rules into a vector DB and ask GPT" → confident-nonsense trap.
- "Hardcode Colorado Springs as *the* jurisdiction" → two packs from day one.
- "Ship 3D photoreal as the main canvas" → cost-blowup trap.
- "Store scheme geometry in React state" → breaks single-truth-store.
- "An agent swarm can handle this" → one copilot, deterministic tools.
- "Add Tauri + local AI in Phase 1" → Phase 4; pushing it forward is scope creep.
- "Survey-grade" framing in the UI → V1 is feasibility-grade.
- "Rebuild polygon editing from scratch" → use Terra Draw primitives.

## Inspirations — what to copy
**VibeSail:** custom-build the product-defining interactions; borrow
high-fidelity context (Google 3D tiles); gate it behind sign-in when costly.
**Pascal editor (pascalorg/editor):** parametric, browser-native,
editable-primitive editor. The editor *is* the product.

## Key paths & facts
- Repo: `github.com/mcoldach/site-planner` · Local: `/Users/michaeloldach/dev/site-planner`
- Migration filenames: 14-digit `YYYYMMDDHHMMSS`. Never rename the one legacy
  8-digit file (`20260419_phase_0_schema.sql`) — already applied remotely.
- Regulatory sources: CS UDC on American Legal Publishing (amlegal.com); EPC LDC
  on Municode.
- Test ingest doc: CS City Code, id `99381cc5-26d9-4191-be23-49556082b9c2`.
- Ingest entry point: `python ingest.py <doc_id>` in `scripts/ingest/`.
**2026-05-30** — Transformer foundation shipped. `scripts/transformer/` with
detect/extract/mapping/composites/build/transform modules,
`label_mapping.yaml`, `unmapped_table_labels` table. First shape:
per-zone-dimensional (CS UDC tables 7.2.2-* through 7.2.4-*). End-to-end run
produced 133 extracted claims across 9 rule_keys and 16 zones (plus the 16
seeded approved claims for 149 total). 5 rows punted to unmapped queue
(density-band, complex composite, mis-classified parking).

**2026-05-30** — Idempotency locked. `claims_transformer_dedup_idx` is a
partial unique index with `NULLS NOT DISTINCT` on (source_table_id, rule_key,
zone_district_code, scope, review_state) WHERE source_table_id IS NOT NULL.
`unmapped_dedup_idx` the same on (document_table_id, label_path_text).
Transformer catches 23505 and counts as skipped. Verified by re-running:
139/139 skipped, 0 inserted, 0 failed.

**2026-05-30** — Spec drift caught at run time. `rule_keys.md` §12 referenced
`review_state='draft'` and `source_class='official_source'`. The live enums
are extracted/reviewed/approved/superseded/rejected/conflicted and
official/professional/project_note/ai_inference. Strict-write policy caught
it before pollution. Backlog: update `rule_keys.md` to match the schema.

**2026-05-30** — Postgres NULL-in-unique-index trap: first dedup index was
created without `NULLS NOT DISTINCT`, so all 24 claims with
zone_district_code=NULL evaded uniqueness on the second run. Fixed by
drop+recreate with `NULLS NOT DISTINCT` (Postgres 15+ syntax, Supabase
supports). Worth remembering for every future partial unique index where a
key column can be NULL.

**Phase 2 backlog reshuffle:**
- "Hybrid retrieval + claim-proposer foundation" REPLACED with two items:
  → Claim transformer (deterministic, table→claims) [first shape DONE]
  → Source navigation (LLM as read tool, Sources tab) [future]
- Next shapes: per-zone-matrix (7.4.2-*) and per-use (7.4.10-*).
- After shape coverage: Sources tab UI for review + claim editing
  (`edit_claim` RPC + UI surface; required `edit_note` enforced at RPC).

**Known limitations carried forward:**
- 24 of the 133 extracted claims have zone_district_code=NULL because their
  source document_tables rows had null caption AND null table_number. Claims
  traceable via source_table_id; zone needs a second derivation pass.
- Per-zone-dimensional detector mis-classified 7.4.10-G as in-shape. Detector
  precision improves when per-use detector lands.
- Parser produced label_path=[] on some tables. Worked around in mapper via
  row-label-based category fallback. Real fix is upstream in parser.
- `rule_keys.md` uses outdated review_state and source_class vocabulary;
  update.
- `documents.source_snapshot_id` was null on the CS UDC doc (Phase 1 ingest
  didn't fully wire); manually backfilled. Phase 1 ingest should set it at
  upload time.
- `source_snapshots.checksum` is null on the existing CS UDC snapshot;
  Phase 1 ingest doesn't compute checksum yet.


**2026-05-30 (PM)** — Second table shape shipped: **per-zone-matrix** (CS UDC
7.4.2-A…D). Run inserted the matrix claims (7.4.2-A full: 50; C/D footnote-free
leaves added on top; 208 claims_built across the doc, claims_failed: 0,
~133 dimensional skipped idempotent). New scope coverage: zones A and R-4
appear for the first time.

**2026-05-30 (PM)** — **Detector precedence is load-bearing: matrix BEFORE
dimensional.** The dimensional detector keys on label_path[0] category
prefixes (Lot/Setbacks/Height/Other), which the matrix tables ALSO satisfy —
so dimensional was silently claiming all 4 matrix tables, running them through
_extract_per_zone_dimensional (which reads cells[0] as the row label; in a
matrix that's a numeric zone cell), and producing zero claims while looking
like nothing happened. They were never "unknown" — they were mis-eaten. Matrix
detector uses a precise headers[0]=="Zone District" signature (present in
A–D, absent in 7.4.2-E×2/F) and runs first. Classification went 26 dimensional
→ 22 dimensional + 4 matrix, unknown unchanged at 82.

**2026-05-30 (PM)** — **Shape-scoped mapping namespace** is the standing fix
for cross-shape label collisions. The same string means opposite things across
shapes: "maximum" and "single-family attached" are ignore_rows (dividers) in
dimensional but REAL rules in the matrix. label_mapping.yaml now has a
top-level per_zone_matrix: block (own categories/rows/composites/ignore_rows),
selected by ex.shape (stamped on RawExtraction in extract()). Dimensional block
left byte-identical as the default → 133 dimensional claims regression-verified
unchanged.

**2026-05-30 (PM)** — **density.residential** added — first new rule_key since
the ontology froze. From 7.4.2-A "Residential density (maximum)": R-4 8 du/ac
[footnote 6], R-5 25 du/ac. WATCH: value_kind=number with unit "du/ac" passes
the CHECK but du/ac is a density, not a length/area. Fine for v1 (§6 defers
unit normalization) but flag for units-vocab promotion and for Migration B
compliance (density checks against lot area, not a linear comparison).

**2026-05-30 (PM)** — build.py now merges the §8.8 prose qualifier (split out
of a polluted unit field by the extractor) WITH footnote markers into notes.
Previously it built notes from footnotes only, dropping the qualifier. Verified
on R-1 6 House-General front setback (15 ft + "or average of two adjacent…").

**2026-05-30 (PM)** — §10 coexistence verified concretely. R-1 6 shows two
source_table_ids per shared rule (matrix 7.4.2-A 3379… + dimensional de4e…):
lot.width 1+1 (clean agreement, same value), lot.coverage 5+1 (matrix bands vs
dimensional single value — the granularity divergence), setback.front 1+4.
Safe because dedup index includes source_table_id. Reviewer adjudicates in the
future Sources tab; engine-level dedup stays deferred.

**Phase 2 backlog updates:**
- NEXT SESSION FIRST TASK: footnote-stripping in _normalize_row_label
  (mapping.py). ~37 of tonight's 53 unmapped rows are footnote-only misses
  (C/D leaves: "Side (minimum) [4]", "Building height (maximum) [6]", etc.).
  Shared by both shapes → MUST carry its own dimensional regression check
  (footnoted dimensional rows would newly map too). Kept separate tonight to
  preserve the regression canary.
- Deferred, landing cleanly in unmapped queue: 7.4.2-C build-to range
  (Front Min/Max — needs a composite keyed on FULL path, never bare "maximum");
  7.4.2-D "Adjacent to residential" (contextual setback, §10); "District area
  (minimum)" (new rule_key, district-level not lot-level — decide rule_key).
- 7.4.2-B deferred BY DESIGN: compound use-class column headers ("R-Flex Low
  Residential Uses [1]") fail the extractor's simple-zone gate → emits nothing.
  Decomposing zone + residential/non-residential scope axis is its own session.
- Overlay-legend-into-notes (7.4.2-A legend: overlay districts supersede):
  NOT done — needs table-legend threaded onto every RawExtraction. Provenance
  polish, not correctness. Seam to add next session.
- Per-use shape (7.4.10-*) still pending — different scope axis (use_class),
  unused constraint_kind (ratio). The 7.4.10-G dimensional misclassification
  should resolve when that detector lands.

**2026-05-30 (PM)** — **Multi-polygon schemes (Opener A) DONE.** A Scheme now
holds multiple footprints. Closes the B1 backlog item; struck from Track B.

---

# PHASE 2 BACKLOG (consolidated 2026-05-30 PM)

_Single ordered queue. Supersedes the scattered Phase 2 items in Open/parked
above — clean those out next edit. Tracks are parallel; numbering within a
track is rough work order. Phase 2 is "done" when Track A has shape coverage +
a Sources tab, and Track B closes the parcel→code→constraints→scheme→BoE loop
end to end (Compass Phases section)._

## Track A — Claims / transformer (active)
A1. **[NEXT] Footnote-stripping in `_normalize_row_label`** (mapping.py).
    Recovers ~37 of the 53 unmapped (C/D footnoted leaves). Shared by both
    shapes → carries its own dimensional regression check.
A2. **Per-use shape (7.4.10-*).** New scope axis (use_class), first use of
    `ratio` constraint_kind. Should also resolve the 7.4.10-G dimensional
    misclassification. Own session — do NOT pair with A1.
A3. **Per-table deferrals** (after shapes land, each lands in unmapped now):
    - 7.4.2-C build-to `range` (Front Min/Max) — composite keyed on FULL
      label_path, never the bare "maximum" leaf.
    - 7.4.2-D "Adjacent to residential" — contextual setback (§10).
    - "District area (minimum)" (C/D) — new rule_key decision; district-level,
      not lot-level.
    - 7.4.2-B compound use-class columns — decompose zone + residential/
      non-residential scope axis. Own session.
A4. **Overlay-legend-into-notes seam.** Thread table-level legend onto every
    RawExtraction (7.4.2-A: "overlay districts supersede this table").
    Provenance polish, not correctness.
A5. **Sources tab UI** — review + `edit_claim` RPC (required `edit_note`
    enforced at RPC). Where the approved-claim vs AI-draft legibility line
    gets designed.
A6. **Source navigation** — LLM as read-only tool over the Sources tab.

## Track B — End-to-end Phase 2 workflow (the Compass goal)
B1. **Multi-polygon schemes (Opener A).** [CONFIRM STATUS — carried from
    Compass open list; recent sessions were all transformer.] Data-model:
    child `scheme_footprints` vs `MultiPolygon` column; `check_scheme_compliance`
    per-footprint vs summed coverage; Terra Draw multi-feature save/load.
B2. **Minimum-viable honest BoE formula set.** First-pass underwrite linked to
    a Scheme version. Feasibility-grade, not survey-grade.
B3. **`lookup-parcel` geometry bug.** New-APN lookups resolve jurisdiction +
    citations but parcel geometry doesn't render (only the 4 seeded parcels
    were tested). Isolate the geometry path.

## Track C — Jurisdiction pack #2
C1. **EPC LDC ingest.** Upload Municode PDF, run generic strategy, write
    `strategies/municode.py` for the diffs. The real test of the strategy
    registry — and the "two packs from day one" thesis.
C2. **EPC unincorporated boundary.** `ST_Difference` of county polygon minus
    union of incorporated municipalities (CS, Fountain, Monument, Manitou
    Springs, Palmer Lake, Green Mountain Falls, Calhan, Ramah). Expensive to
    get wrong — breaks governing-authority detection inside incorporated areas.

## Track D — Debts to clear before they compound
D1. **Migration B (destructive — GATED on shape coverage + proposer).** Update
    `check_scheme_compliance` to read constraint_kind/value/value_kind/scope;
    regression-check against existing schemes; drop `value_text`,
    `value_numeric`, `value_unit`; rename `claims_lookup_v2_idx` →
    `claims_lookup_idx`. Until then legacy columns stay populated.
D2. **24 zone_district_code=NULL claims.** Source rows had null caption AND
    null table_number; traceable via source_table_id; need a second zone
    derivation pass.
D3. **rule_keys.md §12 stale vocabulary.** review_state/source_class still
    reference old enums; align with live schema.
D4. **`du/ac` unit semantics** (density.residential). value_kind=number passes
    CHECK but du/ac is a density, not length/area. Flag for units-vocab
    promotion and Migration B density-vs-lot-area checks.
D5. **Ingest hardening.** Share the PDF download across parse/embed; pin deps
    (`requirements.txt`); reuse table detection instead of re-running
    `find_tables()`; set `source_snapshot_id` + compute `checksum` at upload.
D6. **Parser refinements.** Real upstream fix for the label_path stack-reset
    bug (resets on new section header instead of nesting — root cause of the
    7.4.2-A nesting we work around in the mapper). 54 low-confidence pre-zoning
    rows correctly flagged, preserved.

## Open questions to resolve within Phase 2
- Claim-conflict resolution when two authoritative sources disagree
  (distinct from §10 same-rule coexistence — this is genuine contradiction).
- Ground-truth set to curate first for testing the constraint extractor.
- Minimum claim schema that survives Phase 3 citation UX without a refactor.

## Explicitly Phase 3+ (NOT Phase 2 — guard against pull-forward)
Scheme versioning polish · richer BoE / DCF · citation UX · light copilot ·
Google 3D Tiles gating granularity · Vercel deploy (no URL to share yet).
