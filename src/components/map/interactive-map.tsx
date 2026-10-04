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
import type { FeatureCollection, Point } from 'geojson';

import { DEFAULT_SELECTED_LOCATION, TASHKENT_CENTER } from '@/lib/data/demo-locations';
import { validateCoordinates } from '@/lib/domain/coordinates';
import type { DisplayLocation, SelectedLocation } from '@/lib/domain/map-location';
import { createCirclePolygon } from '@/lib/geo/circle';
import { toMapPointFeatureCollection } from '@/lib/map/map-feature-adapter';
import type {
  SafeMapFeature,
  SafeMapFeatureProperties,
  ViewportBounds,
} from '@/lib/spatial/contracts';
import {
  fetchViewportFeatures,
  fetchWorkspaceViewportFeatures,
  SpatialApiError,
} from '@/lib/spatial/client';
import { MAX_VIEWPORT_LATITUDE_SPAN, MAX_VIEWPORT_LONGITUDE_SPAN } from '@/lib/spatial/validation';
import type { MapDataStatus, MapViewProps } from '@/components/map/map-types';

const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const POINT_SOURCE_ID = 'pilot-points';
const SELECTED_SOURCE_ID = 'selected-location';
const RADIUS_SOURCE_ID = 'analysis-radius';

function toViewportBounds(map: MapLibreMap): ViewportBounds | null {
  const bounds = map.getBounds();
  const west = Math.max(-180, bounds.getWest());
  const south = Math.max(-90, bounds.getSouth());
  const east = Math.min(180, bounds.getEast());
  const north = Math.min(90, bounds.getNorth());

  if (![west, south, east, north].every((value) => Number.isFinite(value))) return null;
  if (west >= east || south >= north) return null;

  return { west, south, east, north };
}

function isBroadViewport(bounds: ViewportBounds): boolean {
  return (
    bounds.east - bounds.west > MAX_VIEWPORT_LONGITUDE_SPAN ||
    bounds.north - bounds.south > MAX_VIEWPORT_LATITUDE_SPAN
  );
}

