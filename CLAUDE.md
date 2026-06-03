# Constraint-Aware Site Planning Workbench

Browser-first app that turns parcel geometry, governing rules, and public records into a cited, editable site scheme with a first-pass underwrite. Pilot: Colorado Springs + El Paso County. Phase 2 active.

See `Project_Compass.md` for full project state, decisions log, and backlog.

## Stack

- **Frontend:** React 19 + Vite 8 + TypeScript 6 + Tailwind 3 + MapLibre GL JS 5
- **Map editing:** Terra Draw + terra-draw-maplibre-gl-adapter
- **Database:** Supabase-managed Postgres 15 + PostGIS + pgvector (768-dim, nomic-embed-text-v1.5)
- **Edge Functions:** Deno (JSR imports, NOT npm) — deployed via `npx supabase functions deploy`
- **Ingest pipeline:** Python 3.13 + pdfplumber + supabase-py (separate venv in `scripts/ingest/`)
- **Transformer pipeline:** Python 3.13 + PyYAML + supabase-py (shares ingest venv + .env)
- **Auth:** Supabase Auth + RLS (magic links / OTP)

## Key commands

```bash
# Frontend
pnpm dev                           # Vite dev server (needs .env.local with VITE_SUPABASE_*)
pnpm build                         # tsc + vite build → dist/
pnpm lint                          # ESLint

# Database / migrations
npx supabase migration list        # verify local vs remote sync
npx supabase db push               # apply pending migrations to linked project
npx supabase functions deploy lookup-parcel  # deploy the Edge Function

# Seeding (needs .env.local with SUPABASE_SERVICE_ROLE_KEY + ArcGIS URLs)
pnpm seed:jurisdictions            # seed CS + EPC jurisdictions from ArcGIS boundaries
pnpm seed:boundaries               # seed 7 EPC municipal boundaries from DOLA
pnpm seed:parcels                  # seed sample parcels from CO statewide layer

# Ingest pipeline (run from scripts/ingest/, venv must be active)
cd scripts/ingest && source .venv/bin/activate
python ingest.py <document_id>                 # full ingest (parse tables + embed chunks)
python ingest.py <document_id> --skip-chunks   # re-parse tables only
python ingest.py <document_id> --skip-tables   # re-embed prose only
python ingest.py <document_id> --dry-run       # print plan, no DB writes

# Transformer (run from scripts/transformer/, uses ingest venv + .env)
cd scripts/transformer && source ../ingest/.venv/bin/activate
python transform.py <document_id>              # detect → extract → map → build claims
python transform.py <document_id> --dry-run    # print summary, no DB writes

# Diagnostics (read-only, safe to run anytime)
python check.py <document_id>      # verify Supabase + Storage + LM Studio connections
python probe.py <document_id>      # inspect raw pdfplumber extraction without writing
```

## File map

### Frontend (`src/`)
- `App.tsx` — top-level layout, parcel/project state, map refresh orchestration
- `components/Map.tsx` — MapLibre instance, GeoJSON layers, fly-to, parcel/project rendering
- `components/ParcelSearch.tsx` — keyboard-nav APN search, calls `lookup-parcel` Edge Function
- `components/ProjectWorkspace.tsx` — scheme editor (Terra Draw), compliance panel, footprint table
- `components/SourcesWorkspace.tsx` — document upload + jurisdiction document list
- `lib/types.ts` — all shared domain types (mirrors SQL views/RPCs)
- `lib/data.ts` — typed Supabase data-access functions (the only file that talks to PostgREST)
- `lib/supabase.ts` — singleton Supabase client init

### Backend (`supabase/`)
- `migrations/` — 30+ migrations (YYYYMMDDHHMMSS format); Phase 0 schema + incremental
- `functions/lookup-parcel/index.ts` — two-phase parcel lookup Edge Function (Deno)
- `seed/` — SQL seed files for claims and source snapshots

