'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { MapPin, MousePointer2 } from 'lucide-react';

import { AnalysisPanel } from '@/components/app/analysis-panel';
import {
  IDLE_ANALYSIS_STATE,
  resolveAnalysisState,
  type AnalysisState,
} from '@/components/app/analysis-state';
import { ComingSoon } from '@/components/app/coming-soon';
import { LeftSidebar, type WorkspaceSection } from '@/components/app/left-sidebar';
import { MapLayerControl } from '@/components/app/map-layer-control';
import { TopBar } from '@/components/app/top-bar';
import { MapView } from '@/components/map/map-view';
import type {
  MapDataState,
  MapFocusRequest,
  MapViewportSnapshot,
} from '@/components/map/map-types';
import { DEFAULT_SELECTED_LOCATION, DEMO_LOCATIONS } from '@/lib/data/demo-locations';
import { validateCoordinates, type Coordinates } from '@/lib/domain/coordinates';
import {
  MAP_LAYER_IDS,
  type DisplayLocation,
  type MapLayerId,
  type SelectedLocation,
} from '@/lib/domain/map-location';
import { analysisKey, toAnalysisPanelView } from '@/lib/spatial/analysis-view';
import {
  requestRadiusAnalysis,
  requestWorkspaceRadiusAnalysis,
  SpatialApiError,
} from '@/lib/spatial/client';
import type { DataSourceMode } from '@/lib/spatial/data-source';

const INITIAL_MAP_DATA_STATE: MapDataState = {
  status: 'loading',
  dataSource: 'database',
  featureCount: 0,
  truncated: false,
  message: null,
};

const EMPTY_LAYER_COUNTS: Record<MapLayerId, number> = {
  customers: 0,
  competitors: 0,
  branches: 0,
  places: 0,
};

