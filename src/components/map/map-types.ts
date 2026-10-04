import type { Coordinates } from '@/lib/domain/coordinates';
import type { MapLayerId, SelectedLocation } from '@/lib/domain/map-location';

export interface MapFocusRequest {
  id: number;
  location: SelectedLocation;
}

export interface MapViewProps {
  visibleLayers: MapLayerId[];
  selectedLocation: SelectedLocation;
  radiusMeters: number;
  focusRequest: MapFocusRequest | null;
  onSelectLocation: (location: SelectedLocation) => void;
  onCreateCandidate: (coordinates: Coordinates) => void;
}
