// scripts/resolve_zoning_layers.ts
//
// Read-only discovery: resolves the FeatureServer/MapServer layer URLs behind
// three AGOL apps (Manitou Springs, Monument, Fountain) for EPC municipal
// zoning, then introspects + bounds-checks each layer against the EPC bbox.
//
// Run: pnpm resolve:zoning

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ---------- constants ----------

const APPS = [
  { slug: 'manitou_springs', appId: 'a352048fe74549378e417e5b0aa3f733', appType: 'instant' },
  { slug: 'monument',        appId: '496ace6537b54763994ba1c8f612f238', appType: 'instant' },
  { slug: 'fountain',        appId: '58c2021b594746d59c7e0e3880e7c0e0', appType: 'experience' },
];

const EPC_BBOX = { minLon: -105.05, maxLon: -104.05, minLat: 38.50, maxLat: 39.30 };

const AGOL_ITEM_BASE = 'https://www.arcgis.com/sharing/rest/content/items';

const ZONING_RX = /zon|land.?use|district/i;
const WEB_MERCATOR_R = 20037508.34;

// ---------- types ----------

type App = (typeof APPS)[number];

type LayerRecord = {
  app_slug: string;
  app_id: string;
  app_type: string;
  source_webmap_id: string | null;   // null if Experience Builder pointed directly at a service
  layer_name: string;
  layer_url: string;                 // the specific layer URL (with /N suffix)
  geometry_type: string;             // esriGeometryPolygon, etc.
  wkid: number;
  extent_wgs84: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
  in_bounds: boolean | 'unverified';
  copyright: string | null;
  field_names: string[];
  zoning_keyword_match: boolean;     // true if layer_name matches /zon|land.?use|district/i
  error: string | null;
};

// A collected service/layer URL plus the webmap it came from (null if direct).
type CollectedUrl = { url: string; webmapId: string | null };

// ---------- helpers ----------

// AGOL frequently returns HTTP 200 with an {error:{...}} body — treat that as
// a failure too. Standalone copy of the pattern in resolve_agol_zoning_endpoints.ts.
async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  if (data?.error) throw new Error(`AGOL ${data.error.code}: ${data.error.message}`);
  return data;
}

const fetchItemData = (id: string) => fetchJson(`${AGOL_ITEM_BASE}/${id}/data?f=json`);

// Recursively scan a webmap JSON for operationalLayers (handles nested/grouped
// layers, which carry their own `layers` sub-arrays).
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
  if (Array.isArray(obj.layers)) {
    for (const layer of obj.layers) {
      acc.push(layer);
      harvestOperationalLayers(layer, acc);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') harvestOperationalLayers(v, acc);
  }
  return acc;
}

// Pull every operationalLayers[].url out of a web map's data JSON.
function urlsFromWebmap(wmData: any): string[] {
  const layers = harvestOperationalLayers(wmData);
  const urls = new Set<string>();
  for (const l of layers) {
    if (typeof l?.url === 'string' && l.url) urls.add(l.url);
  }
  return [...urls];
}

// Is this a service root (…/FeatureServer or …/MapServer with no layer index)?
function isServiceRoot(url: string): boolean {
  const clean = url.replace(/\/+$/, '').split('?')[0];
  return /\/(FeatureServer|MapServer)$/i.test(clean);
}

// Is this a specific layer (…/FeatureServer/N or …/MapServer/N)?
function isSpecificLayer(url: string): boolean {
  const clean = url.replace(/\/+$/, '').split('?')[0];
  return /\/(FeatureServer|MapServer)\/\d+$/i.test(clean);
}

function cleanUrl(url: string): string {
  return url.replace(/\/+$/, '').split('?')[0];
}

function webMercatorToWgs84(x: number, y: number): [number, number] {
  const lon = (x / WEB_MERCATOR_R) * 180;
  const lat = (Math.atan(Math.exp((y / WEB_MERCATOR_R) * Math.PI)) * 360) / Math.PI - 90;
  return [lon, lat];
}

function overlapsBbox(b: { xmin: number; ymin: number; xmax: number; ymax: number }): boolean {
  return (
    b.xmin <= EPC_BBOX.maxLon &&
    b.xmax >= EPC_BBOX.minLon &&
    b.ymin <= EPC_BBOX.maxLat &&
    b.ymax >= EPC_BBOX.minLat
  );
}

function pointInBbox(lon: number, lat: number): boolean {
  return (
    lon >= EPC_BBOX.minLon &&
    lon <= EPC_BBOX.maxLon &&
    lat >= EPC_BBOX.minLat &&
    lat <= EPC_BBOX.maxLat
  );
}

