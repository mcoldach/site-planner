// scripts/resolve_agol_zoning_endpoints.ts
//
// Phase 2 prep (NOT a load-bearing fix): discovers zoning endpoints behind
// AGOL apps for Manitou Springs, Monument, and Fountain. Does NOT write to
// the database — purely a discovery script whose output feeds a follow-on
// session that wires endpoints into parcel_source.
//
// For each app ID, walks app → app data → harvested UUIDs → identifies any
// that resolve to a Web Map → reads each webmap's operationalLayers →
// applies a Tempe guard (query one feature in 4326 and verify its centroid
// falls inside the EPC bbox) and a zoning-keyword heuristic on layer titles.
//
// Output: full table of layers found + a summary of "most likely zoning
// endpoints" per app. Human eyeballs the candidates before any wire-up.
//
// Run: pnpm tsx scripts/resolve_agol_zoning_endpoints.ts

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

// EPC bbox (lon/lat) — same conservative buffer as the boundary seed script.
const EPC_BBOX = {
  minLon: -105.2, maxLon: -103.8,
  minLat:  38.4,  maxLat:  39.3,
};

type App = { slug: string; appId: string };

const APPS: App[] = [
  { slug: 'manitou_springs', appId: 'a352048fe74549378e417e5b0aa3f733' },
  { slug: 'monument',        appId: 'f58f5b38484246e4a5fc658b5b59d329' },
  { slug: 'fountain',        appId: '58c2021b594746d59c7e0e3880e7c0e0' },
];

const AGOL_ITEM = 'https://www.arcgis.com/sharing/rest/content/items';
const ZONING_RX = /zon|land\s*use|district|udc|ldc/i;
const UUID_RX = /^[0-9a-f]{32}$/i;

// ---------- helpers ----------

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  // AGOL sometimes returns HTTP 200 with {error: {...}} body.
  if (data?.error) throw new Error(`AGOL ${data.error.code}: ${data.error.message}`);
  return data;
}

const fetchItem     = (id: string) => fetchJson(`${AGOL_ITEM}/${id}?f=json`);
const fetchItemData = (id: string) => fetchJson(`${AGOL_ITEM}/${id}/data?f=json`);

// Recursively scan a JSON value for UUID-shaped strings.
function harvestUuids(obj: any, acc = new Set<string>()): Set<string> {
  if (obj == null) return acc;
  if (typeof obj === 'string') {
    if (UUID_RX.test(obj)) acc.add(obj);
    return acc;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) harvestUuids(v, acc);
    return acc;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) harvestUuids(v, acc);
  }
  return acc;
}

// Recursively scan webmap JSON for operationalLayers (handles group layers).
function harvestOperationalLayers(obj: any, acc: any[] = []): any[] {
  if (obj == null || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    for (const v of obj) harvestOperationalLayers(v, acc);
    return acc;
  }
  if (Array.isArray(obj.operationalLayers)) {
    for (const layer of obj.operationalLayers) {
      acc.push(layer);
      harvestOperationalLayers(layer, acc);
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'object') harvestOperationalLayers(v, acc);
  }
  return acc;
}

function isInEPCBbox(lon: number, lat: number): boolean {
  return lon >= EPC_BBOX.minLon && lon <= EPC_BBOX.maxLon
      && lat >= EPC_BBOX.minLat && lat <= EPC_BBOX.maxLat;
}

async function tempeGuardLayer(layerUrl: string): Promise<{ ok: boolean; sample: [number, number] | null; note: string }> {
  // Strip query string + trailing slash from layer URL, then build a query
  // requesting one feature reprojected to 4326. Avoids needing a reprojection
  // library client-side.
  const cleanUrl = layerUrl.replace(/\/$/, '').split('?')[0];
  const q = new URL(`${cleanUrl}/query`);
  q.searchParams.set('where', '1=1');
  q.searchParams.set('outFields', '*');
  q.searchParams.set('outSR', '4326');
  q.searchParams.set('resultRecordCount', '1');
  q.searchParams.set('f', 'geojson');
  try {
    const data = await fetchJson(q.toString());
    const feat = data?.features?.[0];
    if (!feat?.geometry) return { ok: false, sample: null, note: 'no features returned' };
    const g = feat.geometry;
    let coord: [number, number] | null = null;
    if (g.type === 'Point')             coord = g.coordinates;
    else if (g.type === 'Polygon')      coord = g.coordinates[0]?.[0];
    else if (g.type === 'MultiPolygon') coord = g.coordinates[0]?.[0]?.[0];
    else if (g.type === 'LineString')   coord = g.coordinates[0];
    if (!coord) return { ok: false, sample: null, note: `unsupported geometry ${g.type}` };
    return { ok: isInEPCBbox(coord[0], coord[1]), sample: coord, note: '' };
  } catch (err) {
    return { ok: false, sample: null, note: `query failed: ${(err as Error).message}` };
  }
}

// ---------- per-app resolution ----------

type LayerRow = {
  app_slug: string;
  app_id: string;
  webmap_id: string;
  webmap_title: string;
  layer_title: string;
  layer_url: string;
  zoning_match: boolean;
  pikes_peak_ok: boolean;
  sample_coord: string;
  note: string;
};

