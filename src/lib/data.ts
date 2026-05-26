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
import type { Parcel, ParcelContext, Project } from './types';

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
 * Returns every project with its site outline (geometry) and centroid.
 *
 * Reads from the `projects_geojson` view — same rationale as
 * `fetchAllParcels`: PostGIS geometry is emitted as GeoJSON by the view, so
 * the wire shape is directly usable by MapLibre without client-side parsing.
 */
export async function fetchProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects_geojson')
    .select('id, name, geometry, centroid');

  if (error) {
    throw new Error(`fetchProjects failed: ${error.message}`);
  }

  return (data ?? []) as unknown as Project[];
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

/**
 * Creates a project row with the given name.
 *
 * `constraint_basis` is left to the column default (current_zoning); the
 * UI to override that lands in Phase 3.
 */
export async function createProject(
  name: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name })
    .select('id, name')
    .single();

  if (error) {
    throw new Error(`createProject failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error('createProject: insert returned no row');
  }
  return data as { id: string; name: string };
}

/**
 * Creates a site (assemblage) under the given project.
 *
 * `name` is optional — Sites can be unnamed in the schema, and a single-parcel
 * V1 Site is effectively addressed by its parcel.
 */
export async function createSite(
  projectId: string,
  name?: string,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('sites')
    .insert({ project_id: projectId, name: name ?? null })
    .select('id')
    .single();

  if (error) {
    throw new Error(`createSite failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error('createSite: insert returned no row');
  }
  return data as { id: string };
}

/**
 * Adds a parcel to a site's assemblage. Idempotent against the (site_id,
 * parcel_id) primary key — the caller is responsible for not double-adding.
 */
export async function addParcelToSite(
  siteId: string,
  parcelId: string,
): Promise<void> {
  const { error } = await supabase
    .from('site_parcels')
    .insert({ site_id: siteId, parcel_id: parcelId });

  if (error) {
    throw new Error(`addParcelToSite failed: ${error.message}`);
  }
}

/**
 * V1 orchestrator: create a project + a single site under it + attach one
 * parcel as the site's sole assemblage member.
 *
 * Multi-parcel assemblage and multi-site projects are valid in the schema;
 * the UI for them is deferred. The Site is named after the Project for now.
 */
export async function createProjectWithParcel(
  name: string,
  parcelId: string,
): Promise<{ id: string; name: string }> {
  const project = await createProject(name);
  const site = await createSite(project.id, name);
  await addParcelToSite(site.id, parcelId);
  return project;
}

type ProjectWithSites = {
  id: string;
  name: string;
  sites: { site_parcels: { parcel_id: string }[] }[];
};

/**
 * Returns a project (id, name) together with the resolved parcel context for
 * its V1 single-parcel site.
 *
 * Walks projects -> sites -> site_parcels via PostgREST embeds to resolve the
 * single parcel id, then defers to `fetchParcelWithJurisdictionAndClaims` so
 * Projects mode and Parcels mode share the same `get_parcel_context` path —
 * one canonical claims query, no duplication.
 *
 * V1 contract: one site per project, one parcel per site. When multi-parcel
 * assemblage lands, this will need to fan out (or move to a server-side
 * project_context RPC); the call sites here are the seam.
 */
export async function fetchProjectContext(
  projectId: string,
): Promise<{ project: { id: string; name: string }; context: ParcelContext }> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, sites(site_parcels(parcel_id))')
    .eq('id', projectId)
    .single();

  if (error) {
    throw new Error(`fetchProjectContext failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error(
      `fetchProjectContext: no project found for id "${projectId}"`,
    );
  }

  const project = data as unknown as ProjectWithSites;
  const parcelId = project.sites?.[0]?.site_parcels?.[0]?.parcel_id;
  if (!parcelId) {
    throw new Error(
      `fetchProjectContext: project "${projectId}" has no parcel attached`,
    );
  }

  const context = await fetchParcelWithJurisdictionAndClaims(parcelId);
  return {
    project: { id: project.id, name: project.name },
    context,
  };
}