// Fallback bounds check for projections we can't reproject inline (e.g. CO
// state plane): ask the service for a single feature in 4326 and test a vertex.
async function sampleFeatureInBounds(
  layerUrl: string,
): Promise<{ result: boolean | 'unverified'; extent: { xmin: number; ymin: number; xmax: number; ymax: number } | null }> {
  const base = cleanUrl(layerUrl);
  const q = new URL(`${base}/query`);
  q.searchParams.set('where', '1=1');
  q.searchParams.set('outSR', '4326');
  q.searchParams.set('resultRecordCount', '1');
  q.searchParams.set('f', 'geojson');
  try {
    const data = await fetchJson(q.toString());
    const geom = data?.features?.[0]?.geometry;
    if (!geom) return { result: 'unverified', extent: null };
    let coord: [number, number] | null = null;
    switch (geom.type) {
      case 'Point':           coord = geom.coordinates; break;
      case 'MultiPoint':      coord = geom.coordinates?.[0]; break;
      case 'LineString':      coord = geom.coordinates?.[0]; break;
      case 'MultiLineString': coord = geom.coordinates?.[0]?.[0]; break;
      case 'Polygon':         coord = geom.coordinates?.[0]?.[0]; break;
      case 'MultiPolygon':    coord = geom.coordinates?.[0]?.[0]?.[0]; break;
    }
    if (!coord || coord.length < 2) return { result: 'unverified', extent: null };
    const [lon, lat] = coord;
    const extent = { xmin: lon, ymin: lat, xmax: lon, ymax: lat };
    return { result: pointInBbox(lon, lat), extent };
  } catch {
    return { result: 'unverified', extent: null };
  }
}

// Reproject a layer's native extent to WGS84 (when possible) and bounds-check.
async function resolveBounds(
  extent: any,
  layerUrl: string,
): Promise<{
  wkid: number;
  extentWgs84: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
  inBounds: boolean | 'unverified';
}> {
  const sr = extent?.spatialReference ?? {};
  const wkid: number = sr.latestWkid ?? sr.wkid ?? 0;
  const hasExtent =
    extent &&
    Number.isFinite(extent.xmin) &&
    Number.isFinite(extent.ymin) &&
    Number.isFinite(extent.xmax) &&
    Number.isFinite(extent.ymax);

  if (wkid === 4326 && hasExtent) {
    const box = { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax };
    return { wkid, extentWgs84: box, inBounds: overlapsBbox(box) };
  }

  if ((wkid === 3857 || wkid === 102100) && hasExtent) {
    const [xmin, ymin] = webMercatorToWgs84(extent.xmin, extent.ymin);
    const [xmax, ymax] = webMercatorToWgs84(extent.xmax, extent.ymax);
    const box = { xmin, ymin, xmax, ymax };
    return { wkid, extentWgs84: box, inBounds: overlapsBbox(box) };
  }

  // CO state plane (2231/2232) or anything else: don't reproject inline — sample.
  const sampled = await sampleFeatureInBounds(layerUrl);
  return { wkid, extentWgs84: sampled.extent, inBounds: sampled.result };
}

// Introspect one collected URL into one or more LayerRecords.
async function introspectUrl(app: App, collected: CollectedUrl): Promise<LayerRecord[]> {
  const { url, webmapId } = collected;
  const base = cleanUrl(url);

  // Build the record skeleton from a layer-metadata blob + the layer URL.
  const buildRecord = async (meta: any, layerUrl: string): Promise<LayerRecord> => {
    const name: string = meta?.name ?? '(unnamed)';
    const bounds = await resolveBounds(meta?.extent, layerUrl);
    const fields: string[] = Array.isArray(meta?.fields)
      ? meta.fields.map((f: any) => f?.name).filter((n: any) => typeof n === 'string')
      : [];
    return {
      app_slug: app.slug,
      app_id: app.appId,
      app_type: app.appType,
      source_webmap_id: webmapId,
      layer_name: name,
      layer_url: layerUrl,
      geometry_type: meta?.geometryType ?? '',
      wkid: bounds.wkid,
      extent_wgs84: bounds.extentWgs84,
      in_bounds: bounds.inBounds,
      copyright: meta?.copyrightText ?? null,
      field_names: fields,
      zoning_keyword_match: ZONING_RX.test(name),
      error: null,
    };
  };

  if (isServiceRoot(url)) {
    const data = await fetchJson(`${base}/layers?f=json`);
    const layers: any[] = Array.isArray(data?.layers) ? data.layers : [];
    if (layers.length === 0) {
      throw new Error('service root returned no layers[]');
    }
    const records: LayerRecord[] = [];
    for (const layer of layers) {
      const layerUrl = `${base}/${layer.id}`;
      try {
        records.push(await buildRecord(layer, layerUrl));
      } catch (err) {
        records.push(errorRecord(app, webmapId, layerUrl, (err as Error).message));
      }
    }
    return records;
  }

  if (isSpecificLayer(url)) {
    const meta = await fetchJson(`${base}?f=json`);
    return [await buildRecord(meta, base)];
  }

  throw new Error(`unrecognized service URL shape: ${url}`);
}

function errorRecord(
  app: App,
  webmapId: string | null,
  layerUrl: string,
  message: string,
): LayerRecord {
  return {
    app_slug: app.slug,
    app_id: app.appId,
    app_type: app.appType,
    source_webmap_id: webmapId,
    layer_name: '',
    layer_url: layerUrl,
    geometry_type: '',
    wkid: 0,
    extent_wgs84: null,
    in_bounds: 'unverified',
    copyright: null,
    field_names: [],
    zoning_keyword_match: false,
    error: message,
  };
}

