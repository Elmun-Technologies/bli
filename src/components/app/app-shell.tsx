'use client';

import { useCallback, useRef, useState } from 'react';
import { MapPin, MousePointer2 } from 'lucide-react';

import { AnalysisPanel } from '@/components/app/analysis-panel';
import { ComingSoon } from '@/components/app/coming-soon';
import { LeftSidebar, type WorkspaceSection } from '@/components/app/left-sidebar';
import { MapLayerControl } from '@/components/app/map-layer-control';
import { TopBar } from '@/components/app/top-bar';
import { MapView } from '@/components/map/map-view';
import type { MapFocusRequest } from '@/components/map/map-types';
import { validateCoordinates, type Coordinates } from '@/lib/domain/coordinates';
import {
  MAP_LAYER_IDS,
  type MapLayerId,
  type SelectedLocation,
} from '@/lib/domain/map-location';
import { DEFAULT_SELECTED_LOCATION } from '@/lib/data/demo-locations';

export function AppShell() {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('Map');
  const [visibleLayers, setVisibleLayers] = useState<MapLayerId[]>([...MAP_LAYER_IDS]);
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation>(
    DEFAULT_SELECTED_LOCATION,
  );
  const [radiusMeters, setRadiusMeters] = useState(1_000);
  const [focusRequest, setFocusRequest] = useState<MapFocusRequest | null>(null);
  const focusRequestId = useRef(0);
  const candidateNumber = useRef(1);

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
    candidateNumber.current += 1;
    setSelectedLocation({
      id: `candidate-${candidateNumber.current}`,
      name: `Candidate site ${String(candidateNumber.current).padStart(2, '0')}`,
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

  return (
    <div className="app-shell flex h-dvh min-h-[600px] w-full overflow-hidden">
      <LeftSidebar activeSection={activeSection} onNavigate={setActiveSection} />
      <div className="workspace-column">
        <TopBar onSelectLocation={handleSearchSelect} />

        {activeSection === 'Map' ? (
          <main className="map-workspace">
            <section aria-label="Tashkent map workspace" className="map-stage">
              <MapView
                focusRequest={focusRequest}
                onCreateCandidate={handleMapCreateCandidate}
                onSelectLocation={handleMapSelect}
                radiusMeters={radiusMeters}
                selectedLocation={selectedLocation}
                visibleLayers={visibleLayers}
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
                onToggleLayer={handleToggleLayer}
                visibleLayers={visibleLayers}
              />
              <div className="map-instruction">
                <MousePointer2 aria-hidden="true" size={14} strokeWidth={1.8} />
                Click the map to place a candidate site
              </div>
              <div className="map-attribution-note">Illustrative locations · synthetic pilot data</div>
            </section>
            <AnalysisPanel
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
