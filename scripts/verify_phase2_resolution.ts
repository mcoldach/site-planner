// scripts/verify_phase2_resolution.ts
//
// Verifies that after the DOLA municipal-boundary seed + boundary-engine
// recompute, parcels in Manitou Springs, Monument, and Fountain resolve to
// their new municipal pack rather than el_paso_county_unincorporated.
//
// Read-only: does not write to the parcels table. Fetches each test parcel's
// geometry from the statewide CO parcels FeatureServer and passes it to
// resolve_jurisdiction_for_geometry — the canonical resolver, byte-identical
// to get_parcel_context's logic.
//
// Run: pnpm tsx scripts/verify_phase2_resolution.ts

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

const STATEWIDE_PARCELS =
  'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0/query';

const TESTS = [
  { apn: '7404304006', expected: 'manitou_springs' },
  { apn: '7100000458', expected: 'monument' },
  { apn: '5607104023', expected: 'fountain' },
];

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchParcelGeometry(apn: string) {
  const url = new URL(STATEWIDE_PARCELS);
  url.searchParams.set('where', `parcel_id='${apn}'`);
  url.searchParams.set('outFields', 'parcel_id');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`statewide parcels query failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    features?: Array<{ geometry: any; properties: Record<string, any> }>;
  };
  if (!data.features?.length) {
    throw new Error(`no parcel found for APN ${apn}`);
  }
  if (data.features.length > 1) {
    console.warn(`  WARN: ${data.features.length} parcels match APN ${apn}; using first`);
  }
  return data.features[0].geometry;
}

async function main() {
  console.log('Verifying jurisdiction resolution for Phase 2 test parcels...\n');
  let passes = 0;
  for (const test of TESTS) {
    process.stdout.write(`• APN ${test.apn} → expected ${test.expected.padEnd(20)} `);
    let geom;
    try {
      geom = await fetchParcelGeometry(test.apn);
    } catch (err) {
      console.log(`FETCH FAILED — ${(err as Error).message}`);
      continue;
    }
    const { data, error } = await sb.rpc('resolve_jurisdiction_for_geometry', { _geojson: geom });
    if (error) {
      console.log(`RPC FAILED — ${error.message}`);
      continue;
    }
    if (!data) {
      console.log('NULL — no jurisdiction contains parcel centroid');
      continue;
    }
    const resolved = (data as { slug: string }).slug;
    const ok = resolved === test.expected;
    console.log(`${ok ? '✓' : '✗'} resolved: ${resolved}`);
    if (ok) passes += 1;
  }
  console.log(`\n${passes}/${TESTS.length} tests passed.`);
  if (passes < TESTS.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
