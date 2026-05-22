/**
 * Typed data-access functions for the Phase 0 read path.
 *
 * All functions go through the anon Supabase client (`./supabase`). Errors
 * are surfaced as thrown Error objects with the underlying Supabase message
 * attached — we never silently return `[]` / `null` on failure, because
 * "no data" and "request failed" mean very different things to the UI.
 *
 * Wire shape is owned by SQL:
 *   - `parcels_geojson` view  (geometry emitted as GeoJSON jsonb)
 *   - `get_parcel_context(_parcel_id uuid) returns jsonb`
 * See supabase/migrations/20260419_0500_views.sql.
 */

import { supabase } from './supabase';
import type { Parcel, ParcelContext } from './types';

const PARCELS_GEOJSON_COLUMNS =
  'id, source_apn, source_system, label, zone_district_code, geometry, raw_attrs, retrieved_at, source_url';

/**
 * Returns every parcel in the cache, with `geometry` as GeoJSON.MultiPolygon.
 *
 * Reads from the `parcels_geojson` view rather than the `parcels` table
 * because PostgREST returns PostGIS geometry columns as hex WKB by default;
 * the view applies ST_AsGeoJSON so the client receives a usable GeoJSON
 * object directly.
 */
export async function fetchAllParcels(): Promise<Parcel[]> {
  const { data, error } = await supabase
    .from('parcels_geojson')
    .select(PARCELS_GEOJSON_COLUMNS);

  if (error) {
    throw new Error(`fetchAllParcels failed: ${error.message}`);
  }

  return (data ?? []) as unknown as Parcel[];
}

/**
 * Returns the parcel, its resolved jurisdiction (spatially, with municipal
 * precedence), and all approved claims that apply to it.
 *
 * All assembly happens server-side in the `get_parcel_context` RPC, so this
 * is a single round-trip. Throws if the parcel id does not exist — callers
 * can catch that to render a not-found state.
 */
export async function fetchParcelWithJurisdictionAndClaims(
  parcelId: string,
): Promise<ParcelContext> {
  const { data, error } = await supabase.rpc('get_parcel_context', {
    _parcel_id: parcelId,
  });

  if (error) {
    throw new Error(
      `fetchParcelWithJurisdictionAndClaims failed: ${error.message}`,
    );
  }

  if (data == null) {
    throw new Error(
      `fetchParcelWithJurisdictionAndClaims: no parcel found for id "${parcelId}"`,
    );
  }

  // The RPC returns a jsonb document shaped exactly like ParcelContext.
  // We trust the SQL contract here; runtime validation can be added in
  // Phase 1 if we ever expose this to untrusted callers.
  return data as ParcelContext;
}

export async function lookupParcelByApn(
  apn: string,
): Promise<
  | { found: true; parcelId: string; cached: boolean }
  | { found: false }
> {
  const { data, error } = await supabase.functions.invoke('lookup-parcel', {
    body: { apn },
  });
  if (error) {
    throw new Error(`lookupParcelByApn failed: ${error.message}`);
  }
  if (data?.error) {
    throw new Error(`lookupParcelByApn: ${data.error}`);
  }
  if (data?.found) {
    return { found: true, parcelId: data.parcelId, cached: data.cached };
  }
  return { found: false };
}
