// scripts/seed_municipal_boundaries.ts
//
// Seeds boundaries for the seven incorporated municipalities inside El Paso
// County so the EPC unincorporated jurisdiction can be correctly computed via
// ST_Difference (refresh_unincorporated_boundary).
//
// Source: DOLA / COOIT Municipal Boundaries (CO statewide), best-effort per
// DOLA's own disclaimer. Acceptable for ST_Difference at feasibility grade.
//   https://geodata.colorado.gov/datasets/COOIT::municipal-boundaries
//
// The DOLA dataset stores ONE ROW PER ANNEXATION EVENT. We collect all rows
// per cityname into a MultiPolygon and rely on upsert_jurisdiction's
// ST_UnaryUnion to dissolve overlaps/slivers into a clean boundary
// server-side. The dissolve migration must be applied before this runs.
//
// Tempe guard: every annexation polygon's outer-ring centroid must fall
// inside a conservative El Paso County bounding box. Cross-state or
// cross-county "same name" matches abort the upsert for that muni.
//
// Run: pnpm tsx scripts/seed_municipal_boundaries.ts

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

const DOLA_URL =
  'https://services3.arcgis.com/DgjqnJA1rgO92Soi/arcgis/rest/services/Municipal_Boundary/FeatureServer/0/query';

// Conservative EPC bounding box (lon, lat). EPC spans roughly
// lat 38.52 - 39.13, lon -104.95 - -103.99; we buffer ~0.2deg on each side.
const EPC_BBOX = {
  minLon: -105.2, maxLon: -103.8,
  minLat:  38.4,  maxLat:  39.3,
};

type Muni = {
  slug: string;
  name: string;
  cityname: string;  // exact DOLA cityname (matched case-insensitively)
  notes: string;
};

const MUNIS: Muni[] = [
  {
    slug: 'manitou_springs',
    name: 'City of Manitou Springs',
    cityname: 'Manitou Springs',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort, not authoritative). Zoning endpoint resolution pending (AGOL app a352048fe74549378e417e5b0aa3f733).',
  },
  {
    slug: 'monument',
    name: 'Town of Monument',
    cityname: 'Monument',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). Zoning endpoint resolution pending (AGOL app f58f5b38484246e4a5fc658b5b59d329). Caveat: municipal boundary interleaves with metro districts; verify jurisdiction via assessor tax-entity for ingestion.',
  },
  {
    slug: 'fountain',
    name: 'City of Fountain',
    cityname: 'Fountain',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). Zoning endpoint resolution pending (AGOL app 58c2021b594746d59c7e0e3880e7c0e0).',
  },
  {
    slug: 'palmer_lake',
    name: 'Town of Palmer Lake',
    cityname: 'Palmer Lake',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). No public GIS; municipal code available as PDF for future ingestion.',
  },
  {
    slug: 'green_mountain_falls',
    name: 'Town of Green Mountain Falls',
    cityname: 'Green Mountain Falls',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). No public GIS; municipal code available as PDF for future ingestion.',
  },
  {
    slug: 'calhan',
    name: 'Town of Calhan',
    cityname: 'Calhan',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). No public GIS; municipal code available as PDF for future ingestion.',
  },
  {
    slug: 'ramah',
    name: 'Town of Ramah',
    cityname: 'Ramah',
    notes: 'Phase 2: boundary from DOLA Municipal Boundaries (best-effort). No public GIS; municipal code available as PDF for future ingestion.',
  },
];

// ---------- helpers ----------

function isInEPCBbox(lon: number, lat: number): boolean {
  return lon >= EPC_BBOX.minLon && lon <= EPC_BBOX.maxLon
      && lat >= EPC_BBOX.minLat && lat <= EPC_BBOX.maxLat;
}

// Signed-area-weighted centroid of a closed ring. Sufficient for the Tempe
// guard; not precision-grade.
function polygonCentroid(ring: number[][]): [number, number] {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
    area += f;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    return [ring[0][0], ring[0][1]];  // degenerate ring; fall back to vertex
  }
  return [cx / (6 * area), cy / (6 * area)];
}

