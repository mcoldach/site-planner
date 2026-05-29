// scripts/resolve_monument_storymap.ts (v2)
//
// Monument's StoryMap stores 28 nodes + 20 resources. The 8 harvested UUIDs
// resolve to 0 Web Maps, so the maps live behind a different item type
// (Web Mapping Application, Web Scene) or are inlined as Express Maps.
//
// This v2 prints everything: each node's type, each resource's type, and
// every UUID's resolved item type. For any map-bearing item we walk its
// operational layers with the same Tempe guard.
//
// Run: pnpm tsx scripts/resolve_monument_storymap.ts

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

const COLLECTION_ID = '9f5678ccd690477cad10662f6df65abb';
const EPC_BBOX = { minLon: -105.2, maxLon: -103.8, minLat: 38.4, maxLat: 39.3 };
const AGOL_ITEM = 'https://www.arcgis.com/sharing/rest/content/items';
const ZONING_RX = /zon|land\s*use|district|udc|ldc/i;
const UUID_RX = /^[0-9a-f]{32}$/i;

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const data = await r.json();
  if (data?.error) throw new Error(`AGOL ${data.error.code}: ${data.error.message}`);
  return data;
}
const fetchItem     = (id: string) => fetchJson(`${AGOL_ITEM}/${id}?f=json`);
const fetchItemData = (id: string) => fetchJson(`${AGOL_ITEM}/${id}/data?f=json`);

function harvestUuids(obj: any, acc = new Set<string>()): Set<string> {
  if (obj == null) return acc;
  if (typeof obj === 'string') { if (UUID_RX.test(obj)) acc.add(obj); return acc; }
  if (Array.isArray(obj)) { for (const v of obj) harvestUuids(v, acc); return acc; }
  if (typeof obj === 'object') { for (const v of Object.values(obj)) harvestUuids(v, acc); }
  return acc;
}

function harvestOperationalLayers(obj: any, acc: any[] = []): any[] {
  if (obj == null || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) { for (const v of obj) harvestOperationalLayers(v, acc); return acc; }
  if (Array.isArray(obj.operationalLayers)) {
    for (const layer of obj.operationalLayers) {
      acc.push(layer);
      harvestOperationalLayers(layer, acc);
    }
  }
  for (const v of Object.values(obj)) if (typeof v === 'object') harvestOperationalLayers(v, acc);
  return acc;
}

function isInEPCBbox(lon: number, lat: number) {
  return lon >= EPC_BBOX.minLon && lon <= EPC_BBOX.maxLon
      && lat >= EPC_BBOX.minLat && lat <= EPC_BBOX.maxLat;
}

async function tempeGuardLayer(layerUrl: string) {
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
    if (!feat?.geometry) return { ok: false, sample: null as [number, number] | null, note: 'no features' };
    const g = feat.geometry;
    let c: [number, number] | null = null;
    if (g.type === 'Point')             c = g.coordinates;
    else if (g.type === 'Polygon')      c = g.coordinates[0]?.[0];
    else if (g.type === 'MultiPolygon') c = g.coordinates[0]?.[0]?.[0];
    else if (g.type === 'LineString')   c = g.coordinates[0];
    if (!c) return { ok: false, sample: null, note: `unsupported geom ${g.type}` };
    return { ok: isInEPCBbox(c[0], c[1]), sample: c, note: '' };
  } catch (err) {
    return { ok: false, sample: null, note: `query failed: ${(err as Error).message}` };
  }
}

