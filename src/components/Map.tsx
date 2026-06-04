import { useEffect, useRef, type MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/bbox';
import type { FeatureCollection } from 'geojson';
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { fetchProjects } from '../lib/data';
import { getCssToken } from '../lib/css-tokens';
import type {
  DrawnFootprint,
  Parcel,
  Project,
  SchemeFootprint,
} from '../lib/types';

// Terra Draw uses string | number ids internally; we model the same shape
// locally instead of importing the type to avoid coupling to its public API.
type FeatureId = string | number;

const CO_SPRINGS_BBOX: [[number, number], [number, number]] = [
  [-104.95, 38.78],
  [-104.68, 38.92],
];

const OPENFREEMAP_POSITRON =
  'https://tiles.openfreemap.org/styles/positron';

function parcelsToFeatureCollection(parcels: Parcel[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: parcels.map((p) => ({
      type: 'Feature',
      id: p.id,
      properties: {
        id: p.id,
        source_apn: p.source_apn,
        label: p.label,
        zone_district_code: p.zone_district_code,
      },
      geometry: p.geometry,
    })),
  };
}

function parcelBounds(
  geojson: FeatureCollection,
  parcelId: string,
): [[number, number], [number, number]] | null {
  const feature = geojson.features.find(
    (f) => f.properties?.id === parcelId || f.id === parcelId,
  );
  if (!feature) return null;
  const [west, south, east, north] = bbox(feature);
  return [
    [west, south],
    [east, north],
  ];
}

function projectBounds(
  geojson: FeatureCollection,
  projectId: string,
): [[number, number], [number, number]] | null {
  const feature = geojson.features.find(
    (f) => f.properties?.id === projectId || f.id === projectId,
  );
  if (!feature) return null;
  const [west, south, east, north] = bbox(feature);
  return [
    [west, south],
    [east, north],
  ];
}

const PARCEL_LAYER_IDS = [
  'parcels-fill',
  'parcels-outline',
  'parcels-outline-selected',
] as const;

const PROJECT_LAYER_IDS = [
  'projects-fill',
  'projects-outline',
  'projects-dot',
  'projects-label',
] as const;

// Saved schemes ride along with projects: same mode-gating (Projects only)
// and the same minzoom threshold as projects-fill/-outline, so they appear
// once the user has zoomed into a project. They are SEPARATE from Terra
// Draw's draft layers (td-*) — the draft is the user's in-flight drawing;
// these are the persisted record.
const SAVED_SCHEME_LAYER_IDS = [
  'saved-scheme-fill',
  'saved-scheme-outline',
  'saved-scheme-selected',
] as const;

// Terra Draw's MapLibre adapter namespaces every layer/source it adds with
// this prefix (default 'td'). We hide them all when the app is in Parcels
// mode so a drawn footprint never bleeds across modes.
const TERRA_DRAW_LAYER_PREFIX = 'td-';

function setTerraDrawLayerVisibility(
  map: maplibregl.Map,
  visible: boolean,
): void {
  const style = map.getStyle();
  if (!style?.layers) return;
  const visibility = visible ? 'visible' : 'none';
  for (const layer of style.layers) {
    if (layer.id.startsWith(TERRA_DRAW_LAYER_PREFIX)) {
      map.setLayoutProperty(layer.id, 'visibility', visibility);
    }
  }
}

function projectsToFeatureCollections(projects: Project[]): {
  polygons: FeatureCollection;
  points: FeatureCollection;
} {
  return {
    polygons: {
      type: 'FeatureCollection',
      features: projects.map((p) => ({
        type: 'Feature',
        id: p.id,
        properties: { id: p.id, name: p.name, color: p.color },
        geometry: p.geometry,
      })),
    },
    points: {
      type: 'FeatureCollection',
      features: projects.map((p) => ({
        type: 'Feature',
        id: p.id,
        properties: { id: p.id, name: p.name, color: p.color },
        geometry: p.centroid,
      })),
    },
  };
}

const EMPTY_FC: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

function savedSchemesToFeatureCollection(
  footprints: SchemeFootprint[] | null,
): FeatureCollection {
  if (!footprints || footprints.length === 0) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: footprints.map((f) => ({
      type: 'Feature',
      properties: { id: f.id },
      geometry: f.footprint,
    })),
  };
}

// Snapshot every polygon currently in Terra Draw and stamp it with its
// stable feature id. Called from both the finish handler (just-drawn) and
// the change handler (vertex edits, drags, deletes) so the parent always
// sees the COMPLETE current set — never a single feature taken in
// isolation.
function collectDrawnFootprints(draw: TerraDraw): DrawnFootprint[] {
  return draw
    .getSnapshot()
    .filter((f) => f.geometry.type === 'Polygon' && f.id !== undefined)
    .map((f) => ({
      id: f.id as FeatureId,
      geometry: f.geometry as GeoJSON.Polygon,
    }));
}

