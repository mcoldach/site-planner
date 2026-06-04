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

import type * as GeoJSON from 'geojson';
import { supabase } from './supabase';
import type {
  ComplianceResult,
  Document,
  FootprintInput,
  JurisdictionRef,
  Parcel,
  ParcelContext,
  Project,
  Scheme,
  SchemeFootprint,
} from './types';

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
 * its primary parcel, plus the full list of parcel ids in the assemblage.
 *
 * Walks projects -> sites -> site_parcels via PostgREST embeds to resolve ALL
 * parcel ids, then fetches ParcelContext for the primary (first) parcel so
 * Projects mode and Parcels mode share the same `get_parcel_context` path.
 */
export async function fetchProjectContext(
  projectId: string,
): Promise<{
  project: { id: string; name: string };
  context: ParcelContext;
  parcelIds: string[];
}> {
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
  const allParcelIds =
    project.sites?.[0]?.site_parcels?.map((sp) => sp.parcel_id) ?? [];
  if (allParcelIds.length === 0) {
    throw new Error(
      `fetchProjectContext: project "${projectId}" has no parcel attached`,
    );
  }

  const context = await fetchParcelWithJurisdictionAndClaims(allParcelIds[0]);
  return {
    project: { id: project.id, name: project.name },
    context,
    parcelIds: allParcelIds,
  };
}

/**
 * Returns minimal parcel records for a list of ids. Used to populate the
 * assemblage list in the project workspace without requiring the full
 * allParcels array from App.
 */
export async function fetchParcelsById(
  parcelIds: string[],
): Promise<Parcel[]> {
  if (parcelIds.length === 0) return [];
  const { data, error } = await supabase
    .from('parcels_geojson')
    .select(PARCELS_GEOJSON_COLUMNS)
    .in('id', parcelIds);

  if (error) {
    throw new Error(`fetchParcelsById failed: ${error.message}`);
  }
  return (data ?? []) as unknown as Parcel[];
}

/**
 * Adds a parcel to a project's site assemblage. Resolves the project's site
 * (one site per project) then delegates to addParcelToSite.
 */
export async function addParcelToProject(
  projectId: string,
  parcelId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .eq('project_id', projectId)
    .order('created_at')
    .limit(1)
    .single();

  if (error) {
    throw new Error(
      `addParcelToProject: could not resolve site: ${error.message}`,
    );
  }
  if (data == null) {
    throw new Error(
      `addParcelToProject: no site found for project "${projectId}"`,
    );
  }

  await addParcelToSite((data as { id: string }).id, parcelId);
}

/**
 * Persist drawn footprints as a Scheme under the project's site.
 *
 * Footprints are shipped as a jsonb array; conversion to PostGIS geometry
 * happens server-side in `save_scheme` so the canonical spatial store stays
 * in Postgres (principle #2). Returns the new scheme id so the caller can
 * immediately pipe it into `checkSchemeCompliance`.
 */
export async function saveScheme(
  projectId: string,
  name: string,
  footprints: FootprintInput[],
): Promise<string> {
  const { data, error } = await supabase.rpc('save_scheme', {
    _project_id: projectId,
    _name: name,
    _footprints: footprints,
  });

  if (error) {
    throw new Error(`saveScheme failed: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new Error('saveScheme: RPC returned no scheme id');
  }
  return data;
}

/**
 * Update an existing scheme's name and footprints in place.
 *
 * Mirrors `saveScheme`'s server-side GeoJSON → PostGIS conversion (principle
 * #2) but routes through `update_scheme` so editing a scheme rewrites the
 * existing row instead of inserting a new one. Returns the same scheme id
 * the caller passed in, so call-site code stays parallel to `saveScheme`.
 */
export async function updateScheme(
  schemeId: string,
  name: string,
  footprints: FootprintInput[],
): Promise<string> {
  const { data, error } = await supabase.rpc('update_scheme', {
    _scheme_id: schemeId,
    _name: name,
    _footprints: footprints,
  });

  if (error) {
    throw new Error(`updateScheme failed: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new Error('updateScheme: RPC returned no scheme id');
  }
  return data;
}

/**
 * Delete a saved scheme. The server-side RPC raises if no row matched, which
 * surfaces as a thrown Error here — callers can show that to the user (it
 * normally only happens if two clients raced on the same scheme).
 */
export async function deleteScheme(schemeId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_scheme', {
    _scheme_id: schemeId,
  });

  if (error) {
    throw new Error(`deleteScheme failed: ${error.message}`);
  }
}

