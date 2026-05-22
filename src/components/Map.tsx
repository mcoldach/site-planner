import { useEffect, useRef, type MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/turf';
import type { FeatureCollection } from 'geojson';
import { fetchAllParcels } from '../lib/data';
import { getCssToken } from '../lib/css-tokens';
import type { Parcel } from '../lib/types';

const CO_SPRINGS_BBOX: [[number, number], [number, number]] = [
  [-104.95, 38.78],
  [-104.68, 38.92],
];

const OPENFREEMAP_POSITRON =
  'https://tiles.openfreemap.org/styles/positron';

const NONE_ID = '__none__';

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

type MapProps = {
  selectedParcelId: string | null;
  onParcelClick: (parcelId: string) => void;
};

export function Map({ selectedParcelId, onParcelClick }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const parcelsGeojsonRef = useRef<FeatureCollection | null>(null);
  const parcelsBoundsRef = useRef<[[number, number], [number, number]] | null>(
    null,
  );
  const layersReadyRef = useRef(false);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onParcelClickRef = useRef(onParcelClick);
  onParcelClickRef.current = onParcelClick;
  const selectedParcelIdRef = useRef(selectedParcelId);
  selectedParcelIdRef.current = selectedParcelId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_POSITRON,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

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
            filter: ['==', ['get', 'id'], NONE_ID],
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
  const filterId = selectedParcelId ?? NONE_ID;

  if (pulseTimeoutRef.current) {
    clearTimeout(pulseTimeoutRef.current);
    pulseTimeoutRef.current = null;
  }

  map.setFilter('parcels-outline-selected', [
    '==',
    ['get', 'id'],
    filterId,
  ]);

  if (!selectedParcelId) {
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
