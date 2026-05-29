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