type MapProps = {
  parcels: Parcel[];
  mode: 'projects' | 'parcels';
  selectedParcelId: string | null;
  onParcelClick: (parcelId: string) => void;
  onProjectClick: (projectId: string) => void;
  refreshProjectsToken: number;
  drawMode: boolean;
  // Imperative arm signal: a monotonic counter the parent bumps to ask
  // Terra Draw to (re-)enter polygon mode. Required because the finish
  // handler drops the instance into 'select' after each pad and the
  // mode/drawMode effect only fires on state changes — so toggling
  // drawMode false→true is the only way to re-arm via state, which the
  // "Draw another" UX explicitly avoids.
  drawArmToken: number;
  // Emitted on every change to the Terra Draw store (finish, vertex edit,
  // feature delete). Always carries the COMPLETE current set of drawn
  // polygons — the parent is expected to replace, not merge.
  onFootprintsChanged: (footprints: DrawnFootprint[]) => void;
  savedSchemeFootprints: SchemeFootprint[] | null;
  // SEED polygons for an edit session. When non-null, Map injects every
  // polygon into Terra Draw, drops into select mode, and (if there's a
  // single polygon) auto-selects it so the drag/rotate/vertex handles
  // appear without a click. The app sets this once at edit start and
  // again to null at edit end; it never pushes back into Terra Draw
  // mid-session. The parent must hide the matching saved-scheme static
  // layer during editing to avoid doubling.
  editingSeed: GeoJSON.Polygon[] | null;
  // Imperative "select this footprint on the map" signal. The parent
  // bumps `selectFootprintToken` to ask Map to switch Terra Draw into
  // select mode and pick the feature whose id is `selectFootprintId` (the
  // id captured at the moment of the token bump). Token-based rather than
  // state-based so re-selecting the same id fires the effect again.
  selectFootprintToken: number;
  selectFootprintId: string | number | null;
  // The CURRENTLY-selected footprint id, written by Map's own
  // select/deselect listeners via onSelectedFootprintIdChanged and
  // round-tripped back through App. Distinct from selectFootprintId,
  // which is the COMMAND ("act on this id at the next token bump").
  // This prop is what the saved-scheme-selected MapLibre filter
  // reads from.
  selectedFootprintId: string | number | null;
  // Saved-scheme multi-select. The 'saved-scheme-selected' layer's
  // MapLibre filter reads this. Separate from selectedFootprintId
  // (which is single-id, edit-mode Terra Draw selection).
  selectedSavedFootprintIds: Set<string | number>;
  // Saved-scheme map click toggles an id in App's set. Separate from
  // onSelectedFootprintIdChanged (edit-mode single-id callback).
  onToggleSavedFootprintId: (id: string | number) => void;
  onClearSavedFootprints: () => void;
  // Imperative "remove this footprint" signal. Same token pattern: the
  // parent bumps `removeFootprintToken` to ask Map to deselect (if needed)
  // and removeFeatures the polygon whose id is `removeFootprintId`. Map
  // then re-emits the resulting drawn set via onFootprintsChanged so the
  // workspace's metaById reconciliation drops the deleted row.
  removeFootprintToken: number;
  removeFootprintId: string | number | null;
  // Map → App: Terra Draw's select/deselect events as the source of
  // truth for "which polygon is currently selected". Reports null on
  // deselect; reports the Terra Draw feature id on select.
  onSelectedFootprintIdChanged: (id: string | number | null) => void;
};

