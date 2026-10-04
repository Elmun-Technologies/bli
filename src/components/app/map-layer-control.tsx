'use client';

import { useState } from 'react';
import { Check, ChevronDown, Layers3 } from 'lucide-react';

import { DEMO_LOCATIONS, MAP_LAYERS } from '@/lib/data/demo-locations';
import type { MapLayerId } from '@/lib/domain/map-location';

interface MapLayerControlProps {
  visibleLayers: MapLayerId[];
  onToggleLayer: (layer: MapLayerId) => void;
}

export function MapLayerControl({ visibleLayers, onToggleLayer }: MapLayerControlProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="map-layer-control">
      <button
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="map-layer-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <Layers3 aria-hidden="true" size={16} strokeWidth={1.8} />
        <span>Map layers</span>
        <span className="map-layer-trigger__count">{visibleLayers.length}</span>
        <ChevronDown aria-hidden="true" className={isOpen ? 'is-rotated' : ''} size={14} />
      </button>

      {isOpen ? (
        <div className="map-layer-menu" role="group" aria-label="Visible map layers">
          <div className="map-layer-menu__header">
            <span>Visible layers</span>
            <span>DEMO FIXTURES</span>
          </div>
          {MAP_LAYERS.map((layer) => {
            const isVisible = visibleLayers.includes(layer.id);
            const count = DEMO_LOCATIONS.filter((location) => location.kind === layer.id).length;

            return (
              <button
                aria-pressed={isVisible}
                className={`map-layer-option${isVisible ? ' is-visible' : ''}`}
                key={layer.id}
                onClick={() => onToggleLayer(layer.id)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="map-layer-option__swatch"
                  style={{ '--layer-color': layer.color } as React.CSSProperties}
                />
                <span className="map-layer-option__copy">
                  <span className="map-layer-option__name">{layer.label}</span>
                  <span className="map-layer-option__description">{layer.description}</span>
                </span>
                <span className="map-layer-option__count">{count}</span>
                <span className={`map-layer-option__check${isVisible ? ' is-visible' : ''}`}>
                  {isVisible ? <Check aria-hidden="true" size={12} strokeWidth={2.6} /> : null}
                </span>
              </button>
            );
          })}
          <p className="map-layer-menu__note">All locations shown here are synthetic pilot data.</p>
        </div>
      ) : null}
    </div>
  );
}