/**
 * Returns every Scheme belonging to a project, most-recent first.
 *
 * Reads from the `schemes_geojson` view, which now returns scheme-level
 * summary rows (no footprint geometry): the view joins schemes -> sites to
 * surface `project_id` and precomputes `footprint_count` and `footprint_sf`
 * (the unioned area of all the scheme's footprints) so the client uses the
 * server's canonical area rather than recomputing with turf. Per-footprint
 * geometry lives in `scheme_footprints_geojson` (see `fetchSchemeFootprints`).
 */
export async function fetchProjectSchemes(
  projectId: string,
): Promise<Scheme[]> {
  const { data, error } = await supabase
    .from('schemes_geojson')
    .select('id, name, footprint_count, footprint_sf, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`fetchProjectSchemes failed: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      name: string | null;
      footprint_count: number | string;
      footprint_sf: number | string;
      created_at: string;
    };
    return {
      id: r.id,
      name: r.name ?? '',
      // Postgres numeric flows through PostgREST as a string by default;
      // coerce here so callers see a plain number regardless of column type.
      footprint_count: Number(r.footprint_count),
      footprint_sf: Number(r.footprint_sf),
      created_at: r.created_at,
    };
  });
}

/**
 * Returns every footprint belonging to a scheme, ordered by `ordinal`.
 *
 * Reads from the `scheme_footprints_geojson` view, which ships each
 * footprint's polygon as GeoJSON and precomputes `footprint_sf` from
 * ST_Area on the geography cast. Used by the load-for-edit path so Terra
 * Draw can rehydrate the scheme's footprints in their original order.
 */
export async function fetchSchemeFootprints(
  schemeId: string,
): Promise<SchemeFootprint[]> {
  const { data, error } = await supabase
    .from('scheme_footprints_geojson')
    .select('id, scheme_id, ordinal, label, use_code, height_ft, footprint, footprint_sf')
    .eq('scheme_id', schemeId)
    .order('ordinal', { ascending: true });

  if (error) {
    throw new Error(`fetchSchemeFootprints failed: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      scheme_id: string;
      ordinal: number | string;
      label: string | null;
      use_code: string | null;
      height_ft: number | string | null;
      footprint: GeoJSON.Polygon;
      footprint_sf: number | string;
    };
    return {
      id: r.id,
      scheme_id: r.scheme_id,
      ordinal: Number(r.ordinal),
      label: r.label,
      use_code: r.use_code,
      // height_ft is nullable in the schema; preserve null but coerce numeric
      // strings (PostgREST sends Postgres numeric as text by default).
      height_ft: r.height_ft === null ? null : Number(r.height_ft),
      footprint: r.footprint,
      footprint_sf: Number(r.footprint_sf),
    };
  });
}

/**
 * Run the cited compliance engine against a saved scheme.
 *
 * Every check-kind (setback / coverage / height / not_evaluated) is dispatched
 * server-side; we hand the jsonb document back to the UI verbatim. The shape
 * is owned by check_scheme_compliance — see ComplianceResult in ./types.
 */
export async function checkSchemeCompliance(
  schemeId: string,
): Promise<ComplianceResult> {
  const { data, error } = await supabase.rpc('check_scheme_compliance', {
    _scheme_id: schemeId,
  });

  if (error) {
    throw new Error(`checkSchemeCompliance failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error(
      `checkSchemeCompliance: no result for scheme "${schemeId}"`,
    );
  }
  return data as ComplianceResult;
}

/**
 * Lists jurisdictions for the Sources mode selector — id, slug, name only,
 * ordered by display name. The full `Jurisdiction` shape (authority_type,
 * code_label, code_home_url, current_code_version) is reserved for the
 * parcel-context pipeline and citation panel; the selector doesn't need it.
 */
export async function fetchJurisdictions(): Promise<JurisdictionRef[]> {
  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id, slug, name')
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`fetchJurisdictions failed: ${error.message}`);
  }

  return (data ?? []) as JurisdictionRef[];
}

