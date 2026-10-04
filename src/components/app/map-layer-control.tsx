'use client';

import { useState } from 'react';
import { Check, ChevronDown, Layers3 } from 'lucide-react';

import { MAP_LAYERS } from '@/lib/data/demo-locations';
import type { MapLayerId } from '@/lib/domain/map-location';
import type { DataSourceMode } from '@/lib/spatial/data-source';

interface MapLayerControlProps {
  visibleLayers: MapLayerId[];
  layerCounts: Record<MapLayerId, number>;
  dataSource: DataSourceMode;
  onToggleLayer: (layer: MapLayerId) => void;
}

export function MapLayerControl({
  visibleLayers,
  layerCounts,
  dataSource,
  onToggleLayer,
}: MapLayerControlProps) {
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
            <span>{dataSource === 'database' ? 'POSTGIS VIEWPORT' : 'DEMO FIXTURES'}</span>
          </div>
          {MAP_LAYERS.map((layer) => {
            const isVisible = visibleLayers.includes(layer.id);
            const count = layerCounts[layer.id] ?? 0;

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
          <p className="map-layer-menu__note">
            {dataSource === 'database'
              ? 'Counts cover the loaded viewport only; the server caps results per request.'
              : 'Fixture preview mode: display-only data, no PostGIS analysis.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