export function AppShell({
  dataSource,
  workspaceId,
}: {
  dataSource: DataSourceMode;
  /** Present only on the authenticated tenant route; absent for the public demo. */
  workspaceId?: string;
}) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('Map');
  const [visibleLayers, setVisibleLayers] = useState<MapLayerId[]>([...MAP_LAYER_IDS]);
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation>(
    DEFAULT_SELECTED_LOCATION,
  );
  const [radiusMeters, setRadiusMeters] = useState(1_000);
  const [focusRequest, setFocusRequest] = useState<MapFocusRequest | null>(null);
  const [viewportSnapshot, setViewportSnapshot] = useState<MapViewportSnapshot | null>(null);
  const [mapDataState, setMapDataState] = useState<MapDataState>({
    ...INITIAL_MAP_DATA_STATE,
    dataSource,
  });
  const [analysis, setAnalysis] = useState<AnalysisState>(IDLE_ANALYSIS_STATE);
  const analysisRequestRef = useRef<AbortController | null>(null);
  const focusRequestId = useRef(0);
  const candidateNumber = useRef(1);

  const currentAnalysisKey = analysisKey(selectedLocation.coordinates, radiusMeters);

  const handleSearchSelect = useCallback((location: SelectedLocation) => {
    setSelectedLocation(location);
    focusRequestId.current += 1;
    setFocusRequest({ id: focusRequestId.current, location });
  }, []);

  const handleMapSelect = useCallback((location: SelectedLocation) => {
    setSelectedLocation(location);
  }, []);

  const handleMapCreateCandidate = useCallback((coordinates: Coordinates) => {
    const validatedCoordinates = validateCoordinates(coordinates);
    const nextNumber = (candidateNumber.current += 1);
    setSelectedLocation({
      id: `candidate-site-${nextNumber}`,
      name: `Candidate site ${String(nextNumber).padStart(2, '0')}`,
      kind: 'candidate',
      category: 'Potential location',
      address: 'Map-selected coordinate · geocoding not configured',
      coordinates: validatedCoordinates,
    });
  }, []);

  const handleToggleLayer = useCallback((layer: MapLayerId) => {
    setVisibleLayers((currentLayers) =>
      currentLayers.includes(layer)
        ? currentLayers.filter((currentLayer) => currentLayer !== layer)
        : [...currentLayers, layer],
    );
  }, []);

  const handleFeaturesLoaded = useCallback((snapshot: MapViewportSnapshot) => {
    setViewportSnapshot(snapshot);
  }, []);

  const handleDataStateChange = useCallback((state: MapDataState) => {
    setMapDataState(state);
  }, []);

  const handleAnalyze = useCallback(() => {
    analysisRequestRef.current?.abort();
    const controller = new AbortController();
    analysisRequestRef.current = controller;

    const requestedKey = analysisKey(selectedLocation.coordinates, radiusMeters);
    setAnalysis((current) => ({
      ...current,
      status: 'loading',
      errorMessage: null,
      stale: false,
    }));

    const analysisRequest = {
      candidate: {
        longitude: selectedLocation.coordinates[0],
        latitude: selectedLocation.coordinates[1],
      },
      radiusMeters,
    };

    void (workspaceId
      ? requestWorkspaceRadiusAnalysis(workspaceId, analysisRequest, controller.signal)
      : requestRadiusAnalysis(analysisRequest, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        setAnalysis({
          status: 'ready',
          view: toAnalysisPanelView(result),
          errorMessage: null,
          key: requestedKey,
          stale: false,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        setAnalysis({
          status: 'error',
          view: null,
          errorMessage:
            error instanceof SpatialApiError
              ? error.message
              : 'The radius analysis could not be completed.',
          key: requestedKey,
          stale: false,
        });
      });
  }, [radiusMeters, selectedLocation.coordinates, workspaceId]);

  // Results stay visible but are explicitly marked stale until the candidate
  // and radius match a completed server analysis.
  const resolvedAnalysis: AnalysisState = useMemo(
    () => resolveAnalysisState(analysis, currentAnalysisKey),
    [analysis, currentAnalysisKey],
  );

  const layerCounts = useMemo<Record<MapLayerId, number>>(() => {
    if (!viewportSnapshot) return EMPTY_LAYER_COUNTS;

    const counts = { ...EMPTY_LAYER_COUNTS };
    for (const feature of viewportSnapshot.features) {
      const kind = feature.properties.kind;
      if (kind in counts) counts[kind] += 1;
    }
    return counts;
  }, [viewportSnapshot]);

  const searchLocations = useMemo<DisplayLocation[]>(() => {
    if (dataSource === 'fixtures') return DEMO_LOCATIONS;

    if (!viewportSnapshot) return [];
    return viewportSnapshot.features.flatMap((feature): DisplayLocation[] => {
      const properties = feature.properties;
      if (properties.kind === 'customers' || feature.geometry.type !== 'Point') return [];

      return [
        {
          id: properties.id,
          name: properties.name,
          kind: properties.kind,
          category: properties.category,
          address: 'Synthetic demo workspace · Tashkent',
          coordinates: validateCoordinates(feature.geometry.coordinates),
        },
      ];
    });
  }, [dataSource, viewportSnapshot]);

  const mapDataLabel = dataSource === 'database' ? 'PostGIS demo workspace' : 'Fixture preview';

  return (
    <div className="app-shell flex h-dvh min-h-[600px] w-full overflow-hidden">
      <LeftSidebar activeSection={activeSection} onNavigate={setActiveSection} />
      <div className="workspace-column">
        <TopBar onSelectLocation={handleSearchSelect} searchLocations={searchLocations} />

        {activeSection === 'Map' ? (
          <main className="map-workspace">
            <section aria-label="Tashkent map workspace" className="map-stage">
              <MapView
                dataSource={dataSource}
                focusRequest={focusRequest}
                onDataStateChange={handleDataStateChange}
                onFeaturesLoaded={handleFeaturesLoaded}
                onCreateCandidate={handleMapCreateCandidate}
                onSelectLocation={handleMapSelect}
                radiusMeters={radiusMeters}
                selectedLocation={selectedLocation}
                visibleLayers={visibleLayers}
                workspaceId={workspaceId}
              />
              <div className="map-place-badge">
                <span aria-hidden="true" className="map-place-badge__icon">
                  <MapPin size={15} strokeWidth={1.9} />
                </span>
                <span className="map-place-badge__copy">
                  <span className="map-place-badge__eyebrow">CITY PILOT</span>
                  <span className="map-place-badge__name">Tashkent, Uzbekistan</span>
                </span>
              </div>
              <MapLayerControl
                dataSource={dataSource}
                layerCounts={layerCounts}
                onToggleLayer={handleToggleLayer}
                visibleLayers={visibleLayers}
              />
              <div className="map-instruction">
                <MousePointer2 aria-hidden="true" size={14} strokeWidth={1.8} />
                Click the map to place a candidate site
              </div>
              <div className="map-attribution-note">
                {mapDataLabel} · synthetic data
              </div>
            </section>
            <AnalysisPanel
              analysis={resolvedAnalysis}
              dataSource={dataSource}
              mapDataState={mapDataState}
              onAnalyze={handleAnalyze}
              onRadiusChange={setRadiusMeters}
              radiusMeters={radiusMeters}
              selectedLocation={selectedLocation}
            />
          </main>
        ) : (
          <ComingSoon onReturnToMap={() => setActiveSection('Map')} section={activeSection} />
        )}
      </div>
    </div>
  );
}