async function exploreMapItem(uuid: string, kind: string) {
  console.log(`  ─── ${kind} ${uuid} ───`);
  let data: any;
  try { data = await fetchItemData(uuid); }
  catch (err) { console.log(`    data fetch FAILED: ${(err as Error).message}`); return; }

  // For Web Maps + Web Scenes: operationalLayers live inside data
  let layers = harvestOperationalLayers(data).filter((l: any) => l?.url);

  // For Web Mapping Applications: walk the inner webmap referenced by data.map.itemId
  if (layers.length === 0) {
    const innerWebmaps = new Set<string>();
    function findWebmapRefs(obj: any) {
      if (obj == null || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (const v of obj) findWebmapRefs(v); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && UUID_RX.test(v) && /(?:itemid|webmap|mapid)/i.test(k)) {
          innerWebmaps.add(v);
        }
        if (typeof v === 'object') findWebmapRefs(v);
      }
    }
    findWebmapRefs(data);
    for (const innerId of innerWebmaps) {
      try {
        const meta = await fetchItem(innerId);
        console.log(`    inner ref ${innerId}: ${meta.type} — "${meta.title}"`);
        if (['Web Map', 'Web Scene'].includes(meta.type)) {
          const innerData = await fetchItemData(innerId);
          layers = layers.concat(harvestOperationalLayers(innerData).filter((l: any) => l?.url));
        }
      } catch (err) {
        console.log(`    inner ref ${innerId}: resolve FAILED: ${(err as Error).message}`);
      }
    }
  }

  if (layers.length === 0) {
    console.log(`    no operationalLayers with URLs found`);
    return;
  }
  console.log(`    ${layers.length} layer(s) with URLs:`);
  for (const layer of layers) {
    const title = layer.title ?? layer.name ?? layer.layerDefinition?.name ?? '(untitled)';
    const blob  = `${title} ${layer.layerDefinition?.name ?? ''}`;
    const zoning = ZONING_RX.test(blob);
    const guard  = await tempeGuardLayer(layer.url);
    const z = zoning ? '✓ zoning kw' : '  no kw    ';
    const p = guard.ok ? '✓ EPC' : '✗ EPC';
    console.log(`      ${z}  ${p}  sample (${guard.sample ? `${guard.sample[0].toFixed(4)}, ${guard.sample[1].toFixed(4)}` : 'n/a'})`);
    console.log(`        title: "${title}"`);
    console.log(`        url:   ${layer.url}`);
    if (guard.note) console.log(`        note:  ${guard.note}`);
  }
}

async function main() {
  console.log(`Fetching StoryMap ${COLLECTION_ID}\n`);
  const data = await fetchItemData(COLLECTION_ID);

  // 1. Node type summary
  console.log('─── nodes (28 expected) ───');
  const nodes = data.nodes ?? {};
  const nodeTypeCounts: Record<string, number> = {};
  for (const [key, node] of Object.entries<any>(nodes)) {
    const t = node?.type ?? '(no type)';
    nodeTypeCounts[t] = (nodeTypeCounts[t] ?? 0) + 1;
  }
  for (const [t, n] of Object.entries(nodeTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(3)}  ${t}`);
  }

  // 2. Print every node that references an itemId or a resource
  console.log('\n─── nodes referencing items/resources ───');
  for (const [key, node] of Object.entries<any>(nodes)) {
    const ref = node?.data?.itemId ?? node?.data?.resourceId ?? node?.data?.map?.itemId;
    if (ref) console.log(`  ${key}  type=${node.type}  →  ${ref}  ${node?.data?.title ? '"' + node.data.title + '"' : ''}`);
  }

  // 3. Resource type summary
  console.log('\n─── resources (20 expected) ───');
  const resources = data.resources ?? {};
  for (const [key, res] of Object.entries<any>(resources)) {
    const t = res?.type ?? '(no type)';
    const itemId = res?.data?.itemId ?? res?.data?.map?.itemId;
    console.log(`  ${key}  type=${t}${itemId ? '  →  ' + itemId : ''}`);
  }

  // 4. Resolve every harvested UUID — DON'T FILTER BY TYPE
  console.log('\n─── all harvested UUIDs (every type) ───');
  const allUuids = harvestUuids(data);
  allUuids.delete(COLLECTION_ID);
  const mapBearing: Array<{ id: string; type: string; title: string }> = [];
  for (const uuid of allUuids) {
    try {
      const meta = await fetchItem(uuid);
      console.log(`  ${uuid}  ${meta.type.padEnd(28)} "${meta.title}"`);
      if (['Web Map', 'Web Scene', 'Web Mapping Application'].includes(meta.type)) {
        mapBearing.push({ id: uuid, type: meta.type, title: meta.title });
      }
    } catch (err) {
      console.log(`  ${uuid}  RESOLVE FAILED: ${(err as Error).message}`);
    }
  }

  // 5. For each map-bearing item, explore
  if (mapBearing.length === 0) {
    console.log('\n  no map-bearing items found among harvested UUIDs');
    return;
  }
  console.log(`\n─── exploring ${mapBearing.length} map-bearing item(s) ───`);
  for (const m of mapBearing) {
    await exploreMapItem(m.id, `${m.type} "${m.title}"`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
