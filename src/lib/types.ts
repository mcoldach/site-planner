/**
 * Shared domain types for the Phase 0 read path.
 *
 * These mirror the shape returned by the `parcels_geojson` view and the
 * `get_parcel_context(_parcel_id uuid)` RPC defined in
 * supabase/migrations/20260522120000_views.sql. Keep this file and that
 * migration in sync; the SQL is the source of truth for the wire shape.
 */

// `tsconfig.app.json` pins `types: ["vite/client"]`, so the global `GeoJSON`
// namespace from @types/geojson is NOT in scope by default. A type-only
// namespace import gives us `GeoJSON.MultiPolygon` without ambient globals.
import type * as GeoJSON from 'geojson';

export type AuthorityType =
  | 'municipal'
  | 'county_unincorporated'
  | 'county'
  | 'state'
  | 'federal'
  | 'special_district';

export type Parcel = {
  id: string;
  source_apn: string;
  source_system: string;
  label: string | null;
  zone_district_code: string | null;
  geometry: GeoJSON.MultiPolygon;
  raw_attrs: Record<string, unknown>;
  retrieved_at: string;
  source_url: string | null;
};

export type Jurisdiction = {
  id: string;
  slug: string;
  name: string;
  authority_type: AuthorityType;
  code_label: string | null;
  code_home_url: string | null;
  current_code_version: string | null;
};

export type Claim = {
  id: string;
  jurisdiction_id: string;
  zone_district_code: string | null;
  rule_key: string;
  label: string | null;
  category: string | null;
  value_text: string | null;
  value_numeric: number | null;
  value_unit: string | null;
  section_ref: string;
  section_url: string | null;
  source_snapshot: { title: string; url: string };
};

export type ReviewState =
  | 'extracted'
  | 'reviewed'
  | 'approved'
  | 'superseded'
  | 'conflicted'
  | 'rejected';

export type ReviewClaim = {
  id: string;
  jurisdiction_id: string;
  zone_district_code: string | null;
  rule_key: string;
  review_state: ReviewState;
  value_text: string | null;
  value_numeric: number | null;
  value_unit: string | null;
  constraint_kind: string;
  value_kind: string;
  value: Record<string, unknown>;
  section_ref: string;
  section_url: string | null;
  notes: string | null;
  edit_note: string | null;
  claim_version: number;
  source_snapshots: { title: string; url: string };
};

export type ZoneCode = {
  code: string;
  label: string | null;
  code_section: string | null;
  source_url: string | null;
};

export type Classification = {
  base_codes: ZoneCode[];
  overlay_codes: ZoneCode[];
  combined_codes: ZoneCode[];
  unclassified_codes: string[];
};

export type ParcelContext = {
  parcel: Parcel;
  jurisdiction: Jurisdiction | null;
  classification: Classification;
  claims: Claim[];
};

export type Project = {
  id: string;
  name: string;
  color: string;
  icon: string;
  geometry: GeoJSON.Geometry;
  centroid: GeoJSON.Point;
};

/**
 * A saved Scheme as returned by the `schemes_geojson` view.
 *
 * The view now returns scheme-level rows (no footprint geometry): one row per
 * scheme with the union area of its footprints precomputed server-side via
 * ST_Area on the geography cast, and the footprint count from the
 * scheme_footprints table.
 */
export type Scheme = {
  id: string;
  name: string;
  footprint_count: number;
  footprint_sf: number; // union area of all footprints, sq ft
  created_at: string;
};

/**
 * One footprint belonging to a scheme, as returned by the
 * `scheme_footprints_geojson` view. Geometry arrives from PostGIS via
 * ST_AsGeoJSON as a GeoJSON.Polygon; `footprint_sf` is precomputed
 * server-side so the client uses PostGIS's canonical area.
 */