export function Map({
  parcels,
  mode,
  selectedParcelId,
  onParcelClick,
  onProjectClick,
  refreshProjectsToken,
  drawMode,
  drawArmToken,
  onFootprintsChanged,
  savedSchemeFootprints,
  editingSeed,
  selectFootprintToken,
  selectFootprintId,
  // The single-id selectedFootprintId prop is preserved on the contract
  // (App still passes it; the type still documents it) so the edit-mode
  // wiring in App and ProjectWorkspace stays unchanged. Inside Map it's
  // currently unused: saved-scheme highlighting now reads from
  // selectedSavedFootprintIds, and Terra Draw's own select/deselect
  // events drive edit-mode highlighting via onSelectedFootprintIdChanged.
  // Underscore-prefixed per the eslint convention for intentionally-
  // unused destructured names.
  selectedFootprintId: _selectedFootprintId,
  selectedSavedFootprintIds,
  onToggleSavedFootprintId,
  onClearSavedFootprints,
  removeFootprintToken,
  removeFootprintId,
  onSelectedFootprintIdChanged,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const parcelsRef = useRef(parcels);
  parcelsRef.current = parcels;
  const parcelsGeojsonRef = useRef<FeatureCollection | null>(null);
  const parcelsBoundsRef = useRef<[[number, number], [number, number]] | null>(
    null,
  );
  const projectsPolyRef = useRef<FeatureCollection | null>(null);
  const projectsPtsRef = useRef<FeatureCollection | null>(null);
  const layersReadyRef = useRef(false);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onParcelClickRef = useRef(onParcelClick);
  onParcelClickRef.current = onParcelClick;
  const onProjectClickRef = useRef(onProjectClick);
  onProjectClickRef.current = onProjectClick;
  const selectedParcelIdRef = useRef(selectedParcelId);
  selectedParcelIdRef.current = selectedParcelId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const drawRef = useRef<TerraDraw | null>(null);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const drawArmTokenRef = useRef(drawArmToken);
  drawArmTokenRef.current = drawArmToken;
  const onFootprintsChangedRef = useRef(onFootprintsChanged);
  onFootprintsChangedRef.current = onFootprintsChanged;
  const onSelectedFootprintIdChangedRef = useRef(onSelectedFootprintIdChanged);
  onSelectedFootprintIdChangedRef.current = onSelectedFootprintIdChanged;
  const onToggleSavedFootprintIdRef = useRef(onToggleSavedFootprintId);
  onToggleSavedFootprintIdRef.current = onToggleSavedFootprintId;
  const onClearSavedFootprintsRef = useRef(onClearSavedFootprints);
  onClearSavedFootprintsRef.current = onClearSavedFootprints;
  const selectedSavedFootprintIdsRef = useRef(selectedSavedFootprintIds);
  selectedSavedFootprintIdsRef.current = selectedSavedFootprintIds;
  // The select/remove effects are keyed only on their token props (so the
  // SAME id can fire again on a fresh token). The companion id props are
  // therefore read inside the effect from a latest-value ref rather than
  // pulled in as a dep — otherwise an id change between bumps would re-fire
  // the effect with no token bump, which is the wrong semantics.
  const selectFootprintIdRef = useRef<string | number | null>(
    selectFootprintId,
  );
  selectFootprintIdRef.current = selectFootprintId;
  const removeFootprintIdRef = useRef<string | number | null>(
    removeFootprintId,
  );
  removeFootprintIdRef.current = removeFootprintId;
  // The set of feature ids Terra Draw assigned to the polygons currently
  // loaded for editing. Tracked separately so we can scope removeFeatures()
  // to just the editing set on edit-end and not nuke unrelated draft
  // features (there shouldn't be any in V1, but the scoping is correct).
  const editingFeatureIdsRef = useRef<Set<FeatureId>>(new Set());
  // The id of the just-drawn polygon the finish handler auto-selected in
  // the new-scheme flow. Tracked so we can deselect it on the transition
  // to 'static' — Terra Draw exposes deselectFeature(id) but its snapshot
  // doesn't surface selection state, so the caller must remember the id.
  // Editing-path selections are handled separately via editingFeatureIdsRef
  // and intentionally NOT recorded here.
  const selectedDrawIdRef = useRef<FeatureId | null>(null);
  // Mirrors Terra Draw's current selection (whatever feature is selected
  // by mode = 'select'). Updated synchronously by the 'select' and
  // 'deselect' listeners registered in onLoad — those listeners are the
  // canonical source of truth per Terra Draw's API contract. Used by the
  // selectFootprintToken effect to support panel-driven deselect: when
  // the panel passes a null id, we deselect whatever this ref carries.
  // Distinct from selectedDrawIdRef (which tracks just-drawn-pad selection
  // for the lingering-highlight teardown in the new-scheme draw flow) —
  // overlapping concerns, deliberately separate so each effect's
  // teardown logic stays explicit.
  const currentMapSelectionRef = useRef<FeatureId | null>(null);
  // Latest-value mirror so the async onLoad closure can apply the initial
  // editing state if the seed was already set when Terra Draw was created.
  const editingSeedRef = useRef<GeoJSON.Polygon[] | null>(editingSeed);
  useEffect(() => {
    editingSeedRef.current = editingSeed;
  });
  // The saved-scheme source is created inside onLoad's async closure, which
  // doesn't see prop updates. Sync the ref via an effect (the canonical
  // "latest value" pattern) so the source.data reflects whatever the prop
  // is at the moment layers are first added — even if it changed between
  // mount and the async onLoad firing.
  const savedSchemeFootprintsRef = useRef<SchemeFootprint[] | null>(
    savedSchemeFootprints,
  );
  useEffect(() => {
    savedSchemeFootprintsRef.current = savedSchemeFootprints;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_POSITRON,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.getCanvas().tabIndex = -1;

    const accentWash = getCssToken('--color-accent-wash');
    const graphite = getCssToken('--color-graphite');
    const accent = getCssToken('--color-accent');

    let cancelled = false;

    const onLoad = () => {
      void (async () => {
        try {
          const geojson = parcelsToFeatureCollection(parcelsRef.current);
          parcelsGeojsonRef.current = geojson;

          map.addSource('parcels', {
            type: 'geojson',
            data: geojson,
          });

          map.addLayer({
            id: 'parcels-fill',
            type: 'fill',
            source: 'parcels',
            paint: {
              'fill-color': accentWash,
              'fill-opacity': 0,
            },
          });

          map.addLayer({
            id: 'parcels-outline',
            type: 'line',
            source: 'parcels',
            paint: {
              'line-color': graphite,
              'line-width': 1,
              'line-opacity': 0.85,
            },
          });

          map.addLayer({
            id: 'parcels-outline-selected',
            type: 'line',
            source: 'parcels',
            filter: ['literal', false],
            paint: {
              'line-color': accent,
              'line-width': 2,
              'line-opacity': 1,
            },
          });

          map.on('click', 'parcels-fill', (e) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === 'string') {
              onParcelClickRef.current(id);
            }
          });

          map.on('mouseenter', 'parcels-fill', () => {
            map.getCanvas().style.cursor = 'pointer';
          });

          map.on('mouseleave', 'parcels-fill', () => {
            map.getCanvas().style.cursor = '';
          });

          const projects = await fetchProjects();
          if (cancelled) return;

          const { polygons: projectsPoly, points: projectsPts } =
            projectsToFeatureCollections(projects);
          projectsPolyRef.current = projectsPoly;
          projectsPtsRef.current = projectsPts;

          map.addSource('projects-poly', {
            type: 'geojson',
            data: projectsPoly,
          });
          map.addSource('projects-pts', {
            type: 'geojson',
            data: projectsPts,
          });

          map.addLayer({
            id: 'projects-fill',
            type: 'fill',
            source: 'projects-poly',
            minzoom: 14,
            paint: {
              'fill-color': ['coalesce', ['get', 'color'], accentWash],
              'fill-opacity': 0.35,
            },
          });

          map.addLayer({
            id: 'projects-outline',
            type: 'line',
            source: 'projects-poly',
            minzoom: 14,
            paint: {
              'line-color': ['coalesce', ['get', 'color'], accent],
              'line-width': 2,
            },
          });

          map.addLayer({
            id: 'projects-dot',
            type: 'circle',
            source: 'projects-pts',
            maxzoom: 14,
            paint: {
              'circle-color': ['coalesce', ['get', 'color'], accent],
              'circle-radius': 6,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          });

          // Labels depend on the basemap style providing glyphs. OpenFreeMap
          // positron ships Noto Sans; if a future style swap drops glyphs the
          // symbol layer will silently fail to render — the dot still shows.
          map.addLayer({
            id: 'projects-label',
            type: 'symbol',
            source: 'projects-pts',
            maxzoom: 14,
            layout: {
              'text-field': ['get', 'name'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 12,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
            },
            paint: {
              'text-color': graphite,
            },
          });

          // Saved-scheme footprint. Source starts empty; the syncing effect
          // below fills it as savedSchemeFootprints changes. Same minzoom as
          // projects-fill/-outline so a saved building only shows once the
          // user has zoomed into the project — at far-out zooms the project
          // is just a dot/label, so a tiny floating polygon would be noise.
          map.addSource('saved-scheme', {
            type: 'geojson',
            data: savedSchemesToFeatureCollection(
              savedSchemeFootprintsRef.current,
            ),
          });

          map.addLayer({
            id: 'saved-scheme-fill',
            type: 'fill',
            source: 'saved-scheme',
            minzoom: 14,
            paint: {
              'fill-color': accentWash,
              'fill-opacity': 0.3,
            },
          });

          map.addLayer({
            id: 'saved-scheme-outline',
            type: 'line',
            source: 'saved-scheme',
            minzoom: 14,
            paint: {
              'line-color': accent,
              'line-width': 1.5,
              'line-opacity': 0.9,
            },
          });

          // Highlights whichever saved footprint is currently selected. Same
          // source as saved-scheme-fill/-outline; just a separate layer with
          // heavier styling and a filter keyed on selectedFootprintId. Saved
          // buildings don't go through Terra Draw (they're presentation, not
          // editable features), so this is the MapLibre-native path to "the
          // app says THIS one is selected." Initial filter is literal false
          // (matches nothing); the syncing effect below sets it to a real
          // expression when selectedFootprintId is non-null.
          map.addLayer({
            id: 'saved-scheme-selected',
            type: 'line',
            source: 'saved-scheme',
            minzoom: 14,
            filter: ['literal', false],
            paint: {
              'line-color': accent,
              'line-width': 3,
              'line-opacity': 1,
            },
          });

          const handleProjectClick = (id: string) => {
            // Always fit to the polygon bounds (even from the dot layer at low
            // zoom) so opening a workspace also gives spatial context.
            const polyGeojson = projectsPolyRef.current;
            if (polyGeojson) {
              const bounds = projectBounds(polyGeojson, id);
              if (bounds) {
                map.fitBounds(bounds, { padding: 80, duration: 800 });
              }
            }
            onProjectClickRef.current(id);
          };

          map.on('click', 'projects-fill', (e) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === 'string') {
              handleProjectClick(id);
            }
          });

          map.on('click', 'projects-dot', (e) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === 'string') {
              handleProjectClick(id);
            }
          });

          for (const layerId of ['projects-fill', 'projects-dot'] as const) {
            map.on('mouseenter', layerId, () => {
              map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', layerId, () => {
              map.getCanvas().style.cursor = '';
            });
          }

          // Saved-scheme map click toggles the id in App's set. e.preventDefault
          // is not needed (MapLibre doesn't bubble layer clicks to the map's
          // generic click handler), but the empty-background click handler below
          // stops if e.features is non-empty by virtue of MapLibre's hit-test
          // order — saved-scheme-fill is above the parcel/projects layers in
          // the addLayer order, so this handler runs first and the generic
          // map.on('click', ...) handler will fire afterward only if no saved-
          // scheme feature was hit. To prevent the generic handler from clearing
          // the set right after we just added to it, we set a sentinel on the
          // event's originalEvent.
          map.on('click', 'saved-scheme-fill', (e) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === 'string') {
              onToggleSavedFootprintIdRef.current(id);
              // Mark this DOM event so the generic background click handler
              // below knows not to clear (it would otherwise fire next).
              (e.originalEvent as MouseEvent & { _savedSchemeHit?: boolean })._savedSchemeHit = true;
            }
          });

          map.on('mouseenter', 'saved-scheme-fill', () => {
            map.getCanvas().style.cursor = 'pointer';
          });

          map.on('mouseleave', 'saved-scheme-fill', () => {
            map.getCanvas().style.cursor = '';
          });

          // Background click on the map clears saved-scheme selection. Only
          // fires if no saved-scheme feature was hit (the layer-scoped handler
          // above marks the event when it consumes a hit). Restricted to
          // projects mode so parcel-mode clicks aren't affected.
          map.on('click', (e) => {
            if (modeRef.current !== 'projects') return;
            const flag = (e.originalEvent as MouseEvent & { _savedSchemeHit?: boolean })._savedSchemeHit;
            if (flag) return;
            if (selectedSavedFootprintIdsRef.current.size === 0) return;
            onClearSavedFootprintsRef.current();
          });

          const initialParcelVisibility =
            modeRef.current === 'parcels' ? 'visible' : 'none';
          for (const layerId of PARCEL_LAYER_IDS) {
            map.setLayoutProperty(layerId, 'visibility', initialParcelVisibility);
          }
          const initialProjectVisibility =
            modeRef.current === 'projects' ? 'visible' : 'none';
          for (const layerId of PROJECT_LAYER_IDS) {
            map.setLayoutProperty(layerId, 'visibility', initialProjectVisibility);
          }
          // Saved-scheme layers ride along with PROJECT_LAYER_IDS visibility
          // (same mode-gating). minzoom on each layer handles the zoom rule.
          for (const layerId of SAVED_SCHEME_LAYER_IDS) {
            map.setLayoutProperty(layerId, 'visibility', initialProjectVisibility);
          }

          layersReadyRef.current = true;

          if (parcelsRef.current.length > 0) {
            const [west, south, east, north] = bbox(geojson);
            parcelsBoundsRef.current = [
              [west, south],
              [east, north],
            ];
            if (!selectedParcelIdRef.current) {
              map.fitBounds(parcelsBoundsRef.current, { padding: 50 });
            }
          } else {
            parcelsBoundsRef.current = null;
            if (!selectedParcelIdRef.current) {
              map.fitBounds(CO_SPRINGS_BBOX, { padding: 50 });
            }
          }

          if (selectedParcelIdRef.current) {
            applySelection(map, selectedParcelIdRef.current, {
              accentWash,
              graphite,
              accent,
              geojson,
              parcelsBounds: parcelsBoundsRef.current,
              pulseTimeoutRef,
            });
          }

          // Terra Draw is initialized AFTER all parcel/project layers have
          // been registered so its render layers land on top of them. The
          // adapter namespaces its own layer/source ids ('td-*'), so the
          // existing parcels-* / projects-* layers are untouched. The
          // instance is started in its default 'static' mode (no drawing);
          // the mode/drawMode effect below switches between polygon, select,
          // and static as the app state dictates.
          const draw = new TerraDraw({
            adapter: new TerraDrawMapLibreGLAdapter({ map }),
            modes: [
              new TerraDrawPolygonMode(),
              // Editing flags are scoped to polygon features only; this is
              // the only geometry type we draw in V1.
              new TerraDrawSelectMode({
                flags: {
                  polygon: {
                    feature: {
                      draggable: true,
                      rotateable: true,
                      coordinates: {
                        midpoints: true,
                        draggable: true,
                        deletable: true,
                        snappable: true,
                      },
                    },
                  },
                },
              }),
            ],
          });
          draw.start();
          drawRef.current = draw;

          // Terra Draw's select/deselect events ARE the source of truth for
          // "which footprint is currently selected": user click on the map,
          // programmatic selectFeature/deselectFeature, mode changes that
          // clear selection, and (future) keyboard nav all flow through
          // here. The parent uses this to drive the per-row highlight in
          // the workspace panel, so panel ↔ map selection stays in sync
          // without the workspace having to track selection itself.
          draw.on('select', ((id: FeatureId) => {
            currentMapSelectionRef.current = id;
            onSelectedFootprintIdChangedRef.current(id);
          }) as (id: FeatureId) => void);
          draw.on('deselect', ((_id: FeatureId) => {
            currentMapSelectionRef.current = null;
            onSelectedFootprintIdChangedRef.current(null);
          }) as (id: FeatureId) => void);

          // Hide td-* layers immediately if we booted in Parcels mode. No
          // layers exist yet (Terra Draw lazy-adds them on first render), so
          // this is a no-op today but stays correct if init order ever
          // changes.
          setTerraDrawLayerVisibility(map, modeRef.current === 'projects');

          // Sync the initial draw mode here because the mode/drawMode effect
          // that controls Terra Draw's mode ran before drawRef was populated
          // by this async load. Editing takes precedence over drawMode: if a
          // seed was already handed in at mount, load every polygon and
          // drop into select mode before the polygon-mode toggle gets a
          // chance.
          const initialEditing = editingSeedRef.current;
          if (
            modeRef.current === 'projects' &&
            initialEditing &&
            initialEditing.length > 0
          ) {
            const result = draw.addFeatures(
              initialEditing.map((g) => ({
                type: 'Feature' as const,
                properties: { mode: 'polygon' },
                geometry: g,
              })),
            );
            const ids = result
              .map((r) => r.id)
              .filter((x): x is FeatureId => x !== undefined);
            editingFeatureIdsRef.current = new Set(ids);
            draw.setMode('select');
            // Auto-select only when there's exactly one polygon to edit.
            // With multiple polygons the user needs to click to pick one,
            // otherwise we'd silently pin handles to whichever one we
            // happen to load first.
            if (ids.length === 1) {
              draw.selectFeature(ids[0]);
            }
            // Emit the seeded set so the parent learns Terra Draw's real
            // feature ids immediately, instead of carrying stale ids from
            // before the seed.
            onFootprintsChangedRef.current(collectDrawnFootprints(draw));
          } else if (modeRef.current === 'projects' && drawModeRef.current) {
            draw.setMode('polygon');
          }

          draw.on('finish', ((...args: unknown[]) => {
            const [id] = args as [FeatureId, unknown];
            const instance = drawRef.current;
            if (!instance) return;
            const finished = instance
              .getSnapshot()
              .find((f) => f.id === id);
            if (!finished || finished.geometry.type !== 'Polygon') return;

            // Emit the COMPLETE current set of drawn polygons — including
            // any prior finished features that came before this one. The
            // parent (and downstream save flow) owns the multi-footprint
            // shape; we never strip features here.
            onFootprintsChangedRef.current(collectDrawnFootprints(instance));

            // Hand the just-drawn polygon to select mode so the user can
            // rotate, drag, and edit vertices without an intermediate click.
            // selectFeature auto-uses the registered select mode.
            instance.setMode('select');
            instance.selectFeature(id);
            selectedDrawIdRef.current = id;
          }) as (id: FeatureId, context: unknown) => void);

          // Edits in select mode (drag whole feature, rotate, vertex drag,
          // midpoint insert, vertex delete) emit 'change' with type 'update'.
          // Polygon mode also emits 'change' as the user clicks vertices
          // during draw — those are gated out by checking the current mode.
          // We always emit the COMPLETE current set so the parent sees
          // additions, deletions, and per-feature edits through the same
          // pipe.
          draw.on('change', ((...args: unknown[]) => {
            const [, type] = args as [FeatureId[], string, unknown?];
            const instance = drawRef.current;
            if (!instance) return;
            if (type !== 'update') return;
            if (instance.getMode() !== 'select') return;
            onFootprintsChangedRef.current(collectDrawnFootprints(instance));
          }) as (ids: FeatureId[], type: string, context?: unknown) => void);
        } catch {
          if (!cancelled) {
            map.fitBounds(CO_SPRINGS_BBOX, { padding: 50 });
          }
        }
      })();
    };

    if (map.loaded()) {
      onLoad();
    } else {
      map.once('load', onLoad);
    }

    return () => {
      cancelled = true;
      layersReadyRef.current = false;
      parcelsGeojsonRef.current = null;
      parcelsBoundsRef.current = null;
      projectsPolyRef.current = null;
      projectsPtsRef.current = null;
      if (pulseTimeoutRef.current) {
        clearTimeout(pulseTimeoutRef.current);
        pulseTimeoutRef.current = null;
      }
      if (drawRef.current) {
        // stop() deregisters the adapter and clears Terra Draw's layers,
        // sources, and listeners from the map before map.remove() tears the
        // map down — order matters to avoid touching a destroyed map.
        try {
          drawRef.current.stop();
        } catch {
          // The adapter throws if already deregistered; nothing to do.
        }
        drawRef.current = null;
      }
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    // Drawing is allowed only in Projects mode. Anywhere else (or when the
    // toggle is off) Terra Draw is parked in its built-in 'static' mode,
    // which neither captures pointer events nor renders interactive handles.
    // This both implements the "force drawMode off in Parcels" guard AND
    // prevents in-progress draws or select-mode handles from outliving a
    // mode switch.
    //
    // Note: after a 'finish' the handler above puts the instance in
    // 'select' mode. That state survives until drawMode flips here (or app
    // mode leaves Projects), at which point the polygon is locked into
    // 'static' and remains rendered but non-interactive.
    //
    // Editing wins over both new-draw and idle: while a scheme is being
    // edited the editing-load effect below owns the mode (it switches to
    // 'select' and keeps the feature selected). Short-circuit here so we
    // don't clobber that with 'polygon' or 'static'.
    if (editingSeed) return;
    if (mode === 'projects' && drawMode) {
      draw.setMode('polygon');
    } else {
      // Clear the lingering selection highlight from the new-scheme draw
      // flow before parking the instance. setMode('static') alone leaves
      // the previously selected feature visually highlighted because
      // Terra Draw retains selection state across mode changes.
      if (
        selectedDrawIdRef.current !== null &&
        draw.hasFeature(selectedDrawIdRef.current)
      ) {
        draw.deselectFeature(selectedDrawIdRef.current);
      }
      selectedDrawIdRef.current = null;
      draw.setMode('static');
    }
  }, [mode, drawMode, editingSeed]);

  // Imperative re-arm: bumping drawArmToken forces Terra Draw back into
  // polygon mode regardless of its current mode. This is what lets a
  // "Draw another" button work after the finish handler has parked the
  // instance in 'select', and what lets the user add a new footprint
  // during an edit session (where the editing-load effect also leaves
  // the instance in 'select'). Deliberately NOT gated on editingSeed —
  // arming must work both for new-scheme and edit flows. The finish
  // handler still auto-selects each completed pad so vertex/rotate
  // handles appear without an intermediate click.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    // Initial mount carries drawArmToken === 0; ignore so we don't fight
    // the boot-time mode/drawMode effect that decides static vs polygon.
    if (drawArmToken === 0) return;
    if (modeRef.current !== 'projects') return;
    draw.setMode('polygon');
  }, [drawArmToken]);

  // Imperative "select this footprint": parent bumps selectFootprintToken
  // after first setting selectFootprintId in the same React tick, so by
  // the time this effect runs the latest-value ref carries the id captured
  // at the bump. We switch into select mode and selectFeature(id); the
  // 'select' listener registered in onLoad fires and reports the new
  // selection up — no manual setState here, the event is the truth.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    if (selectFootprintToken === 0) return;
    if (modeRef.current !== 'projects') return;
    const id = selectFootprintIdRef.current;
    if (id === null) {
      // Null = deselect whatever's currently selected on the map. The
      // 'deselect' listener will fire and report null up to the parent,
      // clearing App's selectedFootprintId. No manual setState here.
      const current = currentMapSelectionRef.current;
      if (current !== null && draw.hasFeature(current)) {
        draw.deselectFeature(current);
      }
      return;
    }
    if (!draw.hasFeature(id)) return;
    draw.setMode('select');
    draw.selectFeature(id);
  }, [selectFootprintToken]);

  // Imperative "remove this footprint": parent bumps removeFootprintToken
  // after setting removeFootprintId. Defensive deselect first because
  // Terra Draw's removeFeatures makes no documented guarantee about
  // clearing selection on a removed feature; then re-emit the resulting
  // snapshot because removeFeatures doesn't (documented) fire 'change'
  // on programmatic removal — the parent needs the new set to drop the
  // deleted id from metaById.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    if (removeFootprintToken === 0) return;
    const id = removeFootprintIdRef.current;
    if (id === null) return;
    if (!draw.hasFeature(id)) return;
    draw.deselectFeature(id);
    draw.removeFeatures([id]);
    onFootprintsChangedRef.current(collectDrawnFootprints(draw));
  }, [removeFootprintToken]);

  // Load (or clear) a set of scheme footprints into Terra Draw for editing.
  // SEED ONCE: when editingSeed transitions from null → array, every polygon
  // is added to the instance, Terra Draw switches to select mode, and (if
  // there's exactly one polygon) it's selected so drag/rotate/vertex handles
  // appear without a click. From that moment on the app reads geometry OUT
  // via collectDrawnFootprints — it never pushes back in for the duration
  // of the session. When editingSeed transitions back to null (save or
  // cancel), the editing features are removed; the mode effect above then
  // restores 'static' or 'polygon'.
  //
  // The parent must hide the matching saved-scheme static layer while
  // editing, otherwise the user sees two identical sets of polygons.
  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !layersReadyRef.current || !draw) return;

    if (editingSeed) {
      // Drop any prior draft features before injecting the editing
      // polygons so the editor sees only this set.
      const existing = draw
        .getSnapshot()
        .map((f) => f.id)
        .filter((id): id is FeatureId => id !== undefined);
      if (existing.length > 0) {
        draw.removeFeatures(existing);
      }

      const result = draw.addFeatures(
        editingSeed.map((g) => ({
          type: 'Feature' as const,
          properties: { mode: 'polygon' },
          geometry: g,
        })),
      );
      const ids = result
        .map((r) => r.id)
        .filter((x): x is FeatureId => x !== undefined);
      editingFeatureIdsRef.current = new Set(ids);
      draw.setMode('select');
      // Single → auto-select for a one-click edit. Multiple → user clicks
      // to pick one (auto-selecting an arbitrary polygon would mislead).
      if (ids.length === 1) {
        draw.selectFeature(ids[0]);
      }
      // Emit the seeded set so the workspace immediately knows the real
      // Terra Draw feature ids for the polygons it just handed in.
      onFootprintsChangedRef.current(collectDrawnFootprints(draw));
    } else {
      for (const id of editingFeatureIdsRef.current) {
        if (draw.hasFeature(id)) {
          draw.removeFeatures([id]);
        }
      }
      editingFeatureIdsRef.current = new Set();
    }
  }, [editingSeed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;

    const geojson = parcelsGeojsonRef.current;
    if (!geojson) return;

    applySelection(map, selectedParcelId, {
      accentWash: getCssToken('--color-accent-wash'),
      graphite: getCssToken('--color-graphite'),
      accent: getCssToken('--color-accent'),
      geojson,
      parcelsBounds: parcelsBoundsRef.current,
      pulseTimeoutRef,
    });
  }, [selectedParcelId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;

    const parcelVisibility = mode === 'parcels' ? 'visible' : 'none';
    for (const layerId of PARCEL_LAYER_IDS) {
      map.setLayoutProperty(layerId, 'visibility', parcelVisibility);
    }
    const projectVisibility = mode === 'projects' ? 'visible' : 'none';
    for (const layerId of PROJECT_LAYER_IDS) {
      map.setLayoutProperty(layerId, 'visibility', projectVisibility);
    }
    for (const layerId of SAVED_SCHEME_LAYER_IDS) {
      map.setLayoutProperty(layerId, 'visibility', projectVisibility);
    }

    // Hide any drawn footprint when leaving Projects mode. Layer visibility
    // (rather than draw.clear()) is used so the polygon is preserved in
    // Terra Draw's store and reappears when the user returns to Projects.
    // The companion mode/drawMode effect also forces 'static' here, so no
    // new td-* layers will be added while we're hidden.
    setTerraDrawLayerVisibility(map, mode === 'projects');

    map.getCanvas().style.cursor = '';
  }, [mode]);

  // Push saved-scheme footprint changes into the GeoJSON source. Clears to
  // an empty FC when null (no scheme selected or project has none yet) or
  // when the array is empty.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;
    const source = map.getSource('saved-scheme') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    source.setData(savedSchemesToFeatureCollection(savedSchemeFootprints));
  }, [savedSchemeFootprints]);

  // Sync the saved-scheme-selected layer's filter to the multi-select
  // set. Empty set → literal false (nothing matches, layer hidden).
  // Non-empty → match any feature whose id is in the array. String
  // coercion mirrors the defensive note from before: App's selection
  // values are string | number, the GeoJSON properties carry
  // SchemeFootprint.id (a UUID string).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;
    if (selectedSavedFootprintIds.size === 0) {
      map.setFilter('saved-scheme-selected', ['literal', false]);
    } else {
      const ids = Array.from(selectedSavedFootprintIds).map(String);
      map.setFilter('saved-scheme-selected', [
        'in',
        ['get', 'id'],
        ['literal', ids],
      ]);
    }
  }, [selectedSavedFootprintIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;
    if (!map.getSource('projects-poly') || !map.getSource('projects-pts')) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const projects = await fetchProjects();
        if (cancelled) return;

        const { polygons, points } = projectsToFeatureCollections(projects);
        projectsPolyRef.current = polygons;
        projectsPtsRef.current = points;

        const polySource = map.getSource(
          'projects-poly',
        ) as maplibregl.GeoJSONSource | undefined;
        const ptsSource = map.getSource(
          'projects-pts',
        ) as maplibregl.GeoJSONSource | undefined;
        polySource?.setData(polygons);
        ptsSource?.setData(points);
      } catch {
        // Keep the existing layer data; the next refresh attempt will retry.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshProjectsToken]);

  // Sync the parcels prop into the map's GeoJSON source. Fires on every
  // parcels update (initial load + post-lookup refresh). Replaces the old
  // refreshParcelsToken fetch — the parent owns the fetch now; Map just
  // consumes the data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;
    const source = map.getSource('parcels') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;

    const geojson = parcelsToFeatureCollection(parcels);
    parcelsGeojsonRef.current = geojson;
    source.setData(geojson);

    const hadBounds = parcelsBoundsRef.current !== null;
    if (parcels.length > 0) {
      const [west, south, east, north] = bbox(geojson);
      parcelsBoundsRef.current = [
        [west, south],
        [east, north],
      ];
    } else {
      parcelsBoundsRef.current = null;
    }

    // Initial fit: when parcels first arrive (bounds was null, now set),
    // zoom the map to show them — unless a parcel is already selected.
    if (!hadBounds && parcelsBoundsRef.current && !selectedParcelIdRef.current) {
      map.fitBounds(parcelsBoundsRef.current, { padding: 50 });
    }

    // Catch-up fly-to + highlight for the async race: the selectedParcelId
    // effect may have run against stale data before this update landed the
    // just-looked-up parcel, so re-apply the current selection.
    if (selectedParcelIdRef.current) {
      applySelection(map, selectedParcelIdRef.current, {
        accentWash: getCssToken('--color-accent-wash'),
        graphite: getCssToken('--color-graphite'),
        accent: getCssToken('--color-accent'),
        geojson,
        parcelsBounds: parcelsBoundsRef.current,
        pulseTimeoutRef,
      });
    }
  }, [parcels]);

  return (
    <div
      ref={containerRef}
      className="site-planner-map h-full w-full"
      role="application"
      aria-label="Parcel map"
    />
  );
}