async function fetchCity(cityname: string) {
  const url = new URL(DOLA_URL);
  url.searchParams.set('where', `UPPER(cityname)='${cityname.toUpperCase().replace(/'/g, "''")}'`);
  url.searchParams.set('outFields', 'cityname');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`DOLA query failed for ${cityname}: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: any };
      properties: Record<string, any>;
    }>;
    exceededTransferLimit?: boolean;
  };
  return data;
}

// ---------- main ----------

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
                  ?? process.env.SUPABASE_SECRET_KEY
                  ?? process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or service-role/secret key in env. Checked: VITE_SUPABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_SERVICE_KEY');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('Seeding seven incorporated municipalities of El Paso County from DOLA...\n');

  const summary: Array<{ slug: string; features: number; ok: boolean; notes: string }> = [];

  for (const muni of MUNIS) {
    process.stdout.write(`• ${muni.cityname.padEnd(24)} `);
    let fc;
    try {
      fc = await fetchCity(muni.cityname);
    } catch (err) {
      console.log(`FETCH FAILED — ${(err as Error).message}`);
      summary.push({ slug: muni.slug, features: 0, ok: false, notes: 'fetch failed' });
      continue;
    }
    const n = fc.features.length;
    if (n === 0) {
      console.log('ZERO FEATURES — check cityname spelling in DOLA');
      summary.push({ slug: muni.slug, features: 0, ok: false, notes: 'no features' });
      continue;
    }
    if (fc.exceededTransferLimit) {
      console.log(`WARN: exceededTransferLimit (>${n} features). Re-run with pagination support needed.`);
    }

    // Tempe guard: every polygon's outer-ring centroid must be inside EPC bbox.
    const polygons: number[][][][] = [];
    let outsideCount = 0;
    for (const f of fc.features) {
      const g = f.geometry;
      const polysOfFeature =
        g.type === 'Polygon' ? [g.coordinates as number[][][]] :
        g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) :
        [];
      for (const poly of polysOfFeature) {
        const outerRing = poly[0];
        const [clon, clat] = polygonCentroid(outerRing);
        if (!isInEPCBbox(clon, clat)) {
          outsideCount += 1;
          continue;
        }
        polygons.push(poly);
      }
    }

    if (outsideCount > 0) {
      // Strict: any outside means cityname is ambiguous across the state.
      console.log(`TEMPE GUARD: ${outsideCount}/${n} polygons outside EPC bbox — ABORTING upsert for ${muni.slug}`);
      summary.push({ slug: muni.slug, features: n, ok: false, notes: `${outsideCount} polygons outside EPC bbox` });
      continue;
    }

    const mp = { type: 'MultiPolygon', coordinates: polygons };

    const { data, error } = await sb.rpc('upsert_jurisdiction', {
      _slug: muni.slug,
      _name: muni.name,
      _authority: 'municipal',
      _geojson: mp,
      _code_label: null,
      _code_home_url: null,
      _current_code_version: null,
      _notes: muni.notes,
    });
    if (error) {
      console.log(`UPSERT FAILED — ${error.message}`);
      summary.push({ slug: muni.slug, features: n, ok: false, notes: `upsert: ${error.message}` });
      continue;
    }
    console.log(`OK — ${n} annexation polygons → id ${data}`);
    summary.push({ slug: muni.slug, features: n, ok: true, notes: '' });
  }

  console.log('\nRecomputing EPC unincorporated boundary via refresh_unincorporated_boundary...');
  const { data: refreshResult, error: refreshErr } = await sb.rpc(
    'refresh_unincorporated_boundary',
    { _county_slug: 'el_paso_county' }
  );
  if (refreshErr) {
    console.error(`REFRESH FAILED — ${refreshErr.message}`);
    process.exit(1);
  }
  console.log(`Refresh result: ${JSON.stringify(refreshResult)}\n`);

  console.log('Summary');
  console.log('-------');
  for (const row of summary) {
    console.log(
      `${row.ok ? '✓' : '✗'}  ${row.slug.padEnd(24)} ${row.features.toString().padStart(4)} features${row.notes ? `   — ${row.notes}` : ''}`
    );
  }
  const okCount = summary.filter(s => s.ok).length;
  console.log(`\n${okCount}/${MUNIS.length} municipalities upserted.`);
  if (okCount < MUNIS.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