function toEmptyFeatureCollection(): FeatureCollection<Point, SafeMapFeatureProperties> {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Selection display for a database-backed feature. Customer features carry no
 * name, address or revenue, so the label is generated client-side from the
 * display-safe allow-list only.
 */
function toSelectedLocation(feature: SafeMapFeature): DisplayLocation | null {
  if (feature.geometry.type !== 'Point') return null;

  const coordinates = validateCoordinates(feature.geometry.coordinates);
  const properties = feature.properties;

  if (properties.kind === 'customers') {
    return {
      id: properties.id,
      name: 'Customer point',
      kind: 'customers',
      category: properties.category,
      address: 'Synthetic customer location · contact data intentionally excluded',
      coordinates,
    };
  }

  return {
    id: properties.id,
    name: properties.name,
    kind: properties.kind,
    category: properties.category,
    address: 'Synthetic demo workspace · Tashkent',
    coordinates,
  };
}

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
  dataSource,
  workspaceId,
  onSelectLocation,
  onCreateCandidate,
  onFeaturesLoaded,
  onDataStateChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const featuresRef = useRef<SafeMapFeature[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [hasMapError, setHasMapError] = useState(false);
  const [status, setStatus] = useState<MapDataStatus>('loading');
  const [truncated, setTruncated] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const onSelectLocationRef = useRef(onSelectLocation);
  const onCreateCandidateRef = useRef(onCreateCandidate);
  const onFeaturesLoadedRef = useRef(onFeaturesLoaded);
  const onDataStateChangeRef = useRef(onDataStateChange);
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    onSelectLocationRef.current = onSelectLocation;
    onCreateCandidateRef.current = onCreateCandidate;
    onFeaturesLoadedRef.current = onFeaturesLoaded;
    onDataStateChangeRef.current = onDataStateChange;
  }, [onCreateCandidate, onDataStateChange, onFeaturesLoaded, onSelectLocation]);

  useEffect(() => {
    hasLoadedOnceRef.current = hasLoadedOnce;
  }, [hasLoadedOnce]);

  useEffect(() => {
    onDataStateChangeRef.current({
      status,
      dataSource,
      featureCount: featuresRef.current.length,
      truncated,
      message: statusMessage,
    });
  }, [dataSource, status, statusMessage, truncated]);

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
        data: toEmptyFeatureCollection(),
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
        const clickedId = event.features?.[0]?.properties?.id;
        const feature = featuresRef.current.find((item) => item.properties.id === clickedId);
        if (!feature) return;

        const location = toSelectedLocation(feature);
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
      requestRef.current?.abort();
      requestRef.current = null;
      map.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapStyleUrl]);

  // Viewport loading: one request per completed movement, stale requests are
  // aborted so an older response can never overwrite a newer viewport.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;

    let disposed = false;

    async function loadViewport() {
      const currentMap = mapRef.current;
      if (!currentMap || disposed) return;

      const source = currentMap.getSource(POINT_SOURCE_ID) as GeoJSONSource | undefined;

      if (visibleLayers.length === 0) {
        requestRef.current?.abort();
        requestRef.current = null;
        featuresRef.current = [];
        source?.setData(toEmptyFeatureCollection());
        setStatus('empty');
        setStatusMessage('All map layers are hidden.');
        onFeaturesLoadedRef.current({
          features: [],
          meta: {
            returnedCount: 0,
            limit: 0,
            truncated: false,
            bounds: { west: 0, south: 0, east: 0, north: 0 },
            kinds: [],
          },
        });
        return;
      }

      const bounds = toViewportBounds(currentMap);
      if (!bounds) return;

      if (isBroadViewport(bounds)) {
        requestRef.current?.abort();
        requestRef.current = null;
        setStatus('too-broad');
        setStatusMessage('Zoom in to load the Tashkent demo area.');
        return;
      }

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      const sequence = (requestSequence.current += 1);

      setStatus(hasLoadedOnceRef.current ? 'refreshing' : 'loading');
      setStatusMessage(null);

      try {
        const collection = await (workspaceId
          ? fetchWorkspaceViewportFeatures(workspaceId, bounds, visibleLayers, controller.signal)
          : fetchViewportFeatures(bounds, visibleLayers, controller.signal));
        if (disposed || sequence !== requestSequence.current) return;

        featuresRef.current = collection.features;
        source?.setData(collection);
        setHasLoadedOnce(true);
        setTruncated(collection.meta.truncated);
        setStatus(collection.features.length === 0 ? 'empty' : 'ready');
        setStatusMessage(
          collection.meta.truncated
            ? `Showing the first ${collection.meta.limit} features; zoom in for detail.`
            : collection.features.length === 0
              ? 'No synthetic demo features in this viewport.'
              : null,
        );
        onFeaturesLoadedRef.current({ features: collection.features, meta: collection.meta });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        featuresRef.current = [];
        source?.setData(toEmptyFeatureCollection());
        setHasLoadedOnce(true);
        setStatus('error');
        setStatusMessage(
          error instanceof SpatialApiError
            ? error.message
            : 'Map features could not be loaded from the demo database.',
        );
        onFeaturesLoadedRef.current({ features: [], meta: { returnedCount: 0, limit: 0, truncated: false, bounds, kinds: visibleLayers } });
      }
    }

    void loadViewport();
    map.on('moveend', loadViewport);

    return () => {
      disposed = true;
      map.off('moveend', loadViewport);
    };
  }, [isMapLoaded, visibleLayers, workspaceId]);

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

  const statusLabel = (() => {
    if (status === 'loading') return 'Loading demo features…';
    if (status === 'refreshing') return 'Refreshing viewport…';
    if (status === 'error') return 'Map data unavailable';
    if (status === 'too-broad') return 'Zoom in for demo data';
    if (status === 'empty') return statusMessage ?? 'No features in view';
    return `${featuresRef.current.length} features in view`;
  })();

  return (
    <div className="map-canvas-shell">
      <div aria-label="Interactive map of the Tashkent pilot area" className="map-canvas" ref={containerRef} role="application" />
      <div
        aria-live="polite"
        className={`map-data-status map-data-status--${status}`}
        data-source={dataSource}
        role="status"
        title={statusMessage ?? undefined}
      >
        <span aria-hidden="true" className="map-data-status__dot" />
        <span>{statusLabel}</span>
      </div>
      {hasMapError && !isMapLoaded ? (
        <div className="map-error" role="status">
          <strong>Map style is unavailable</strong>
          <span>Check NEXT_PUBLIC_MAP_STYLE_URL or try another MapLibre-compatible style.</span>
        </div>
      ) : null}
    </div>
  );
}
