// lookup-parcel: APN -> parcel. Checks local DB; on miss, fetches Colorado Public
// Parcels (ArcGIS), validates it's in our service area (El Paso County), upserts
// via upsert_parcel RPC, returns the parcel id.
// Mirrors scripts/seed_parcels.ts fetch path for a single APN. Service-role only.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CO_PARCELS_QUERY =
  'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0/query'

// Service area: El Paso County, CO (the pilot). FIPS 041.
// Parcels outside this are rejected as not-found — the dataset includes
// statewide rows (and placeholder/template rows in other counties).
const SERVICE_AREA_FIPS = '041'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const { apn } = await req.json().catch(() => ({ apn: null }))
    if (!apn || typeof apn !== 'string' || apn.trim() === '') {
      return json({ error: 'apn required' }, 400)
    }
    const cleanApn = apn.trim()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    // 1. Local hit?
    const { data: existing, error: selErr } = await supabase
      .from('parcels').select('id').eq('source_apn', cleanApn).maybeSingle()
    if (selErr) return json({ error: `db: ${selErr.message}` }, 500)
    if (existing) return json({ found: true, parcelId: existing.id, cached: true })

    // 2. Fetch from Colorado Public Parcels (geojson, EPSG:4326).
    const where = `parcel_id IN ('${cleanApn.replace(/'/g, "''")}')`
    const url = `${CO_PARCELS_QUERY}?${new URLSearchParams({
      where, outFields: '*', f: 'geojson', outSR: '4326',
    })}`
    const res = await fetch(url)
    if (!res.ok) return json({ error: `arcgis ${res.status}` }, 502)
    const fc = await res.json()
    const feature = fc?.features?.[0]
    if (!feature) return json({ found: false })

    const props = feature.properties ?? {}

    // 2a. Service-area guard: only persist parcels in El Paso County (the pilot).
    // The statewide dataset includes other counties and placeholder/template rows
    // (e.g. APN 9999999999 = a Pueblo County "TEMPLATE PARCEL"). Reject those as
    // out-of-area so we never persist a parcel we don't model.
    const fips = String(props.countyFips ?? '').trim()
    if (fips !== SERVICE_AREA_FIPS) {
      return json({ found: false, reason: 'out_of_area', county: props.countyName ?? null })
    }

    // 3. Upsert via existing RPC (returns the new parcel uuid).
    const { data: newId, error: rpcErr } = await supabase.rpc('upsert_parcel', {
      _source_apn: cleanApn,
      _source_system: 'co_public_parcels',
      _geojson: feature.geometry,
      _raw_attrs: props,
      _retrieved_at: new Date().toISOString(),
      _source_url: url,
    })
    if (rpcErr) return json({ error: `upsert: ${rpcErr.message}` }, 500)

    return json({ found: true, parcelId: newId, cached: false })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