/**
 * Lists every uploaded document for a jurisdiction, newest first.
 *
 * Scoped to a single jurisdiction (one filter, one sort) because the Sources
 * mode UI always views one jurisdiction at a time — there's no value in a
 * cross-jurisdiction list, and it would muddy the citation panel's "city vs
 * county" mental model. RLS gates the read to authenticated users.
 */
export async function fetchDocumentsForJurisdiction(
  jurisdictionId: string,
): Promise<Document[]> {
  const { data, error } = await supabase
    .from('documents')
    .select(
      [
        'id',
        'jurisdiction_id',
        'source_snapshot_id',
        'owner_id',
        'filename',
        'storage_path',
        'title',
        'code_type',
        'version',
        'effective_date',
        'source_url',
        'ingest_status',
        'ingest_error',
        'ingested_at',
        'created_at',
        'updated_at',
      ].join(', '),
    )
    .eq('jurisdiction_id', jurisdictionId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`fetchDocumentsForJurisdiction failed: ${error.message}`);
  }

  return (data ?? []) as unknown as Document[];
}

export type UploadDocumentMetadata = {
  /** Jurisdiction slug used to namespace the Storage object key. */
  jurisdictionSlug: string;
  /** Display title, e.g. "El Paso County Land Development Code". */
  title: string;
  /** Code amendment / version label — optional, free text. */
  version?: string;
  /** ISO date string (YYYY-MM-DD) for when this version took effect. */
  effectiveDate?: string;
  /** Official source URL (Municode, AmLegal, etc.). */
  sourceUrl?: string;
  /** Free-text code type ("ordinance", "code", "master_plan", …). */
  codeType?: string;
};

/**
 * Two-step upload: PDF blob into Supabase Storage, then a `documents` row
 * pointing at it. The document_id is minted client-side so both steps share
 * the same key — the storage object lives at
 * `{jurisdiction_slug}/{document_id}.pdf` so it's discoverable from the row
 * alone (no separate object<>row mapping table).
 *
 * `ingest_status` is left at the schema default ('uploaded'); a separate
 * ingest pipeline (Phase 2, Step 3 in the build plan) advances it to
 * 'processing' / 'ingested' / 'failed'. owner_id auto-stamps via the column
 * default `auth.uid()`, matching projects/schemes.
 *
 * On any failure, we throw with the underlying message; the caller is
 * responsible for not closing the modal so the user can retry. We do NOT
 * roll the Storage object back on a row-insert failure — the next retry
 * uses a new document_id, so an orphaned object is at worst dead weight in
 * the bucket. (Tradeoff: simpler code, occasional orphans.)
 */
export async function uploadDocument(
  jurisdictionId: string,
  file: File,
  metadata: UploadDocumentMetadata,
): Promise<Document> {
  const documentId = crypto.randomUUID();
  const storagePath = `${metadata.jurisdictionSlug}/${documentId}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(storagePath, file, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`uploadDocument storage upload failed: ${uploadError.message}`);
  }

  const { data, error } = await supabase
    .from('documents')
    .insert({
      id: documentId,
      jurisdiction_id: jurisdictionId,
      source_snapshot_id: null,
      filename: file.name,
      storage_path: storagePath,
      title: metadata.title,
      version: metadata.version ?? null,
      effective_date: metadata.effectiveDate ?? null,
      source_url: metadata.sourceUrl ?? null,
      code_type: metadata.codeType ?? null,
      ingest_status: 'uploaded',
    })
    .select(
      [
        'id',
        'jurisdiction_id',
        'source_snapshot_id',
        'owner_id',
        'filename',
        'storage_path',
        'title',
        'code_type',
        'version',
        'effective_date',
        'source_url',
        'ingest_status',
        'ingest_error',
        'ingested_at',
        'created_at',
        'updated_at',
      ].join(', '),
    )
    .single();

  if (error) {
    throw new Error(`uploadDocument insert failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error('uploadDocument: insert returned no row');
  }
  return data as unknown as Document;
}
