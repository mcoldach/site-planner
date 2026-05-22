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