### Ingest pipeline (`scripts/ingest/`)
- `ingest.py` — orchestrator: parse_tables → embed_chunks
- `parse_tables.py` — pdfplumber extraction → `document_tables` (strategy-dispatched)
- `embed_chunks.py` — prose chunking → LM Studio embedding → `document_chunks`
- `strategies/base.py` — GenericStrategy (table detection, header finding, cell parsing)
- `strategies/amlegal.py` — AmLegalStrategy (CS UDC overrides: fragment reattachment, header detection)

### Transformer (`scripts/transformer/`)
- `transform.py` — entry point: wipes stale artifacts, re-inserts fresh
- `detect.py` — shape detectors (per_zone_dimensional, per_zone_matrix, per_use_ratio, per_use_loading)
- `extract.py` — per-shape extractors → `RawExtraction` tuples
- `mapping.py` — label → (rule_key, constraint_kind, scope) via `label_mapping.yaml`
- `label_mapping.yaml` — shape-scoped mapping config (categories, rows, composites, ignore_rows)
- `build.py` — claim dict builder + `claim_value_shape_valid` validation

### Scripts (`scripts/`)
- `seed_jurisdictions.ts` — fetch + upsert jurisdiction boundaries from ArcGIS
- `seed_municipal_boundaries.ts` — DOLA municipal boundary seed + EPC recompute
- `seed_parcels.ts` — seed sample parcels from CO statewide layer

## Data model (conceptual)

```
jurisdictions ──< parcels          (spatial join via ST_Contains at query time)
jurisdictions ──< claims           (zone_district_code scopes within jurisdiction)
jurisdictions ──< documents        (uploaded source PDFs)
documents ──< document_tables      (parsed table grids, strategy-tagged)
documents ──< document_chunks      (prose chunks + 768-dim embeddings)
document_tables ──< claims         (source_table_id traces claim provenance)
source_snapshots ──< claims        (source_snapshot_id: the PDF version)
projects ──< sites ──< site_parcels ──< parcels  (assemblage, ON DELETE RESTRICT)
projects ──< schemes ──< scheme_footprints       (multi-polygon parametric design)
```

Core entities: `parcels`, `jurisdictions`, `claims`, `documents`, `document_tables`, `schemes`, `scheme_footprints`, `projects`, `sites`, `source_snapshots`. The `claims` table is central — it has review_state (extracted/approved/rejected/...) and structured value columns validated by a CHECK constraint (`claim_value_shape_valid`).

## Architecture patterns

**Two-phase parcel lookup:** The `lookup-parcel` Edge Function first queries the CO statewide parcel layer for geometry + base attrs, then resolves jurisdiction from that geometry via `resolve_jurisdiction_for_geometry` RPC (PostGIS spatial join). If the jurisdiction declares a `parcel_source`, it re-fetches from the authoritative endpoint and normalizes via `field_map`. Falls back to statewide if no authoritative source exists.

**Jurisdiction resolution:** Always via PostGIS `ST_Contains(jurisdictions.boundary, parcel.geometry)`. Never hardcoded. Boundary changes propagate automatically.

**parcel_source field_map normalization:** Each jurisdiction's `parcel_source` row declares an ArcGIS FeatureServer endpoint + `field_map` (JSON object mapping canonical field names → source field names). The Edge Function iterates this map to produce normalized `raw_attrs`.

**Transformer pipeline:** `detect_shape` → `extract` → `map` → `build_claim`. Four seams, each pure and testable. Shape-scoped: the same label means different things in different shapes (the YAML has per-shape blocks). Detector precedence is load-bearing (specific signatures before the dimensional label_path heuristic).

