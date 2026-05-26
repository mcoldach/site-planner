import { useEffect, useRef, type MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/turf';
import type { FeatureCollection } from 'geojson';
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { fetchAllParcels, fetchProjects } from '../lib/data';
import { getCssToken } from '../lib/css-tokens';
import type { Parcel, Project } from '../lib/types';

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
        properties: { id: p.id, name: p.name },
        geometry: p.geometry,
      })),
    },
    points: {
      type: 'FeatureCollection',
      features: projects.map((p) => ({
        type: 'Feature',
        id: p.id,
        properties: { id: p.id, name: p.name },
        geometry: p.centroid,
      })),
    },
  };
}

const EMPTY_FC: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

function savedSchemeToFeatureCollection(
  footprint: GeoJSON.Polygon | null,
): FeatureCollection {
  if (!footprint) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: footprint,
      },
    ],
  };
}

type MapProps = {
  mode: 'projects' | 'parcels';
  selectedParcelId: string | null;
  onParcelClick: (parcelId: string) => void;
  onProjectClick: (projectId: string) => void;
  refreshProjectsToken: number;
  drawMode: boolean;
  onFootprintDrawn: (geojson: GeoJSON.Polygon) => void;
  savedSchemeFootprint: GeoJSON.Polygon | null;
};

export function Map({
  mode,
  selectedParcelId,
  onParcelClick,
  onProjectClick,
  refreshProjectsToken,
  drawMode,
  onFootprintDrawn,
  savedSchemeFootprint,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
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
  const onFootprintDrawnRef = useRef(onFootprintDrawn);
  onFootprintDrawnRef.current = onFootprintDrawn;
  // The saved-scheme source is created inside onLoad's async closure, which
  // doesn't see prop updates. Sync the ref via an effect (the canonical
  // "latest value" pattern) so the source.data reflects whatever the prop
  // is at the moment layers are first added — even if it changed between
  // mount and the async onLoad firing.
  const savedSchemeFootprintRef = useRef<GeoJSON.Polygon | null>(
    savedSchemeFootprint,
  );
  useEffect(() => {
    savedSchemeFootprintRef.current = savedSchemeFootprint;
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
          const parcels = await fetchAllParcels();
          if (cancelled) return;

          const geojson = parcelsToFeatureCollection(parcels);
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
              'fill-color': accentWash,
              'fill-opacity': 0.35,
            },
          });

          map.addLayer({
            id: 'projects-outline',
            type: 'line',
            source: 'projects-poly',
            minzoom: 14,
            paint: {
              'line-color': accent,
              'line-width': 2,
            },
          });

          map.addLayer({
            id: 'projects-dot',
            type: 'circle',
            source: 'projects-pts',
            maxzoom: 14,
            paint: {
              'circle-color': accent,
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
          // below fills it as savedSchemeFootprint changes. Same minzoom as
          // projects-fill/-outline so a saved building only shows once the
          // user has zoomed into the project — at far-out zooms the project
          // is just a dot/label, so a tiny floating polygon would be noise.
          map.addSource('saved-scheme', {
            type: 'geojson',
            data: savedSchemeToFeatureCollection(savedSchemeFootprintRef.current),
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

          if (parcels.length > 0) {
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

          // Hide td-* layers immediately if we booted in Parcels mode. No
          // layers exist yet (Terra Draw lazy-adds them on first render), so
          // this is a no-op today but stays correct if init order ever
          // changes.
          setTerraDrawLayerVisibility(map, modeRef.current === 'projects');

          // Sync the initial draw mode here because the mode/drawMode effect
          // that controls Terra Draw's mode ran before drawRef was populated
          // by this async load. Only enable drawing in Projects mode — this
          // is the same guard the effect applies.
          if (modeRef.current === 'projects' && drawModeRef.current) {
            draw.setMode('polygon');
          }

          draw.on('finish', ((...args: unknown[]) => {
            const [id] = args as [FeatureId, unknown];
            const instance = drawRef.current;
            if (!instance) return;
            const features = instance.getSnapshot();
            const finished = features.find((f) => f.id === id);
            if (!finished || finished.geometry.type !== 'Polygon') return;

            // V1: only one footprint at a time. Drop any prior finished
            // polygons left in the store so the just-drawn one is the sole
            // visible draft.
            const stale = features
              .map((f) => f.id)
              .filter(
                (fid): fid is FeatureId =>
                  fid !== undefined && fid !== id,
              );
            if (stale.length > 0) {
              instance.removeFeatures(stale);
            }

            onFootprintDrawnRef.current(finished.geometry as GeoJSON.Polygon);

            // Hand the just-drawn polygon to select mode so the user can
            // rotate, drag, and edit vertices without an intermediate click.
            // selectFeature auto-uses the registered select mode.
            instance.setMode('select');
            instance.selectFeature(id);
          }) as (id: FeatureId, context: unknown) => void);

          // Edits in select mode (drag whole feature, rotate, vertex drag,
          // midpoint insert, vertex delete) emit 'change' with type 'update'.
          // Polygon mode also emits 'change' as the user clicks vertices
          // during draw — those are gated out by checking the current mode.
          draw.on('change', ((...args: unknown[]) => {
            const [, type] = args as [FeatureId[], string, unknown?];
            const instance = drawRef.current;
            if (!instance) return;
            if (type !== 'update') return;
            if (instance.getMode() !== 'select') return;
            const polygonFeature = instance
              .getSnapshot()
              .find((f) => f.geometry.type === 'Polygon');
            if (!polygonFeature) return;
            onFootprintDrawnRef.current(
              polygonFeature.geometry as GeoJSON.Polygon,
            );
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
    if (mode === 'projects' && drawMode) {
      draw.setMode('polygon');
    } else {
      draw.setMode('static');
    }
  }, [mode, drawMode]);

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
  // an empty FC when null (no scheme selected or project has none yet).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReadyRef.current) return;
    const source = map.getSource('saved-scheme') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    source.setData(savedSchemeToFeatureCollection(savedSchemeFootprint));
  }, [savedSchemeFootprint]);

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
