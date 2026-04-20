/**
 * scripts/seed_parcels.ts
 *
 * Phase 0 seed: fetch target parcels from Colorado Public Parcels (ArcGIS),
 * upsert into `parcels`, then print acreage + jurisdiction resolution.
 *
 * Run:
 *   pnpm seed:parcels
 *
 * Env (loaded from .env.local):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PHASE0_SEED_APNS — comma-separated parcel numbers (source APN strings)
 *
 * Idempotent: safe to re-run. Upserts by (source_system, source_apn).
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

const CO_PUBLIC_PARCELS_QUERY_BASE =
  'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0/query';

/** Candidate attribute names for parcel number (Step 1 picks the first present). */
const APN_FIELD_CANDIDATES = [
  'parcel_id',
  'PARCEL_NO',
  'PARCELNBR',
  'APN',
  'ACCOUNT',
] as const;

type ArcGisJsonFeature = {
  attributes?: Record<string, unknown>;
};

type ArcGisFeatureSet = {
  features?: ArcGisJsonFeature[];
};

type GeoJsonFeature = {
  type: 'Feature';
  geometry: Record<string, unknown>;
  properties?: Record<string, unknown> | null;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

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

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseSeedApns(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function discoverApnFieldName(attrs: Record<string, unknown>): string {
  for (const key of APN_FIELD_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      const v = attrs[key];
      if (v != null && String(v).trim() !== '') {
        return key;
      }
    }
  }
  throw new Error(
    `Could not resolve parcel number field from probe attributes. Keys: ${Object.keys(attrs).join(', ')}`,
  );
}

async function probeParcelAttributes(): Promise<{
  apnField: string;
  sampleAttributes: Record<string, unknown>;
}> {
  const url = `${CO_PUBLIC_PARCELS_QUERY_BASE}?where=${encodeURIComponent('1=1')}&resultRecordCount=1&outFields=*&f=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ArcGIS probe failed ${res.status} ${res.statusText}: ${url}`);
  }
  const json = (await res.json()) as ArcGisFeatureSet;
  const attrs = json.features?.[0]?.attributes;
  if (!attrs || typeof attrs !== 'object') {
    throw new Error(`ArcGIS probe returned no feature attributes: ${url}`);
  }
  const apnField = discoverApnFieldName(attrs);
  return { apnField, sampleAttributes: attrs };
}

async function main(): Promise<void> {
  console.log('seed_parcels: starting');

  const apns = parseSeedApns(requireEnv('PHASE0_SEED_APNS'));
  if (apns.length === 0) {
    throw new Error('PHASE0_SEED_APNS is empty after parsing');
  }

  // Step 1 — discover APN field and log sample attributes.
  const { apnField, sampleAttributes } = await probeParcelAttributes();
  console.log('\n[Step 1] Probe: sample feature attributes (JSON):');
  console.log(JSON.stringify(sampleAttributes, null, 2));
  console.log(
    `\n[Step 1] Parcel number is stored in attribute "${apnField}" ` +
      '(Colorado Public Parcels uses `parcel_id`; other layers may use PARCEL_NO, PARCELNBR, APN, or ACCOUNT).',
  );

  // Step 2 — fetch target parcels as GeoJSON (EPSG:4326).
  const inList = apns.map(escapeSqlStringLiteral).join(',');
  const where = `${apnField} IN (${inList})`;
  const params = new URLSearchParams({
    where,
    outFields: '*',
    f: 'geojson',
    outSR: '4326',
  });
  const queryUrl = `${CO_PUBLIC_PARCELS_QUERY_BASE}?${params.toString()}`;

  console.log(`\n[Step 2] Fetching ${apns.length} parcel(s): ${queryUrl}`);
  const res = await fetch(queryUrl);
  if (!res.ok) {
    throw new Error(`ArcGIS parcel fetch failed ${res.status} ${res.statusText}: ${queryUrl}`);
  }
  const fc = (await res.json()) as GeoJsonFeatureCollection;
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Unexpected GeoJSON from ArcGIS: ${queryUrl}`);
  }
  if (fc.features.length === 0) {
    throw new Error(`ArcGIS returned zero features for requested APNs: ${queryUrl}`);
  }

  const retrievedAt = new Date().toISOString();

  // Step 3 — upsert each feature.
  for (const feature of fc.features) {
    const props = feature.properties ?? {};
    const raw = props[apnField];
    if (raw == null || String(raw).trim() === '') {
      throw new Error(
        `Feature missing ${apnField} in properties: ${JSON.stringify(props).slice(0, 500)}`,
      );
    }
    const sourceApn = String(raw).trim();

    const { error: rpcErr } = await supabase.rpc('upsert_parcel', {
      _source_apn: sourceApn,
      _source_system: 'co_public_parcels',
      _geojson: feature.geometry,
      _raw_attrs: props,
      _retrieved_at: retrievedAt,
      _source_url: queryUrl,
    });
    if (rpcErr) {
      throw new Error(`upsert_parcel RPC failed for ${sourceApn}: ${rpcErr.message}`);
    }
    console.log(`[upsert] ok source_apn=${sourceApn}`);
  }

  const { data: summaryRows, error: sumErr } = await supabase.rpc('parcel_seed_summary', {
    _source_apns: apns,
  });
  if (sumErr) {
    throw new Error(`parcel_seed_summary RPC failed: ${sumErr.message}`);
  }

  console.log('\nSummary (acres + resolved jurisdiction):');
  console.table(
    (summaryRows ?? []).map((row: { source_apn: string; area_acres: number; resolved_jurisdiction: string }) => ({
      source_apn: row.source_apn,
      area_acres: row.area_acres != null ? Number(row.area_acres).toFixed(4) : '',
      resolved_jurisdiction: row.resolved_jurisdiction,
    })),
  );

  console.log('\nseed_parcels: done');
}

main().catch((err) => {
  console.error('\nseed_parcels: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
