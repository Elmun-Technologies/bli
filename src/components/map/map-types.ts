import type { Coordinates } from '@/lib/domain/coordinates';
import type { MapLayerId, SelectedLocation } from '@/lib/domain/map-location';
import type { DataSourceMode } from '@/lib/spatial/data-source';
import type { SafeMapFeature, ViewportFeatureMetadata } from '@/lib/spatial/contracts';

export interface MapFocusRequest {
  id: number;
  location: SelectedLocation;
}

export type MapDataStatus =
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'empty'
  | 'too-broad'
  | 'error';

export interface MapDataState {
  status: MapDataStatus;
  dataSource: DataSourceMode;
  featureCount: number;
  truncated: boolean;
  message: string | null;
}

export interface MapViewportSnapshot {
  features: SafeMapFeature[];
  meta: ViewportFeatureMetadata;
}

export interface MapViewProps {
  visibleLayers: MapLayerId[];
  selectedLocation: SelectedLocation;
  radiusMeters: number;
  focusRequest: MapFocusRequest | null;
  dataSource: DataSourceMode;
  /**
   * Set on the authenticated workspace route only. When present the map reads
   * from `/api/workspaces/{workspaceId}/...`, which re-validates the session and
   * membership server-side; when absent it uses the fixed public demo path.
   */
  workspaceId?: string;
  onSelectLocation: (location: SelectedLocation) => void;
  onCreateCandidate: (coordinates: Coordinates) => void;
  onFeaturesLoaded: (snapshot: MapViewportSnapshot) => void;
  onDataStateChange: (state: MapDataState) => void;
}