// ---------- Phase 1: app → collected service URLs ----------

async function collectUrlsForApp(app: App): Promise<CollectedUrl[]> {
  const appData = await fetchItemData(app.appId);
  const collected: CollectedUrl[] = [];
  const seen = new Set<string>();
  const add = (url: string, webmapId: string | null) => {
    const key = `${webmapId ?? ''}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({ url, webmapId });
  };

  const addWebmap = async (webmapId: string) => {
    try {
      const wmData = await fetchItemData(webmapId);
      for (const u of urlsFromWebmap(wmData)) add(u, webmapId);
    } catch (err) {
      process.stderr.write(`  webmap ${webmapId} data failed: ${(err as Error).message}\n`);
    }
  };

  if (app.appType === 'instant' || app.appType === 'configurable') {
    const webmapId: string | undefined =
      appData?.webmap ?? appData?.map ?? appData?.values?.webmap ?? appData?.values?.mapId ?? undefined;
    if (!webmapId) throw new Error('no webmap/map field in app data');
    await addWebmap(webmapId);
    return collected;
  }

  if (app.appType === 'experience') {
    const dataSources = appData?.dataSources;
    if (!dataSources || typeof dataSources !== 'object') {
      throw new Error('no dataSources object in Experience Builder app data');
    }
    for (const ds of Object.values<any>(dataSources)) {
      if (!ds || typeof ds !== 'object') continue;
      if (typeof ds.itemId === 'string' && ds.itemId) {
        await addWebmap(ds.itemId);
      }
      if (typeof ds.url === 'string' && ds.url) {
        add(ds.url, null);
      }
      if (typeof ds.layer?.url === 'string' && ds.layer.url) {
        add(ds.layer.url, null);
      }
    }
    return collected;
  }

  throw new Error(`unknown app type: ${app.appType}`);
}

// ---------- per-app orchestration ----------

async function resolveApp(app: App): Promise<LayerRecord[]> {
  process.stderr.write(`\n─── ${app.slug} (${app.appType}, ${app.appId}) ───\n`);
  try {
    const urls = await collectUrlsForApp(app);
    process.stderr.write(`  collected ${urls.length} service/layer URL(s)\n`);
    if (urls.length === 0) {
      return [errorRecord(app, null, '', 'no service URLs collected from app')];
    }
    const records: LayerRecord[] = [];
    for (const c of urls) {
      try {
        const recs = await introspectUrl(app, c);
        records.push(...recs);
      } catch (err) {
        process.stderr.write(`  layer introspection failed (${c.url}): ${(err as Error).message}\n`);
        records.push(errorRecord(app, c.webmapId, c.url, (err as Error).message));
      }
    }
    return records;
  } catch (err) {
    process.stderr.write(`  app FAILED: ${(err as Error).message}\n`);
    return [errorRecord(app, null, '', (err as Error).message)];
  }
}

// ---------- main ----------

async function main() {
  process.stderr.write('Resolving EPC municipal zoning layers — Manitou, Monument, Fountain (discovery only)\n');

  const results: LayerRecord[] = [];
  for (const app of APPS) {
    const recs = await resolveApp(app);
    results.push(...recs);
  }

  const outDir = path.join('scripts', 'out');
  const outPath = path.join(outDir, 'zoning_layers.json');
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, JSON.stringify(results, null, 2) + '\n', 'utf8');
    process.stderr.write(`\nWrote ${results.length} record(s) to ${outPath}\n`);
  } catch (err) {
    process.stderr.write(`\nfailed to write ${outPath}: ${(err as Error).message}\n`);
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

  // ---- stderr summary ----
  const byApp: Record<string, number> = {};
  let inBounds = 0;
  let outOfBounds = 0;
  let unverified = 0;
  let withErrors = 0;
  const outOfBoundsUrls: string[] = [];
  for (const r of results) {
    byApp[r.app_slug] = (byApp[r.app_slug] ?? 0) + 1;
    if (r.error) withErrors++;
    if (r.in_bounds === true) inBounds++;
    else if (r.in_bounds === false) { outOfBounds++; outOfBoundsUrls.push(r.layer_url); }
    else unverified++;
  }

  process.stderr.write('\n═══ Summary ═══\n');
  process.stderr.write(`  total layers:   ${results.length}\n`);
  for (const app of APPS) {
    process.stderr.write(`    ${app.slug.padEnd(16)} ${byApp[app.slug] ?? 0}\n`);
  }
  process.stderr.write(`  in-bounds:      ${inBounds}\n`);
  process.stderr.write(`  out-of-bounds:  ${outOfBounds}\n`);
  process.stderr.write(`  unverified:     ${unverified}\n`);
  process.stderr.write(`  with errors:    ${withErrors}\n`);

  if (outOfBoundsUrls.length > 0) {
    process.stderr.write('\n');
    for (const url of outOfBoundsUrls) {
      process.stderr.write(`⚠  OUT-OF-BOUNDS LAYER: ${url}\n`);
    }
  }
}

main().catch((err) => {
  // Defensive: main is built not to throw, but never crash without a trace.
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.stdout.write('[]\n');
});
