// lookup-parcel: two-phase, jurisdiction-owned parcel sourcing.
//   Phase 1 (locate): query the statewide layer for geometry + base attrs.
//   Phase 2 (authoritative): resolve jurisdiction from geometry; if it declares a
//     parcel_source, re-fetch the authoritative record and normalize via field_map.
//     If none declared (or re-fetch empty), use the statewide record.
// Service-area guard (El Paso County FIPS 041) still applies at Phase 1.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CO_PARCELS_QUERY =
  'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0/query'
const SERVICE_AREA_FIPS = '041'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Re-fetch a parcel from a jurisdiction's authoritative source and map its fields
// into our canonical raw_attrs shape (parcel_id, situsAdd, zoningCode, ...).
// Returns { geometry, props } or null if not found / on error.
async function fetchAuthoritative(
  apn: string,
  source: { endpoint: string; apn_field: string; field_map: Record<string, string> },
): Promise<{ geometry: unknown; props: Record<string, unknown> } | null> {
  const where = `${source.apn_field} = '${apn.replace(/'/g, "''")}'`
  const url = `${source.endpoint}?${new URLSearchParams({
    where, outFields: '*', f: 'geojson', outSR: '4326',
  })}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch {
    return null
  }
  if (!res.ok) return null
  const fc = await res.json().catch(() => null)
  const feature = fc?.features?.[0]
  if (!feature) return null

  // Normalize: map each source field -> canonical key.
  const raw = feature.properties ?? {}
  const props: Record<string, unknown> = {}
  for (const [canonical, sourceField] of Object.entries(source.field_map)) {
    props[canonical] = raw[sourceField] ?? null
  }
  // Preserve the original source attrs too, namespaced, for provenance.
  props.__authoritative_source = source.endpoint
  return { geometry: feature.geometry, props }
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

    // 0. Local hit?
    const { data: existing, error: selErr } = await supabase
      .from('parcels').select('id, raw_attrs, source_system').eq('source_apn', cleanApn).maybeSingle()
    if (selErr) return json({ error: `db: ${selErr.message}` }, 500)
    if (existing && existing.raw_attrs?.zoningCode) {
      return json({ found: true, parcelId: existing.id, cached: true })
    }

    // 1. PHASE 1 — Locate via statewide layer.
    const where = `parcel_id IN ('${cleanApn.replace(/'/g, "''")}')`
    const locUrl = `${CO_PARCELS_QUERY}?${new URLSearchParams({
      where, outFields: '*', f: 'geojson', outSR: '4326',
    })}`
    const locRes = await fetch(locUrl, { signal: AbortSignal.timeout(10_000) })
    if (!locRes.ok) return json({ error: `arcgis ${locRes.status}` }, 502)
    const locFc = await locRes.json()
    const locFeature = locFc?.features?.[0]
    if (!locFeature) {
      // Fallback: statewide layer missed — try authoritative sources directly.
      const { data: sources, error: srcErr } = await supabase
        .from('jurisdictions')
        .select('id, slug, parcel_source')
        .not('parcel_source', 'is', null)
      if (srcErr || !sources?.length) return json({ found: false })

      const results = await Promise.all(
        sources.map(async (j) => {
          const auth = await fetchAuthoritative(cleanApn, j.parcel_source)
          return auth ? { jurisdiction: j, ...auth } : null
        }),
      )
      const hit = results.find((r) => r !== null)
      if (!hit) return json({ found: false })

      const { data: newId, error: rpcErr } = await supabase.rpc('upsert_parcel', {
        _source_apn: cleanApn,
        _source_system: existing?.source_system ?? 'cos_landrecords',
        _geojson: hit.geometry,
        _raw_attrs: hit.props,
        _retrieved_at: new Date().toISOString(),
        _source_url: hit.jurisdiction.parcel_source.endpoint,
      })
      if (rpcErr) return json({ error: `upsert: ${rpcErr.message}` }, 500)

      return json({
        found: true,
        parcelId: newId,
        cached: false,
        jurisdiction: hit.jurisdiction.slug,
        authoritative: true,
        fallback: true,
      })
    }

    const locProps = locFeature.properties ?? {}

    // 1a. Service-area guard.
    if (String(locProps.countyFips ?? '').trim() !== SERVICE_AREA_FIPS) {
      return json({ found: false, reason: 'out_of_area', county: locProps.countyName ?? null })
    }

    // 2. PHASE 2 — Resolve jurisdiction from located geometry.
    const { data: juris, error: jErr } = await supabase.rpc(
      'resolve_jurisdiction_for_geometry', { _geojson: locFeature.geometry },
    )
    if (jErr) return json({ error: `resolve: ${jErr.message}` }, 500)

    // Default: use the statewide-located record.
    let geometry = locFeature.geometry
    let props: Record<string, unknown> = locProps
    let authoritativeSource: string | null = null

    // If the jurisdiction declares a parcel_source, re-fetch authoritatively.
    const source = juris?.parcel_source
    if (source && source.endpoint) {
      const auth = await fetchAuthoritative(cleanApn, source)
      if (auth) {
        geometry = auth.geometry
        props = auth.props
        authoritativeSource = source.endpoint
      }
      // else: re-fetch empty/failed -> fall back to statewide record (already set).
    }

    // 3. Upsert the chosen record.
    const { data: newId, error: rpcErr } = await supabase.rpc('upsert_parcel', {
      _source_apn: cleanApn,
      _source_system: existing?.source_system ?? (authoritativeSource ? 'cos_landrecords' : 'co_public_parcels'),
      _geojson: geometry,
      _raw_attrs: props,
      _retrieved_at: new Date().toISOString(),
      _source_url: authoritativeSource ?? locUrl,
    })
    if (rpcErr) return json({ error: `upsert: ${rpcErr.message}` }, 500)

    return json({
      found: true,
      parcelId: newId,
      cached: false,
      jurisdiction: juris?.slug ?? null,
      authoritative: authoritativeSource !== null,
    })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
