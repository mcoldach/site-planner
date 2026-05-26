
- **Open question (zoning):** Zoning is compound — base zone + overlays/conditions (assessor example: `BP/CR CU HS SS` = base BP plus overlays). Phase 0 models base zone only; overlay handling is a deferred schema question for Phase 1+. Surfaced 2026-05-22 when CS parcel 6307405009 came back with a stacked zoning string.

## Known limitation: EPC parcel sourcing — statewide coverage gap (logged 2026-05-26, not yet built)

**The bug:** The statewide CO Public Parcels layer (`gis.colorado.gov/.../Colorado_Public_Parcels/FeatureServer/0`) has confirmed coverage gaps for El Paso County. Real parcel `4307000004` (verified present in the county's own GIS) returns `features:[]` from statewide → `lookup-parcel` correctly returns `{found:false}`. This disproves the `parcel_source=null` ("statewide is authoritative for EPC-unincorporated") assumption — statewide is *incomplete* for EPC.

**Authoritative EPC geometry source (confirmed covers 4307000004):**
`https://gisservices.elpasoco.com/arcgis2/rest/services/HubPublic/Parcels/MapServer` — layer 0, MapServer (supports /query), APN field `PARCEL`, serves `outSR=4326`&`f=geojson`. Same host/pattern as CS LandRecords.
**CRITICAL LIMITATION: geometry + APN ONLY.** Fields: PARCEL, HYPERLINK, InPoly_FID, MaxSimpTol, MinSimpTol, Shape. NO zoning, situs, owner, acreage, or legal. (Statewide *did* provide zoningCode/situsAdd — this layer does not.) EPC zoning/attributes live in a SEPARATE service — NOT YET FOUND (next discovery step: assessor/zoning layer, likely under gisservices.elpasoco.com or assessor.elpasoco.com).

**Fix (multi-step, jurisdiction-pack layer — build fresh, careful):**
1. Find the EPC zoning/attribute service (zoning code per parcel) — NOT YET DONE.
2. Add a fallback locator to `lookup-parcel`: when statewide Phase-1 returns empty, query the EPC geometry endpoint above as a secondary locator.
3. Join EPC zoning attrs (from #1) by APN onto the geometry.
4. Resolve jurisdiction from the EPC-sourced geometry (Phase-2 logic already exists).
**Architectural snag:** the function locates via statewide FIRST, then resolves jurisdiction. A statewide-miss never reaches jurisdiction resolution today — so a fallback locator (not just a parcel_source declaration) is required. This is why it's a real rework, not a one-line endpoint swap.

**Scope note:** bounded bug — statewide works for most EPC parcels (incl. all 4 seeded). Not a Phase-1 "done when" blocker. Fix deliberately when working the sourcing layer.

## Bookmark: EPC road centerlines (for future directional-setback engine)
DPW AGOL org `services3.arcgis.com/6Y56Ohy0RCFlntCT/ArcGIS/rest/services` has `EPC_Road_Centerlines_DSP` / `SegmentedCenterline_*` — the road/frontage geometry the directional-setback engine will need (front/side/rear edge classification, corner-parcel detection).
