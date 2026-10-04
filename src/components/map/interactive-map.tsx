'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
} from 'maplibre-gl';
import { DEMO_LOCATIONS, DEFAULT_SELECTED_LOCATION, TASHKENT_CENTER } from '@/lib/data/demo-locations';
import { validateCoordinates, type Coordinates } from '@/lib/domain/coordinates';
import type { MapLayerId, SelectedLocation } from '@/lib/domain/map-location';
import { createCirclePolygon } from '@/lib/geo/circle';
import { toMapPointFeatureCollection } from '@/lib/map/map-feature-adapter';
import type { MapFocusRequest } from '@/components/map/map-types';

interface InteractiveMapProps {
  visibleLayers: MapLayerId[];
  selectedLocation: SelectedLocation;
  radiusMeters: number;
  focusRequest: MapFocusRequest | null;
  onSelectLocation: (location: SelectedLocation) => void;
  onCreateCandidate: (coordinates: Coordinates) => void;
}

const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const POINT_SOURCE_ID = 'pilot-points';
const SELECTED_SOURCE_ID = 'selected-location';
const RADIUS_SOURCE_ID = 'analysis-radius';

function updateCircleSource(
  map: MapLibreMap,
  selectedLocation: SelectedLocation,
  radiusMeters: number,
) {
  const radiusSource = map.getSource(RADIUS_SOURCE_ID) as GeoJSONSource | undefined;
  const selectedSource = map.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;

  radiusSource?.setData(createCirclePolygon(selectedLocation.coordinates, radiusMeters));
  selectedSource?.setData(toMapPointFeatureCollection([selectedLocation]));
}

export function InteractiveMap({
  visibleLayers,
  selectedLocation,
  radiusMeters,
  focusRequest,
  onSelectLocation,
  onCreateCandidate,
}: InteractiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [hasMapError, setHasMapError] = useState(false);
  const onSelectLocationRef = useRef(onSelectLocation);
  const onCreateCandidateRef = useRef(onCreateCandidate);

  useEffect(() => {
    onSelectLocationRef.current = onSelectLocation;
    onCreateCandidateRef.current = onCreateCandidate;
  }, [onCreateCandidate, onSelectLocation]);

  const mapStyleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL;

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: mapStyleUrl,
      center: TASHKENT_CENTER,
      zoom: 12.35,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
    });

    mapRef.current = map;
    map.addControl(
      new NavigationControl({ showCompass: false, visualizePitch: false }),
      'bottom-left',
    );
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: false },
        trackUserLocation: false,
        showUserLocation: true,
      }),
      'bottom-left',
    );
    map.addControl(new ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-left');

    map.on('error', () => {
      // Individual tile failures should not take down the analysis panel.
      // Surface only a persistent style load failure if the map never loads.
      if (!map.isStyleLoaded()) setHasMapError(true);
    });

    map.on('load', () => {
      map.addSource(POINT_SOURCE_ID, {
        type: 'geojson',
        data: toMapPointFeatureCollection(DEMO_LOCATIONS),
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 48,
      });
      map.addSource(SELECTED_SOURCE_ID, {
        type: 'geojson',
        data: toMapPointFeatureCollection([DEFAULT_SELECTED_LOCATION]),
      });
      map.addSource(RADIUS_SOURCE_ID, {
        type: 'geojson',
        data: createCirclePolygon(DEFAULT_SELECTED_LOCATION.coordinates, 1_000),
      });

      map.addLayer({
        id: 'radius-fill',
        type: 'fill',
        source: RADIUS_SOURCE_ID,
        paint: {
          'fill-color': '#d7a84d',
          'fill-opacity': 0.075,
        },
      });
      map.addLayer({
        id: 'radius-outline',
        type: 'line',
        source: RADIUS_SOURCE_ID,
        paint: {
          'line-color': '#bd862f',
          'line-width': 1.5,
          'line-dasharray': [2, 2],
          'line-opacity': 0.82,
        },
      });
      map.addLayer({
        id: 'point-clusters',
        type: 'circle',
        source: POINT_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#a2cbbf',
            8,
            '#6da999',
            20,
            '#416f68',
          ],
          'circle-radius': ['step', ['get', 'point_count'], 15, 8, 19, 20, 23],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'point-cluster-count',
        type: 'symbol',
        source: POINT_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 11,
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
        },
        paint: {
          'text-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'point-markers',
        type: 'circle',
        source: POINT_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'kind'],
            'customers', '#1b9c86',
            'competitors', '#e87966',
            'branches', '#5274df',
            'places', '#9479d5',
            '#687789',
          ],
          'circle-radius': 6,
          'circle-stroke-width': 1.75,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'selection-halo',
        type: 'circle',
        source: SELECTED_SOURCE_ID,
        paint: {
          'circle-radius': 15,
          'circle-color': 'rgba(221, 163, 69, 0.12)',
          'circle-stroke-color': 'rgba(184, 128, 38, 0.54)',
          'circle-stroke-width': 1.4,
        },
      });
      map.addLayer({
        id: 'candidate-core',
        type: 'circle',
        source: SELECTED_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'candidate'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#d99b35',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.on('click', 'point-markers', (event) => {
        const properties = event.features?.[0]?.properties;
        const location = DEMO_LOCATIONS.find((item) => item.id === properties?.id);
        if (location) onSelectLocationRef.current(location);
      });

      map.on('click', 'point-clusters', (event) => {
        const feature = event.features?.[0];
        const clusterId = feature?.properties?.cluster_id;
        const source = map.getSource(POINT_SOURCE_ID) as GeoJSONSource;
        const coordinates = feature?.geometry.type === 'Point'
          ? validateCoordinates(feature.geometry.coordinates)
          : null;

        if (typeof clusterId !== 'number' || !coordinates) return;

        void source.getClusterExpansionZoom(clusterId).then((zoom) => {
          map.easeTo({ center: coordinates, zoom, duration: 450 });
        });
      });

      map.on('click', (event) => {
        const clickedFeatures = map.queryRenderedFeatures(event.point, {
          layers: ['point-markers', 'point-clusters', 'candidate-core'],
        });
        if (clickedFeatures.length > 0) return;

        onCreateCandidateRef.current([event.lngLat.lng, event.lngLat.lat]);
      });

      for (const layerId of ['point-markers', 'point-clusters', 'candidate-core']) {
        map.on('mouseenter', layerId, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
        });
      }

      setIsMapLoaded(true);
      setHasMapError(false);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapStyleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;

    const visibleLayerSet = new Set(visibleLayers);
    const visibleLocations = DEMO_LOCATIONS.filter((location) =>
      visibleLayerSet.has(location.kind),
    );
    const source = map.getSource(POINT_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toMapPointFeatureCollection(visibleLocations));
  }, [isMapLoaded, visibleLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;

    updateCircleSource(map, selectedLocation, radiusMeters);
  }, [isMapLoaded, radiusMeters, selectedLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded || !focusRequest) return;

    map.flyTo({
      center: focusRequest.location.coordinates,
      zoom: Math.max(map.getZoom(), 14.5),
      duration: 850,
      essential: true,
    });
  }, [focusRequest, isMapLoaded]);

  return (
    <div className="map-canvas-shell">
      <div aria-label="Interactive map of the Tashkent pilot area" className="map-canvas" ref={containerRef} role="application" />
      {hasMapError && !isMapLoaded ? (
        <div className="map-error" role="status">
          <strong>Map style is unavailable</strong>
          <span>Check NEXT_PUBLIC_MAP_STYLE_URL or try another MapLibre-compatible style.</span>
        </div>
      ) : null}
    </div>
  );
}
