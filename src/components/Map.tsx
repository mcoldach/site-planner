import { useEffect, useRef, type MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/turf';
import type { FeatureCollection } from 'geojson';
import { fetchAllParcels, fetchProjects } from '../lib/data';
import { getCssToken } from '../lib/css-tokens';
import type { Parcel, Project } from '../lib/types';

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

type MapProps = {
  mode: 'projects' | 'parcels';
  selectedParcelId: string | null;
  onParcelClick: (parcelId: string) => void;
  onProjectClick: (projectId: string) => void;
  refreshProjectsToken: number;
};

export function Map({
  mode,
  selectedParcelId,
  onParcelClick,
  onProjectClick,
  refreshProjectsToken,
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
      map.remove();
      mapRef.current = null;
    };
  }, []);

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

    map.getCanvas().style.cursor = '';
  }, [mode]);

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