export type SchemeFootprint = {
  id: string;
  scheme_id: string;
  ordinal: number;
  label: string | null;
  use_code: string | null;
  height_ft: number | null;
  footprint: GeoJSON.Polygon;
  footprint_sf: number;
};

/**
 * Client-side shape Terra Draw assembles for save/update. The server-side
 * `save_scheme` / `update_scheme` RPCs accept a jsonb array of these.
 */
export type FootprintInput = {
  geojson: GeoJSON.Polygon;
  height_ft: number | null;
  label?: string | null;
  use_code?: string | null;
};

/**
 * One in-flight polygon currently owned by Terra Draw. The `id` is Terra
 * Draw's stable feature id (string | number) — kept so the workspace can
 * thread it through saves/edits without losing identity between renders.
 * Geometry is read OUT of Terra Draw on every change and emitted as a
 * complete set; the app never pushes back into Terra Draw mid-session.
 */
export type DrawnFootprint = {
  id: string | number;
  geometry: GeoJSON.Polygon;
};

/**
 * Per-footprint UI state keyed by Terra Draw's stable feature id (stringified).
 * The workspace owns this in app state — Terra Draw is the source of truth
 * for geometry, but it has no opinion on labels or heights. `height_ft` is
 * null until the user enters a per-row value; rows with null fall back to
 * the panel's default height input at save time and at display time.
 */
export type FootprintMeta = {
  label: string;
  height_ft: number | null;
};

/**
 * One row of the `check_scheme_compliance` RPC result. Shape mirrors the
 * jsonb dispatcher in supabase/migrations/20260526181015_check_compliance_via_site.sql:
 * common metadata (rule_key, check_kind, result, citation) is always present;
 * the per-kind numeric fields are populated only for the kind that emitted
 * the entry. Optional because the dispatcher is intentionally open — adding
 * a new check-kind is filling a socket, and the UI must degrade gracefully.
 */
export type ComplianceEntry = {
  rule_key: string;
  check_kind: string;
  result: 'pass' | 'fail' | 'not_evaluated';
  citation?: { section_ref: string | null; section_url: string | null };
  // spatial_inset (setback.*.min)
  value_used_ft?: number;
  driving_role?: string;
  role_values?: Record<string, number | null>;
  method?: string;
  note?: string;
  // not_evaluated
  reason?: string;
  // area_ratio (lot.coverage.max)
  actual_pct?: number;
  limit_pct?: number;
  margin_pct?: number;
  // scalar_max (height.max[.principal])
  actual_ft?: number;
  limit_ft?: number;
  margin_ft?: number;
  // per-footprint entries
  footprint_id?: string;
  ordinal?: number;
  label?: string | null;
};

export type ComplianceResult = {
  scheme_id: string;
  parcel_id: string;
  constraint_codes: string[];
  results: ComplianceEntry[];
};

/**
 * Cite-able reference material uploaded by an authenticated user.
 *
 * Mirrors the `documents` table in
 * supabase/migrations/20260527173548_document_ingestion_schema.sql. Phase 1
 * surface uploads stay at `ingest_status = 'uploaded'` indefinitely — the
 * ingest pipeline (Step 3) is what flips them onward.
 */
export type IngestStatus = 'uploaded' | 'processing' | 'ingested' | 'failed';

export type Document = {
  id: string;
  jurisdiction_id: string;
  source_snapshot_id: string | null;
  owner_id: string | null;
  filename: string;
  storage_path: string;
  title: string | null;
  code_type: string | null;
  version: string | null;
  effective_date: string | null;
  source_url: string | null;
  ingest_status: IngestStatus;
  ingest_error: string | null;
  ingested_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Slim jurisdiction shape used by the Sources mode selector — id + slug +
 * display name only. Returned by `fetchJurisdictions`. The full `Jurisdiction`
 * shape is reserved for the parcel-context pipeline, which carries
 * authority_type/code_label/etc. for the citation panel.
 */
export type JurisdictionRef = {
  id: string;
  slug: string;
  name: string;
};
