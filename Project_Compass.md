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

**Phase 2 active. Track A CLOSED (2026-06-02). Track B in progress — B2
parcel enrichment + Edge Function caching fix.**

Last working session (2026-06-02 PM): Track A closed (all three finish-queue
items shipped). Municipal jurisdictions seeded (7 EPC municipalities). Map
refresh bug fixed. parcel_source migration pushed for Monument, Fountain,
Manitou Springs.

Current session (2026-06-02 evening): Track B2 — verifying parcel enrichment
pipeline, fixing the Edge Function caching gap so stale parcels auto-re-enrich.

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
- **2026-06-01** — Footnote-stripping in `_normalize_row_label` (mapping.py):
  added `_FOOTNOTE_RE.sub`, footnotes only — deliberately NOT
  `_PAREN_QUALIFIER_RE`, so "(minimum)"/"(maximum)" leaves stay distinct
  constraint_kinds. Recovered 37 of 53 unmapped (53→16; claims_built 208→245;
  37 inserted, 0 failed). All 37 are matrix C/D footnoted leaves
  (setback.side/rear/side_street, building.height, lot.area). Dimensional
  canary UNCHANGED at 133 — recovery was entirely matrix; the expected
  dimensional movement did not occur (no footnoted dimensional unmapped leaves
  existed). 16 survivors are exactly the intended deferrals: build-to Front
  Min/Max (6), District area minimum (4), Adjacent to residential (3),
  7.2.2-J stray (1), null-table row (1), 7.4.10-G (1). Provenance verified:
  notes build from CELL footnotes (7.4.2-D rows carry them); the strip does
  not touch that path.
- **2026-06-01** — D7 closed (contained): OR lot.area corrupt twin quarantined,
  correct 5000 sf twin already live; root cause is a duplicate-emitting
  thousands-separator split in the upstream ingest parser, not the transformer.
  Separately, the duplicate-audit surfaced D2 (null-zone claims) as a live
  compliance-correctness risk, not just missing metadata — re-scoped D2
  accordingly. D2 is its own session, not bundled with A2.
- **2026-06-01** — D2 diagnosed and closed by rejection. The 23 null-zone
  claims trace to four low-confidence tables where the parser misread the first
  data row as the header, discarding the zone and misaligning values. Zone
  unrecoverable; values untrustworthy; some were per-use tables mis-extracted
  by the dimensional shape. All 23 rejected with provenance notes — NOT
  re-derived. Re-scoped D6 as the shared upstream root cause (header misread +
  label_path reset) and linked D7's thousands-separator bug to the same parser.
  Correct values return on re-ingest after D6 + A2.
- **2026-06-01** — D6 root cause pinned to find_header_row
  (base.py GenericStrategy): the >=2-non-empty-cells header heuristic skips
  the sparse single-zone header row on dense pp.214-226 tables and promotes
  the first data row to header — the shared root cause of D2 (lost zone), D7
  (comma artifact from parse_cell on a value-string header), and the
  label_path issues. Fix = amlegal structural find_header_row override; needs
  the clean-table raw rows read first and a full re-ingest+re-transform
  regression plan (255-claim blast radius). Queued as its own session, coupled
  with A2.

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
B1. **Minimum-viable honest BoE formula set.** First-pass underwrite linked to
    a Scheme version. Feasibility-grade, not survey-grade.