async function resolveApp(app: App): Promise<LayerRow[]> {
  console.log(`\n─── ${app.slug}  (${app.appId}) ───`);
  const rows: LayerRow[] = [];

  let appItem: any;
  try { appItem = await fetchItem(app.appId); }
  catch (err) { console.log(`  app fetch FAILED: ${(err as Error).message}`); return rows; }
  console.log(`  app type: ${appItem.type}`);
  console.log(`  app title: "${appItem.title}"`);

  let appData: any;
  try { appData = await fetchItemData(app.appId); }
  catch (err) { console.log(`  app data FAILED: ${(err as Error).message}`); return rows; }

  const candidates = harvestUuids(appData);
  candidates.delete(app.appId);
  console.log(`  harvested ${candidates.size} candidate UUIDs from app data`);

  // Resolve each UUID; keep Web Maps.
  const webmaps: { id: string; title: string }[] = [];
  for (const uuid of candidates) {
    try {
      const meta = await fetchItem(uuid);
      if (meta.type === 'Web Map') webmaps.push({ id: uuid, title: meta.title });
    } catch {
      // Many UUIDs reference deleted/private items or aren't items at all.
    }
  }
  if (webmaps.length === 0) {
    console.log('  no Web Map items found among harvested UUIDs');
    return rows;
  }
  console.log(`  ${webmaps.length} Web Map(s) referenced:`);
  for (const wm of webmaps) console.log(`    • ${wm.id}  "${wm.title}"`);

  // For each webmap, list operational layers and Tempe-guard each.
  for (const wm of webmaps) {
    let wmData: any;
    try { wmData = await fetchItemData(wm.id); }
    catch (err) { console.log(`  webmap ${wm.id} data FAILED: ${(err as Error).message}`); continue; }
    const layers = harvestOperationalLayers(wmData).filter((l: any) => l?.url);
    console.log(`  ${layers.length} operational layer(s) with URLs in webmap "${wm.title}"`);
    for (const layer of layers) {
      const title = layer.title ?? layer.name ?? layer.layerDefinition?.name ?? '(untitled)';
      const blob  = `${title} ${layer.layerDefinition?.name ?? ''}`;
      const guard = await tempeGuardLayer(layer.url);
      rows.push({
        app_slug:      app.slug,
        app_id:        app.appId,
        webmap_id:     wm.id,
        webmap_title:  wm.title,
        layer_title:   title,
        layer_url:     layer.url,
        zoning_match:  ZONING_RX.test(blob),
        pikes_peak_ok: guard.ok,
        sample_coord:  guard.sample ? `${guard.sample[0].toFixed(4)}, ${guard.sample[1].toFixed(4)}` : '',
        note:          guard.note,
      });
    }
  }
  return rows;
}

// ---------- main ----------

async function main() {
  console.log('Resolving AGOL zoning endpoints — Manitou, Monument, Fountain');
  console.log('Discovery only; does not write to the database.\n');

  const allRows: LayerRow[] = [];
  for (const app of APPS) {
    const rows = await resolveApp(app);
    allRows.push(...rows);
  }

  console.log('\n═══ All discovered layers ═══\n');
  if (allRows.length === 0) {
    console.log('  (none)');
    process.exit(1);
  }
  for (const r of allRows) {
    const z = r.zoning_match  ? '✓ zoning kw' : '  no kw    ';
    const p = r.pikes_peak_ok ? '✓ EPC' : '✗ EPC';
    console.log(`  [${r.app_slug.padEnd(16)}] ${z}  ${p}  sample (${r.sample_coord || 'n/a'})`);
    console.log(`    title: "${r.layer_title}"`);
    console.log(`    url:   ${r.layer_url}`);
    if (r.note) console.log(`    note:  ${r.note}`);
    console.log();
  }

  console.log('═══ Likely zoning endpoints (zoning keyword + EPC bbox) ═══\n');
  for (const app of APPS) {
    const likely = allRows.filter(r => r.app_slug === app.slug && r.zoning_match && r.pikes_peak_ok);
    if (likely.length === 0) {
      console.log(`  ${app.slug.padEnd(16)}  (no candidates — manual review needed)`);
    } else {
      for (const r of likely) {
        console.log(`  ${app.slug.padEnd(16)}  "${r.layer_title}"`);
        console.log(`  ${' '.padEnd(16)}  ${r.layer_url}`);
        console.log(`  ${' '.padEnd(16)}  via webmap ${r.webmap_id}`);
      }
    }
    console.log();
  }

  console.log('Provenance note for next session:');
  console.log('  These FeatureServer URLs are *retrieval mechanisms*, not legal');
  console.log('  sources of record. When wired into parcel_source / zone_registry,');
  console.log('  source_snapshot.source_url should point at the adopted ordinance');
  console.log('  or zoning map document; the AGOL URL is recorded separately as');
  console.log('  the retrieval endpoint.');
}

main().catch((err) => { console.error(err); process.exit(1); });
