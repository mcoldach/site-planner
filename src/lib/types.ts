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
  geometry: GeoJSON.Geometry;
  centroid: GeoJSON.Point;
};

/**
 * A saved Scheme as returned by the `schemes_geojson` view.
 *
 * `footprint` arrives from PostGIS via ST_AsGeoJSON as a GeoJSON.Polygon
 * (the underlying column is geometry(Polygon, 4326)); `footprint_sf` is
 * precomputed server-side from ST_Area on the geography cast, so the client
 * doesn't recompute it (and stays consistent with PostGIS's area, not turf's).
 */
export type Scheme = {
  id: string;
  name: string;
  height_ft: number;
  footprint: GeoJSON.Polygon;
  footprint_sf: number;
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
};

export type ComplianceResult = {
  scheme_id: string;
  parcel_id: string;
  constraint_codes: string[];
  results: ComplianceEntry[];
};