**Idempotency contract:** `transform.py` wipes all machine-extracted artifacts (extracted claims + unmapped labels for the document's source_snapshot) before re-inserting. Approved/rejected claims are preserved. Safe to re-run.

**Upsert parcel:** The `upsert_parcel` RPC uses `(source_system, source_apn)` as the unique key. Changing `source_system` on an existing parcel INSERTS a duplicate instead of updating.

**Map refresh:** `refreshParcelsToken` / `refreshProjectsToken` — React state tokens that trigger Map re-fetch after mutations (parcel lookup, project creation). Increment the token → Map re-fetches GeoJSON source.

## Naming conventions

- **Migrations:** `YYYYMMDDHHMMSS_descriptive_name.sql` (14-digit timestamp). One legacy file uses 8-digit (`20260419000000`).
- **RPCs:** `verb_noun` snake_case (e.g. `upsert_parcel`, `save_scheme`, `check_scheme_compliance`, `resolve_jurisdiction_for_geometry`)
- **Components:** PascalCase, one per file, file matches component name
- **Scripts:** snake_case for Python, camelCase/snake_case for TypeScript
- **rule_key format:** dot-separated hierarchy: `family.member` or `family.member.modifier` (e.g. `setback.front`, `lot.coverage`, `building.height`, `parking.required`)
- **YAML mapping:** shape-scoped top-level blocks → `categories` (label_path[0] → rule_family + constraint_kind) → `rows` (normalized row label → rule_key + scope)
- **Detector shapes:** registered in precedence order in `detect.py`; enum `Shape` names match YAML block keys

## Anti-patterns / landmines

- **`(source_system, source_apn)` unique key:** Changing `source_system` on an upsert creates a DUPLICATE parcel, not an update. Always match the existing source_system.
- **`site_parcels` has ON DELETE RESTRICT:** Cannot casually delete parcels attached to projects. Must detach first.
- **Migration filename format:** 14-digit `YYYYMMDDHHMMSS`. One legacy 8-digit file exists (`20260419000000_phase_0_schema.sql`) — do NOT rename it (already applied remotely). Check `supabase migration list` before creating new migrations.
- **Detector precedence is load-bearing:** Specific detectors (matrix, loading, ratio) MUST run before the dimensional heuristic detector. Dimensional uses label_path prefix matching that also fires on matrix/loading tables — if it runs first, it silently eats them and produces zero claims.
- **label_mapping.yaml is shape-scoped:** The same label string means different things in different shapes (e.g. "maximum" is an ignore_row in dimensional but a real rule in matrix). Always check which shape block you're editing.
- **Edge Functions use Deno/JSR imports:** `import { createClient } from 'jsr:@supabase/supabase-js@2'` — not npm. No `node_modules`, no `package.json` deps.
- **Python pipeline is a separate world:** Different runtime (Python 3.13), different deps (own venv in `scripts/ingest/.venv`), different entry points, shares only the Supabase URL + service role key via `scripts/ingest/.env`.
- **Transformer reuses ingest .env:** `transform.py` does `load_dotenv(HERE.parent / "ingest" / ".env")`. No separate env file for the transformer.
- **`supabase==2.9.1` in requirements.txt is STALE:** The project upgraded to 2.30.0+ (required for `sb_secret_` key format). The pinned version will fail on fresh install.
- **`claim_value_shape_valid` CHECK constraint:** Claims must pass a JSON shape validation on insert. If you build claims manually, match the exact shapes defined in migration `20260530120000_rule_keys_ontology_v1.sql`.
- **`__pycache__/` is committed to git:** 5+ .pyc files are tracked. Not harmful but noisy in diffs.
- **`_pending_project_overrides.sql.todo`:** Intentionally excluded from migration sequence by its underscore prefix + `.todo` extension. Do not rename without implementing the feature.

## What NOT to do

- Do not create migration files without checking `supabase migration list` first — timestamps must not collide with existing applied migrations
- Do not add npm deps for things Supabase/PostGIS already handles (spatial operations, UUID generation, JSON operations)
- Do not store scheme geometry in React state — PostGIS is the single spatial truth store
- Do not hardcode zoning rules in JS constants — they belong in the claims table with source_snapshot links
- Do not use Mapbox GL JS (use MapLibre), Next.js (use Vite), or a separate vector DB (use pgvector)
- Do not suggest agent frameworks or multi-agent chains — one copilot with deterministic tools
- Do not frame outputs as survey-grade or permit-ready — this is feasibility-grade
- Do not modify the Phase 0 migration file (`20260419000000_phase_0_schema.sql`) — it's already applied
- Do not delete the `audit_*.py` files without asking — they're read-only forensic tools from specific debugging sessions, not dead code in the traditional sense
- Do not add Google 3D Tiles as the default map canvas — it's gated for Phase 4