B2. **`lookup-parcel` geometry bug.** New-APN lookups resolve jurisdiction +
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
D2. **23 null-zone claims — DIAGNOSED + REJECTED 2026-06-01. Root cause:
    parser header-row misread.** Traced all 23 to four low-confidence
    document_tables (pp. 214/217/219/226). In each, the parser captured the
    FIRST DATA ROW as the column header (e.g. headers ["","Residential density
    (maximum)","8 du/ac [3]"] and ["","Residential uses","1,500 sf per du"]),
    so the real header row — which carried the zone — was discarded before
    document_tables was written. Zone is therefore UNRECOVERABLE from the
    stored data (not in caption, sibling rows, or section_ref). Worse, the
    header misalignment makes the extracted value/label pairing unreliable, and
    at least one table (dea9f36a, p219) is a PER-USE table (use axis:
    residential/non-residential) mis-eaten by the dimensional extractor —
    source of the phantom scope keys (use_class:non_residential,
    adjacency:collector_parkway_arterial) seen on those claims. All 23
    quarantined (review_state='rejected') with provenance notes. Correct values
    return via re-ingest after the parser fix (D6) + per-use shape (A2) +
    matrix coverage. DO NOT attempt to re-derive zones onto these — values are
    not trustworthy.
D3. **rule_keys.md §12 stale vocabulary.** review_state/source_class still
    reference old enums; align with live schema.
D4. **`du/ac` unit semantics** (density.residential). value_kind=number passes
    CHECK but du/ac is a density, not length/area. Flag for units-vocab
    promotion and Migration B density-vs-lot-area checks.
D5. **Ingest hardening.** Share the PDF download across parse/embed; pin deps
    (`requirements.txt`); reuse table detection instead of re-running
    `find_tables()`; set `source_snapshot_id` + compute `checksum` at upload.
D6. **[ROOT CAUSE — diagnosed 2026-06-01, fix is own session] Parser
    header-row misdetection in find_header_row.** Location:
    scripts/ingest/strategies/base.py GenericStrategy.find_header_row (amlegal
    inherits it unchanged). Bug: it picks the first row (after row 0) with >=2
    non-empty string cells as the header. On CS UDC pp. 214-226 the TRUE header
    is the single-zone row — sparse (zone label in col 0, rest blank/merged) —
    so it fails the >=2 test, gets skipped, and the first DATA row (e.g.
    "Residential density (maximum)" / "8 du/ac [3]"; "Residential uses" /
    "1,500 sf per du") becomes the header. Consequences: (a) zone lost — the
    D2 root cause; (b) every cell's column label is a value string, so cell
    values misalign with labels; (c) parse_cell then runs on header-cell value
    strings like "1,500 sf per du" — this is ALSO the source of D7's
    thousands-separator artifact. One root cause, three symptoms (D2 + D7 +
    label_path nesting). The density heuristic is structurally inverted here:
    the real header is SPARSER than the data rows, so no threshold tweak fixes
    it. FIX: amlegal-specific find_header_row override using a structural signal
    (position / zone-pattern), NOT cell-count. PREREQUISITE before coding:
    read the raw rows of the CLEAN tables (7.2.2-*, 7.4.2-A) so the new rule
    correctly identifies the header on BOTH the sparse-zone and dense shapes —
    do not design it from the broken tables alone. BLAST RADIUS: fix requires
    re-running parse_tables.py (full re-ingest of document_tables) then the
    full transformer; ALL claims re-draft — the 23 D2-rejected return as fresh
    drafts and the 215 extracted regenerate. Needs a regression plan
    (snapshot claim counts by rule_key/zone before; diff after) BEFORE the
    re-run. Couple with A2 (per-use shape) so pp.214-226 re-ingest into the
    right shape. Own session.
D7. **Thousands-separator parse artifact — CONTAINED, root cause upstream.**
    2026-06-01: the corrupt 7.4.2-C OR lot.area row (n=5, unit=",00 sf") had a
    correctly-parsed TWIN already live in the same active set (n=5000,
    unit="sf"). So the thousands separator caused a duplicate emission upstream
    in the Phase 1 ingest parser (one cell → two values, one right one wrong),
    NOT a systemic 1000x corruption. Audit of all 245 claims for the comma
    fingerprint found exactly one corrupt row; it is QUARANTINED
    (review_state='rejected'), correct value already present. TODO whenever the
    ingest parser is next opened: find the thousands-separator split that
    double-emits, and add a build.py guard rejecting any claim whose unit
    begins with a digit/comma. Low priority — single known occurrence, contained.
    NOTE: the same header-misread (D6) put "1,500 sf per du" into a header cell
    on p219 — the thousands-separator handling and the header detection are
    entangled in the same parser; fix together.
D8. **Row-label footnote provenance.** notes are built from CELL footnotes
    only; row-label markers (`[4]/[5]/[6]`) are dropped where the cell has no
    own footnote (7.4.2-C recovered rows show notes=null). Decide whether
    row-level footnotes need threading into notes (build.py).

## Open questions to resolve within Phase 2
- Claim-conflict resolution when two authoritative sources disagree
  (distinct from §10 same-rule coexistence — this is genuine contradiction).
- Ground-truth set to curate first for testing the constraint extractor.
- Minimum claim schema that survives Phase 3 citation UX without a refactor.

## Explicitly Phase 3+ (NOT Phase 2 — guard against pull-forward)
Scheme versioning polish · richer BoE / DCF · citation UX · light copilot ·
Google 3D Tiles gating granularity · Vercel deploy (no URL to share yet).

- **2026-06-01** — D6 re-diagnosed and SPLIT; "K" shipped. The pinned D6
  root cause (find_header_row skips a sparse zone header) was WRONG — reading
  the raw grids showed three distinct table topologies, only one of which has
  a zone header. Actual bugs: **K** — the 7.2.x tables (7.2.2/7.2.3/7.2.4) are
  transposed 3-col key-value tables with NO column header; find_header_row ate
  their first data row. **F** — four titleless fragments (pp.214/217/219/226)
  orphaned by parse_tables continuation logic that only merges tables that BOTH
  kept their title (a continuation, by definition, lost its title). K and F are
  separate fixes; A2 (per-use 7.4.10-*) is a third. Shipped K only this session.
- **2026-06-01** — K fix = TWO coupled changes, not the "one-line amlegal
  override" D6 assumed: (1) AmLegalStrategy.find_header_row override returns
  None for the transposed-KV shape (strategies/amlegal.py); (2)
  _detect_per_zone_dimensional (transformer/detect.py) dropped its
  len(headers)>=2 gate — K makes these tables headerless, which would otherwise
  send them to UNKNOWN and drop them. Both needed or the re-ingest drops the
  7.2.x corpus.
- **2026-06-01** — K verified: all 7.2.2/7.2.3/7.2.4 tables now emit
  independent per-zone claims with own source_table_id (e.g. recovered
  setback.front=4 rows; per-zone lot.coverage, previously matrix-only).
  claims_failed=0, dimensional canary unchanged, rejected preserved at 24.
  Extracted set rebuilt to 244 clean.
- **2026-06-01** — transform.py was NOT idempotent despite the Compass claiming
  "safe to re-run." Insert-only + a PARTIAL dedup index
  (claims_transformer_dedup_idx, WHERE source_table_id IS NOT NULL) meant the
  re-run double-inserted: the 215 pre-K originals had null source_table_id so
  the index didn't cover them. FIXED: transform.py now wipes its own
  machine-extracted artifacts (extracted claims + unmapped labels for the
  document's source_snapshot) before re-inserting; preserves approved/rejected.
  "Safe to re-run" is now actually true.
- **2026-06-01** — KNOWN COSMETIC DEBT from K: parse_tables confidence rule
  stamps any no_header_row table as low, so the ~25 correctly-headerless 7.2.x
  tables now read parser_confidence='low' (67 low total). Display-only —
  nothing reads parser_confidence except the transformer's SELECT (it never
  branches on it). MUST be cleaned before F, because F's fragment-detection
  signal was "low-confidence titleless" and K just polluted the low bucket.
- **2026-06-01** — D2/D7 NOT closed by this re-ingest (correcting the prior
  "returns via re-ingest after D6+A2" note). K doesn't touch fragmentation; the
  23 rejected D2 claims and the p219 D7 fragment remain. They close on F.

- **2026-06-01** — F shipped: page-overflow fragment reattachment. Four
  titleless 3-col fragments were page-top continuations of tables that began on
  the prior page; pdfplumber emitted the overflow as a separate titleless table
  (title/zone only on the start page). New reattach_fragments pass (parse_tables
  Phase 1b) folds a fragment into the nearest PRIOR titled 3-col table when
  content dovetails by UDC section order (Lot/Density/District < Setbacks 
  Height < Other/Notes); a parent ending in a terminal section (Height/Notes/
  Other) is rejected (table already complete). Reattached: p214→7.2.2-A (zone A),
  p219→7.2.2-I (R-Flex Medium), p226→7.2.4-C (GI). Logical tables 108→105.
- **2026-06-01** — D2 CLOSED for 3 of 4 fragments; D7 CLOSED. p214/219/226 now
  produce correctly-zoned extracted claims (net-new — parents were 0-row stubs;
  the fragment WAS the table body). The 24 rejected D2 originals persist as audit
  history with correct twins now alongside. D7's "1,500 sf per du" artifact was
  the p219 fragment — folded into 7.2.2-I, extracted clean. claims_failed=0,
  review state intact (extracted 246 / approved 16 / rejected 24).
- **2026-06-01** — NEW DEBT (was D2's 4th fragment): **7.2.2-F (R-4) renders as
  a 1-column pdfplumber mis-parse.** The p217 fragment is R-4's actual body, but
  its true parent is the 1-col husk, not a valid 3-col reattach target — so the
  dovetail gate correctly leaves it ORPHANED (refusing to splice R-4 rows onto
  the backward-nearest R-2 table 7.2.2-E). R-4's claims stay zoneless/unmapped.
  Fix is upstream: a table_settings/find_tables change so 7.2.2-F extracts as a
  real 3-col table, after which its overflow reattaches like the others. NOT a
  fragmentation bug — a table-detection bug. Separate session.
- **2026-06-01** — F safety proof: no wrong-zone leakage. All section_ref=
  'unknown' extracted claims remain zone=null (incl. the p217 R-4 rows). The
  dovetail gate prevented the R-2/R-4 corruption it was designed to prevent.

- **2026-06-01** — A2-core shipped: first ratio value_kind/constraint_kind end
  to end. New Shape.PER_USE_RATIO detector (detect.py, registered LAST so it
  can't poach matrix/dimensional), _extract_per_use_ratio (extract.py; parses
  denominator+unit from the column header once — "Min. Spaces per 1,000 GFA" →
  denominator=1000, denominator_unit="sf", basis="GFA"; numerator from cell),
  a ratio branch in build_claim (build.py, gated on constraint_kind=ratio AND
  numeric AND denominator present), per_use_ratio block in label_mapping.yaml,
  and a row-only-block fix in mapping.py (_block_for gates on categories only
  when the block defines them). Scoped to Table 7.4.10-E ONLY.
- **2026-06-01** — A2-core verified: 3 parking.required ratio claims
  (residential / civic_institutional / commercial), value
  {"numerator":<n>,"denominator":1000,"denominator_unit":"sf","basis":"GFA"},
  scope use_class, zone NULL (jurisdiction-wide per rule_keys §8.5),
  §7.4.10-E. claims_failed=0 — first live exercise of the
  claim_value_shape_valid CHECK on a ratio; build.py JSON matched exactly.
  The "Other / As determined by the Manager" row correctly logs to unmapped
  (administrative discretion = absence of a constraint, NOT a prose_deferred
  claim — deliberately no YAML row for it).
- **2026-06-01** — 7.4.10 family RE-SCOPED (the old "A2 = per-use shape for
  7.4.10-*" conflated a section number with a table shape; the 8 tables are 8
  different shapes). A2-EXTEND (queued): 7.4.10-A (parking per DU + conditional
  bands — needs band expansion per rule_keys §8.7), 7.4.10-G (loading, prose —
  likely prose_deferred not ratio). OUT of A2 entirely (reference tables, not
  feasibility constraints, likely never claims): 7.4.10-B (bike % matrix),
  7.4.10-C (accessible-space brackets), 7.4.10-D (accessible dimensions),
  7.4.10-F (stall geometry), 7.4.10-H (stacking lanes). Principle: claim the
  ratios that drive site capacity; leave construction-detail reference parsed
  but unclaimed.
- **2026-06-01** — NOTE for before Migration B: migration filename collision
  observed — 20260522223445_rule_keys_ontology.sql is the SUPERSEDED early
  vocabulary table (old grammar: setback.front.min etc.); the real four-column
  ontology + claim_value_shape_valid CHECK is 20260530120000_rule_keys_
  ontology_v1.sql. Not a desync, but the Phase-1 "run supabase migration list
  to confirm" caveat was never actually closed — do it before Migration B,
  which is gated on trustworthy migration history.

- **2026-06-01** — HORIZON RECONCILED against repo (Compass had drifted):
  * Multi-POLYGON schemes (multiple footprints per scheme) = DONE (5-28
    scheme_footprints_cutover). Not open.
  * Multi-PARCEL assemblage (multiple parcels per site) = schema-ready but
    deferred. site_parcels join table + ST_Union plumbing exist; consumers
    (check_compliance_via_site, projects_geojson_view) hardcode "V1
    assemblage-of-one" via `limit 1`. The migrations call it "a data op, not a
    migration" — lifting the limit-1 guards + a >1-parcel association path is
    the remaining work. Contained, no schema change. (Track B.)
  These were conflated as one stale "multi-polygon schemes" horizon line.
- **2026-06-01** — DECISION: finish Track A before switching to Track B. Track
  A remaining = three small tracked items (below). Track B (B2 lookup-parcel
  geometry bug, multi-parcel assemblage, B1 minimum BoE) is next-track, started
  only after Track A closes.
- **2026-06-01** — TRACK A FINISH QUEUE (next session, in order):
  1. p217 R-4 fragment — title↔body page-split (NOT a 1-col detection bug; see
     2026-06-02 correction). 7.2.2-F (p216) extracts as a correct title-only
     1-col husk; R-4's body is a clean 3-col fragment on p217. Fix is a
     husk-reunification branch in reattach_fragments — fold a titleless 3-col
     body fragment onto an immediately-prior body-less titled husk — NOT a
     find_tables/table_settings change. Closes the last open D2 fragment.
  2. A2-extend — 7.4.10-A (parking per DU + conditional bands, needs band
     expansion per rule_keys §8.7) and 7.4.10-G (loading, prose -> prose_deferred
     not ratio). Builds on the proven A2-core ratio path.
  3. A3 deferrals (the unmapped set) — District-area-minimum (new district-level
     rule_key), Adjacent-to-residential (§10 contextual setback scope), build-to
     Front Min/Max (7.4.2-C composite). Each a defined mapping decision.
  Discipline reminder for all three: diagnose against the real file/data BEFORE
  prescribing (this session's D6 was misdiagnosed in the Compass and only the
  read-first discipline caught it). transform.py is now idempotent; re-runs safe.

- **2026-06-02** — CORRECTION (supersedes the 2026-06-01 "7.2.2-F renders as a
  1-column pdfplumber mis-parse" NEW DEBT entry and its table-DETECTION framing):
  the p217 R-4 problem is a **title↔body page-split, not a 1-col detection bug**.
  7.2.2-F on p216 extracts CORRECTLY — as a title-only 1-col husk (the zone
  title/header sits alone on p216 with no body rows). R-4's body is a **clean
  3-col fragment on p217**. So there is no mis-parse to fix in find_tables/
  table_settings; both pieces extract exactly as the PDF lays them out. The
  real fix is a **husk-reunification branch in reattach_fragments**: fold a
  titleless 3-col body fragment onto an immediately-prior body-less titled husk
  (distinct from F's overflow case, which folds a titleless fragment onto a
  prior table that already has a body). The earlier "1-col mis-parse" mechanism
  was wrong; the dovetail gate still correctly orphans the p217 rows until this
  reunification branch lands — no wrong-zone leakage in the interim.

- **2026-06-01** — Step 1 / p217 R-4 SHIPPED. Prior Compass diagnosis was WRONG:
  NOT a 1-col find_tables mis-parse. 7.2.2-F (p216) is a correct title-only husk;
  R-4's body is a clean 3-col fragment on p217 that already extracted (zoneless).
  Real fix = husk-reunification branch in reattach_fragments (_is_titled_husk
  helper + a pre-dovetail branch: a body-less titled husk adopts the immediately-
  following titleless 3-col body). Metadata-only — no table_settings/find_tables
  change, no strategy-file change; Phase 3 processes the body from the identical
  row list. Verified: R-4 10->21, null-zone extracted 14->3 (3 remaining are
  parking.required, jurisdiction-wide by design per rule_keys §8.5), approved 16
  / rejected 24 untouched, claims_failed 0. D2 NOW FULLY CLOSED — all four
  fragments (p214/p217/p219/p226) resolved; p217 via husk-reunification, not the
  misdiagnosed detection fix. TRACK A QUEUE: strike item 1.

- **2026-06-02** — Step 2 / A2-extend SHIPPED (7.4.10-G loading only; 7.4.10-A
  deferred to next session by decision). Compass framing was wrong on 3 counts:
  (1) 7.4.10-G is a checkable RATIO (1 space / 50,000 sf GFA), not prose_deferred;
  (2) it needed a NEW extractor (per-cell denominator), not an A2-core tweak —
  A2-core parses denominator from headers[1], but 7.4.10-G is headerless-by-design
  with the denominator in the cell; (3) the real blocker was detector PRECEDENCE:
  _detect_per_zone_dimensional claimed it first (label_path prefixes cleared the
  30% threshold) and silently mis-extracted. New shape per_use_loading: Shape +
  _detect_loading_ratio (keys on a "required loading spaces" CELL, not headers,
  since headers=[]) registered BEFORE dimensional; parse_loading_cell pure fn
  (one dialect: "[Minimum:] N space / M unit [GFA]") w/ inline self-check;
  _extract_loading_ratio (ratio from col_1, size spec -> notes from col_2 per
  §8.8); per_use_loading YAML block (2 rows -> parking.required, building_element:
  loading, use_class). rule_key DECISION: loading rides parking.required +
  scope.building_element=loading, NOT a new loading.required key (rule_keys §4/§7
  — same rule family, building_element is a documented scope axis). build.py
  unchanged (scope is opaque pass-through; CHECK validates value shape only).
  Verified: 2 loading claims, per_zone_dimensional 21->20 (no longer mis-eats G),
  null-zone 3->5 (jurisdiction-wide by design), rows_unmapped 25->23, approved 16
  / rejected 24 untouched, claims_failed 0. Detector-precedence trap is the same
  one the matrix detector hit on 2026-05-30 — specific signatures MUST precede the
  dimensional label_path heuristic.

## 2026-06-02 — Track A closed

**Step 1 (p217 R-4) — SHIPPED + committed.** Husk-reunification in
reattach_fragments. Diagnosis: NOT a 1-col detection bug (Compass was wrong);
7.2.2-F p216 is a title-only husk, R-4's body is a clean 3-col fragment on p217.
Fix = body-less titled husk adopts the following titleless 3-col body
(_is_titled_husk + pre-dovetail branch). Metadata-only. R-4 10->21, null-zone
14->3. D2 fully closed (all four fragments resolved).

**Step 2 (7.4.10-G loading) — SHIPPED + committed.** New per_use_loading shape.
Compass framing wrong on 3 counts: it's a RATIO not prose; needed a NEW extractor
(per-cell denominator, not A2-core's per-header); real blocker was detector
PRECEDENCE (dimensional ate it first). Fix: Shape.PER_USE_LOADING +
_detect_loading_ratio (keys on a "required loading spaces" CELL since headers=[]),
registered BEFORE dimensional; parse_loading_cell; _extract_loading_ratio (ratio
from col_1, size spec -> notes from col_2). rule_key: parking.required +
scope.building_element=loading (NOT a new key). 2 loading claims, dimensional
21->20, unmapped 25->23.

**Step 3 (district.area) — YAML committed, transform NOT yet re-run.**
Added "district standards" category + "district area (minimum)" row to the
per_zone_matrix block -> district.area / scalar_min. Source: 7.4.2-C (MX-M 2.5ac,
MX-L 10ac), 7.4.2-D (BP 10ac, NNA-O "Per base zone district" -> prose). Takes
effect on next transform run; not yet verified against DB.

**Deferred to backlog (tagged, NOT debt):**
- #2 Adjacency ("Setbacks [10] / Adjacent to residential", 7.4.2-D): §10 contextual
  scope decision. Existing composite is keyed to the wrong label
  ("adjacent to existing or planned residential zone or use") so it doesn't catch
  this leaf. Needs a scope-axis call (adjacency: residential on which setback).
- #3 Build-to Front Min/Max (7.4.2-C): rule_keys §8.3 says this is a `range`
  value_kind on setback.front — the ONTOLOGY HAS THE SHAPE. What's missing is the
  two-row assembly (combine Front/Minimum + Front/Maximum into one range claim);
  the per-row mapper can't gather across rows. Needs a merge pass or a range
  assembly step. Its own session.

**Process note:** rule_keys.md lives ONLY in the Claude project knowledge, never
copied into the repo, though migrations comment-reference "rule_keys.md (repo
root)". Not a blocker (rule_key is free text, no CHECK depends on it). If it
should be version-controlled, copy the canonical text into the repo as a one-off.

**Invariant held all session:** approved 16 / rejected 24, untouched throughout.

## 2026-06-02 (evening) — Track B2: parcel enrichment + caching fix

**Track A is CLOSED. Do not reopen it.** All remaining items are backlog-tagged
deferrals (adjacency, build-to range) or future sessions (A5 Sources tab, A6
source navigation). Track B is the active track.

**B2 redefined.** Original B2 was "lookup-parcel geometry bug" — that was fixed
in a prior session (refreshParcelsToken prop on Map). B2 now = parcel enrichment
verification + Edge Function caching fix. The geometry bug is closed.

**Migration 20260602220000 confirmed pushed.** `supabase migration list` shows
it on both local and remote. Three jurisdictions (Monument, Fountain, Manitou
Springs) now have parcel_source entries with authoritative FeatureServer endpoints
and field_maps.

**Municipal jurisdictions seeded.** `pnpm seed:boundaries` ran successfully in
the prior session — 7/7 EPC municipalities upserted with DOLA boundaries. EPC
unincorporated boundary recomputed. Jurisdiction resolution verified working
(Monument parcel resolves to "Town of Monument").

**Map refresh fix shipped.** `refreshParcelsToken` prop on App.tsx + Map.tsx.
After a lookup inserts a new parcel, the Map re-fetches and re-applies the
parcel GeoJSON source so the new parcel renders immediately without a full
reload. Includes catch-up fly-to + highlight for the async-refresh race.

**Stale parcels identified.** 4 parcels cached before the parcel_source migration
(APNs 4307000002, 4307000004, 4307001001, 5226402021) have source_system=
'co_public_parcels' and null zoningCode. All have 0 site_parcels references —
safe to DELETE. Cleanup in progress.

**Edge Function caching gap diagnosed.** `lookup-parcel/index.ts` line 79: the
early return checks only if a parcel EXISTS by APN — never whether it has zoning.
Any parcel cached before its jurisdiction had a parcel_source returns stale data
forever. Three-part fix:
1. Widen the cache select from `id` to `id, raw_attrs, source_system`
2. Only return cached if `raw_attrs.zoningCode` is present; otherwise fall through
   to Phase 1/2 for re-enrichment
3. Preserve existing `source_system` on re-enrichment upsert (the unique key is
   `(source_system, source_apn)` — changing source_system would INSERT a duplicate
   instead of updating; site_parcels has ON DELETE RESTRICT so orphaned rows can't
   be casually deleted)

**Known cosmetic issue (not blocking):** Edge Function hardcodes `'cos_landrecords'`
as source_system for ALL authoritative lookups (line 125). Monument/Fountain/Manitou
parcels get labeled as COS land records. Doesn't affect correctness — source_url and
raw_attrs.__authoritative_source track real provenance. Fix with a follow-up when it
matters.

**Known edge case (accepted):** After the caching fix, a parcel in a jurisdiction
WITHOUT a parcel_source (e.g. unincorporated EPC, Palmer Lake) will have null
zoningCode and will fall through to Phase 1/2 on every lookup. The statewide layer
doesn't provide zoningCode for these, so the re-enrichment is a no-op — same data
upserted. Practically harmless (parcels are looked up once, not repeatedly; the
statewide API call is fast). If it becomes a performance concern, add a
`last_enrichment_check` timestamp column to parcels. Not worth a schema change now.

**B2 VERIFIED.** All three municipalities tested end-to-end:
- Monument `7100000458` — already enriched (zoning `PCD`, source_url → Monument
  FeatureServer). Cached correctly on re-lookup.
- Fountain `5606410022` — `authoritative: true`, `jurisdiction: "fountain"`. Fresh
  two-phase flow.
- Manitou Springs `7404101101` — `authoritative: true`, `jurisdiction:
  "manitou_springs"`. Fresh two-phase flow.
Stale parcels (4 rows) deleted before testing. Caching fix deployed and working.

**NEW FINDING: statewide layer coverage gap for Manitou Springs.** APN `7405437002`
exists in Manitou's local FeatureServer but NOT in the CO Public Parcels statewide
layer — Phase 1 returns `found: false`. Other Manitou APNs (7404101101, 7404101102,
7404303062, 7404320012, 7404320013) exist in both layers and work correctly. The gap
is data-level (statewide compilation is incomplete), not a code bug. IMPLICATION: the
two-phase flow cannot serve parcels absent from the statewide layer. A future fallback
path (try authoritative source directly when Phase 1 misses and APN pattern matches a
known jurisdiction) would close this, but it's a separate work item — not blocking B2.

**Track B backlog (updated):**
- B2 parcel enrichment + caching fix — DONE, VERIFIED
- B1 minimum-viable honest BoE — NEXT
- Multi-parcel assemblage — schema-ready, lift the limit-1 guards (see 2026-06-01
  horizon reconciliation). Contained, no schema change.
- Statewide coverage fallback — NEW, low priority. Try authoritative source directly
  when Phase 1 misses for APNs in jurisdictions with a parcel_source.
