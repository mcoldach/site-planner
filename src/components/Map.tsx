import { useEffect, useRef } from 'react';
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

type MapProps = {
  selectedParcelId: string | null;
};

export function Map({ selectedParcelId }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Wired for upcoming selection/highlight behavior.
  void selectedParcelId;

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

    let cancelled = false;

    const onLoad = () => {
      void (async () => {
        try {
          const parcels = await fetchAllParcels();
          if (cancelled) return;

          const geojson = parcelsToFeatureCollection(parcels);

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

          if (parcels.length > 0) {
            const [west, south, east, north] = bbox(geojson);
            map.fitBounds(
              [
                [west, south],
                [east, north],
              ],
              { padding: 50 },
            );
          } else {
            map.fitBounds(CO_SPRINGS_BBOX, { padding: 50 });
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
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="site-planner-map h-full w-full"
      role="application"
      aria-label="Parcel map"
    />
  );
}
