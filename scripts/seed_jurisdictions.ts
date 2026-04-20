/**
 * scripts/seed_jurisdictions.ts
 *
 * Phase 0 seed: fetch City of Colorado Springs limits + El Paso County boundary
 * from public ArcGIS REST endpoints, union their features into a single
 * MultiPolygon, and upsert into the `jurisdictions` table. Each fetch is
 * recorded as a `source_snapshots` row so we keep cited provenance from day
 * one.
 *
 * Run:
 *   pnpm seed:jurisdictions
 *
 * Env (loaded from .env.local):
 *   VITE_SUPABASE_URL           — shared with the client
 *   SUPABASE_SERVICE_ROLE_KEY   — SERVER ONLY. Never import from src/.
 *   CS_CITYLIMITS_ARCGIS_URL    — ArcGIS FeatureServer/MapServer layer URL
 *   EPC_BOUNDARY_ARCGIS_URL     — ArcGIS FeatureServer/MapServer layer URL
 *
 * Idempotent: safe to re-run. Upserts by slug.
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  area as turfArea,
  union as turfUnion,
  featureCollection,
  multiPolygon,
} from '@turf/turf';

// Minimal local GeoJSON types (avoid a hard dep on @types/geojson for a
// server-only script). These match the RFC 7946 shapes turf consumes.
type Position = number[];
type Polygon = { type: 'Polygon'; coordinates: Position[][] };
type MultiPolygon = { type: 'MultiPolygon'; coordinates: Position[][][] };
type GeoJsonProperties = { [k: string]: unknown } | null;
type Feature<G, P extends GeoJsonProperties = GeoJsonProperties> = {
  type: 'Feature';
  geometry: G;
  properties: P;
};
type FeatureCollection<G, P extends GeoJsonProperties = GeoJsonProperties> = {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
};

// Load .env.local before reading any process.env values.
loadEnv({ path: '.env.local' });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type JurisdictionSpec = {
  slug: string;
  name: string;
  authority_type: 'municipal' | 'county_unincorporated';
  code_label: string;
  code_home_url: string;
  current_code_version: string;
  notes: string;
  endpointEnv: 'CS_CITYLIMITS_ARCGIS_URL' | 'EPC_BOUNDARY_ARCGIS_URL';
  snapshotTitle: string;
};

const SPECS: JurisdictionSpec[] = [
  {
    slug: 'colorado_springs',
    name: 'City of Colorado Springs',
    authority_type: 'municipal',
    code_label: 'UDC',
    code_home_url:
      'https://codelibrary.amlegal.com/codes/coloradospringsco/latest/overview',
    current_code_version:
      'Chapter 7 (UDC), codified through Ord. 25-94 (2025-11-25)',
    notes:
      'UDC Scrub project active as of 2026-02; future amendments to be tracked via source_snapshot versioning.',
    endpointEnv: 'CS_CITYLIMITS_ARCGIS_URL',
    snapshotTitle: 'City of Colorado Springs — City Limits (ArcGIS)',
  },
  {
    slug: 'el_paso_county_unincorporated',
    name: 'El Paso County (unincorporated)',
    authority_type: 'county_unincorporated',
    code_label: 'LDC',
    code_home_url:
      'https://library.municode.com/co/el_paso_county/codes/land_development_code',
    current_code_version: 'LDC current codification (Municode)',
    notes:
      'Phase 0 simplification: treating entire county boundary as the unincorporated pack. Resolution precedence (CS > EPC > none) handles correct dispatch for hand-picked parcels. Phase 1 will subtract other incorporated places (Fountain, Manitou Springs, Monument, etc.).',
    endpointEnv: 'EPC_BOUNDARY_ARCGIS_URL',
    snapshotTitle: 'El Paso County — County Boundary (ArcGIS)',
  },
];

// ---------------------------------------------------------------------------
// Env + client
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SQ_METERS_PER_SQ_MILE = 2_589_988.110336;

type PolyFeature = Feature<Polygon | MultiPolygon>;

/** Fetch an ArcGIS layer as GeoJSON, restricted to EPSG:4326. */
async function fetchArcgisLayer(
  layerUrl: string,
): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const trimmed = layerUrl.replace(/\/+$/, '');
  const url = `${trimmed}/query?where=1%3D1&outFields=*&f=geojson&outSR=4326`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ArcGIS fetch failed ${res.status} ${res.statusText}: ${url}`);
  }
  const json = (await res.json()) as FeatureCollection<Polygon | MultiPolygon>;
  if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new Error(`Unexpected ArcGIS response shape for ${url}`);
  }
  if (json.features.length === 0) {
    throw new Error(`ArcGIS layer returned zero features: ${url}`);
  }
  return json;
}

/**
 * Union all polygon / multipolygon features into a single MultiPolygon.
 * turf.union returns Polygon | MultiPolygon; we coerce to MultiPolygon so the
 * downstream PostGIS column (MultiPolygon, 4326) always receives the right
 * geometry type.
 */
function unionToMultiPolygon(
  fc: FeatureCollection<Polygon | MultiPolygon>,
): MultiPolygon {
  const features = fc.features.filter(
    (f: Feature<Polygon | MultiPolygon>): f is PolyFeature =>
      !!f?.geometry &&
      (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );

  if (features.length === 0) {
    throw new Error('No polygon features to union');
  }

  let unioned: Feature<Polygon | MultiPolygon>;
  if (features.length === 1) {
    unioned = features[0];
  } else {
    const result = turfUnion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      featureCollection(features as any) as any,
    );
    if (!result) {
      throw new Error('turf.union returned null');
    }
    unioned = result as Feature<Polygon | MultiPolygon>;
  }

  if (unioned.geometry.type === 'MultiPolygon') {
    return unioned.geometry;
  }
  // Coerce Polygon -> MultiPolygon.
  return multiPolygon([unioned.geometry.coordinates]).geometry;
}

// ---------------------------------------------------------------------------
// Main seed logic
// ---------------------------------------------------------------------------

async function seedOne(spec: JurisdictionSpec): Promise<void> {
  const layerUrl = requireEnv(spec.endpointEnv);
  const retrievedAt = new Date().toISOString();

  console.log(`\n[${spec.slug}] fetching ${layerUrl}`);
  const fc = await fetchArcgisLayer(layerUrl);
  const featureCount = fc.features.length;

  const geom = unionToMultiPolygon(fc);
  const areaFeature: Feature<MultiPolygon> = {
    type: 'Feature',
    properties: {},
    geometry: geom,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const areaSqMeters = turfArea(areaFeature as any);
  const areaSqMiles = areaSqMeters / SQ_METERS_PER_SQ_MILE;

  const { data: jurisdictionId, error: rpcErr } = await supabase.rpc(
    'upsert_jurisdiction',
    {
      _slug: spec.slug,
      _name: spec.name,
      _authority: spec.authority_type,
      _geojson: geom,
      _code_label: spec.code_label,
      _code_home_url: spec.code_home_url,
      _current_code_version: spec.current_code_version,
      _notes: spec.notes,
    },
  );
  if (rpcErr) {
    throw new Error(`upsert_jurisdiction RPC failed: ${rpcErr.message}`);
  }
  if (!jurisdictionId || typeof jurisdictionId !== 'string') {
    throw new Error('upsert_jurisdiction returned no id');
  }

  const { error: snapErr } = await supabase.from('source_snapshots').insert({
    jurisdiction_id: jurisdictionId,
    title: spec.snapshotTitle,
    url: layerUrl,
    source_class: 'official',
    retrieved_at: retrievedAt,
    notes: `Seeded by scripts/seed_jurisdictions.ts. Fetched ${featureCount} feature(s); unioned to MultiPolygon; area ≈ ${areaSqMiles.toFixed(2)} sq mi.`,
  });
  if (snapErr) {
    throw new Error(`source_snapshots insert failed: ${snapErr.message}`);
  }

  console.log(
    `[${spec.slug}] ok — features=${featureCount} area=${areaSqMiles.toFixed(2)} sq mi id=${jurisdictionId}`,
  );
}

async function main(): Promise<void> {
  console.log('seed_jurisdictions: starting');
  for (const spec of SPECS) {
    await seedOne(spec);
  }
  console.log('\nseed_jurisdictions: done');
}

main().catch((err) => {
  console.error('\nseed_jurisdictions: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
