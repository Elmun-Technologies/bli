'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  CircleHelp,
  Crosshair,
  Landmark,
  MapPin,
  ShieldCheck,
  Store,
  UsersRound,
  Wallet,
} from 'lucide-react';

import type { SelectedLocation } from '@/lib/domain/map-location';

const RADIUS_PRESETS = [500, 1_000, 3_000, 5_000] as const;
const MIN_CUSTOM_RADIUS = 100;
const MAX_CUSTOM_RADIUS = 50_000;

function formatRadius(radiusMeters: number): string {
  if (radiusMeters < 1_000) return `${radiusMeters} m`;

  const kilometers = radiusMeters / 1_000;
  return `${Number.isInteger(kilometers) ? kilometers : kilometers.toFixed(1)} km`;
}

function formatCoordinate(value: number, axis: 'latitude' | 'longitude'): string {
  const hemisphere = axis === 'latitude'
    ? value < 0 ? 'S' : 'N'
    : value < 0 ? 'W' : 'E';

  return `${Math.abs(value).toFixed(5)}° ${hemisphere}`;
}

interface AnalysisPanelProps {
  selectedLocation: SelectedLocation;
  radiusMeters: number;
  onRadiusChange: (radiusMeters: number) => void;
}

export function AnalysisPanel({
  selectedLocation,
  radiusMeters,
  onRadiusChange,
}: AnalysisPanelProps) {
  const [customRadiusInput, setCustomRadiusInput] = useState(false);
  const isPresetRadius = RADIUS_PRESETS.some((preset) => preset === radiusMeters);
  const showCustomRadius = customRadiusInput || !isPresetRadius;

  function activateCustomRadius() {
    setCustomRadiusInput(true);
    if (isPresetRadius) onRadiusChange(2_000);
  }

  return (
    <aside aria-label="Location analysis preview" className="analysis-panel">
      <div className="analysis-panel__header">
        <div>
          <p className="section-eyebrow">SITE ANALYSIS</p>
          <h1>Location overview</h1>
        </div>
        <span className="preview-badge">PREVIEW</span>
      </div>

      <section aria-labelledby="selected-location-title" className="selected-location-card">
        <div className="selected-location-card__topline">
          <span className={`selected-location-icon selected-location-icon--${selectedLocation.kind}`}>
            {selectedLocation.kind === 'candidate' ? (
              <Crosshair aria-hidden="true" size={17} strokeWidth={1.9} />
            ) : (
              <MapPin aria-hidden="true" size={17} strokeWidth={1.9} />
            )}
          </span>
          <span className="selected-location-card__kind">{selectedLocation.category}</span>
          <span className="selected-location-card__status">
            <span aria-hidden="true" />
            Selected
          </span>
        </div>
        <h2 id="selected-location-title">{selectedLocation.name}</h2>
        <p className="selected-location-card__address">{selectedLocation.address}</p>
        <p className="selected-location-card__coordinates">
          {formatCoordinate(selectedLocation.coordinates[1], 'latitude')}
          <span>·</span>
          {formatCoordinate(selectedLocation.coordinates[0], 'longitude')}
        </p>
      </section>

      <section aria-labelledby="radius-title" className="analysis-section">
        <div className="section-heading-row">
          <div>
            <h2 id="radius-title">Analysis radius</h2>
            <p>Ring preview around the selected point</p>
          </div>
          <span className="radius-current">{formatRadius(radiusMeters)}</span>
        </div>
        <div aria-label="Choose radius" className="radius-options" role="group">
          {RADIUS_PRESETS.map((preset) => (
            <button
              aria-pressed={radiusMeters === preset}
              className={`radius-option${radiusMeters === preset ? ' is-active' : ''}`}
              key={preset}
              onClick={() => {
                setCustomRadiusInput(false);
                onRadiusChange(preset);
              }}
              type="button"
            >
              {formatRadius(preset)}
            </button>
          ))}
          <button
            aria-pressed={showCustomRadius}
            className={`radius-option${showCustomRadius ? ' is-active' : ''}`}
            onClick={activateCustomRadius}
            type="button"
          >
            Custom
          </button>
        </div>
        {showCustomRadius ? (
          <label className="custom-radius-field">
            <span>Custom distance</span>
            <span className="custom-radius-field__input-wrap">
              <input
                aria-label="Custom radius in meters"
                max={MAX_CUSTOM_RADIUS}
                min={MIN_CUSTOM_RADIUS}
                onChange={(event) => {
                  const nextRadius = Number(event.target.value);
                  if (Number.isFinite(nextRadius) && nextRadius > 0) {
                    onRadiusChange(
                      Math.min(MAX_CUSTOM_RADIUS, Math.max(MIN_CUSTOM_RADIUS, nextRadius)),
                    );
                  }
                }}
                step={100}
                type="number"
                value={radiusMeters}
              />
              <span>meters</span>
            </span>
          </label>
        ) : null}
      </section>

      <div className="analysis-preview-note">
        <CircleHelp aria-hidden="true" size={16} strokeWidth={1.8} />
        <p>
          <strong>Visual preview only.</strong> The ring helps orient the map; counts and scores
          require a connected dataset and server-side PostGIS analysis.
        </p>
      </div>

      <section aria-labelledby="metrics-title" className="analysis-section metrics-section">
        <div className="section-heading-row section-heading-row--metrics">
          <div>
            <h2 id="metrics-title">Within {formatRadius(radiusMeters)}</h2>
            <p>Spatial metrics are not connected yet</p>
          </div>
          <span className="metrics-lock" title="PostGIS analysis is planned for Phase 4">
            <ShieldCheck aria-hidden="true" size={15} />
          </span>
        </div>

        <div className="metric-grid">
          <MetricCard icon={UsersRound} label="Customers" phase="Phase 5" />
          <MetricCard icon={Wallet} label="Revenue" phase="Phase 5" />
          <MetricCard icon={Store} label="Competitors" phase="Phase 2" />
          <MetricCard icon={Landmark} label="Commercial POIs" phase="Phase 2" />
        </div>
      </section>

      <section aria-labelledby="score-title" className="score-preview-card">
        <div className="score-preview-card__heading">
          <div>
            <p className="section-eyebrow">SITE POTENTIAL</p>
            <h2 id="score-title">Location score</h2>
          </div>
          <span className="score-not-ready">Not scored</span>
        </div>
        <div aria-hidden="true" className="score-preview-card__track">
          <span />
        </div>
        <p>
          A configurable, explainable scoring model will be added after spatial datasets are
          available.
        </p>
        <button className="score-preview-card__link" disabled type="button">
          Explore score inputs <ArrowUpRight aria-hidden="true" size={14} />
        </button>
      </section>

      <div className="analysis-panel__footer">
        <span>DEMO FIXTURES</span>
        <span>Not operational data</span>
      </div>
    </aside>
  );
}

function MetricCard({
  icon: Icon,
  label,
  phase,
}: {
  icon: typeof UsersRound;
  label: string;
  phase: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card__topline">
        <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
        <span>{phase}</span>
      </div>
      <span className="metric-card__value">—</span>
      <span className="metric-card__label">{label}</span>
    </div>
  );
}