type SelectionContext = {
  accentWash: string;
  graphite: string;
  accent: string;
  geojson: FeatureCollection;
  parcelsBounds: [[number, number], [number, number]] | null;
  pulseTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
};

function applySelection(
  map: maplibregl.Map,
  selectedParcelId: string | null,
  ctx: SelectionContext,
) {
  const { graphite, accent, geojson, parcelsBounds, pulseTimeoutRef } = ctx;

  if (pulseTimeoutRef.current) {
    clearTimeout(pulseTimeoutRef.current);
    pulseTimeoutRef.current = null;
  }

  if (!selectedParcelId) {
    map.setFilter('parcels-outline-selected', ['literal', false]);
    map.setFilter('parcels-fill', null);
    map.setPaintProperty('parcels-fill', 'fill-opacity', 0);
    map.setPaintProperty('parcels-outline', 'line-color', graphite);

    if (parcelsBounds) {
      map.fitBounds(parcelsBounds, { padding: 50 });
    } else {
      map.fitBounds(CO_SPRINGS_BBOX, { padding: 50 });
    }
    return;
  }

  map.setFilter('parcels-outline-selected', [
    '==',
    ['get', 'id'],
    selectedParcelId,
  ]);
  map.setFilter('parcels-fill', ['==', ['get', 'id'], selectedParcelId]);
  map.setPaintProperty('parcels-outline', 'line-color', [
    'case',
    ['==', ['get', 'id'], selectedParcelId],
    accent,
    graphite,
  ]);

  const bounds = parcelBounds(geojson, selectedParcelId);
  if (bounds) {
    map.fitBounds(bounds, { padding: 80, duration: 800 });
  }

  map.setPaintProperty('parcels-fill', 'fill-opacity-transition', {
    duration: 250,
    delay: 0,
  });
  map.setPaintProperty('parcels-fill', 'fill-opacity', 0);

  pulseTimeoutRef.current = setTimeout(() => {
    map.setPaintProperty('parcels-fill', 'fill-opacity', 0.2);
    pulseTimeoutRef.current = setTimeout(() => {
      map.setPaintProperty('parcels-fill', 'fill-opacity', 0.15);
      pulseTimeoutRef.current = null;
    }, 250);
  }, 0);
}
