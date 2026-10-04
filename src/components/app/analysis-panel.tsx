'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  CircleHelp,
  Crosshair,
  Database,
  FlaskConical,
  Landmark,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Store,
  TriangleAlert,
  UsersRound,
  Wallet,
} from 'lucide-react';

import type { SelectedLocation } from '@/lib/domain/map-location';
import type { DataSourceMode } from '@/lib/spatial/data-source';
import { formatRadius } from '@/lib/spatial/analysis-view';
import type { AnalysisState } from '@/components/app/analysis-state';
import { analysisSourceLabel } from '@/components/app/analysis-state';
import type { MapDataState } from '@/components/map/map-types';

const RADIUS_PRESETS = [500, 1_000, 3_000, 5_000] as const;
const MIN_CUSTOM_RADIUS = 100;
const MAX_CUSTOM_RADIUS = 20_000;

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
  dataSource: DataSourceMode;
  analysis: AnalysisState;
  mapDataState: MapDataState;
  onAnalyze: () => void;
}

function mapDataStateLabel(mapDataState: MapDataState): string {
  const source = mapDataState.dataSource === 'database' ? 'PostGIS' : 'Fixtures';
  if (mapDataState.status === 'error') return `${source} · map data failed`;
  if (mapDataState.status === 'loading') return `${source} · loading viewport`;
  if (mapDataState.status === 'refreshing') return `${source} · refreshing viewport`;
  if (mapDataState.status === 'too-broad') return `${source} · zoom in`;

  return `${source} · ${mapDataState.featureCount} features in view${
    mapDataState.truncated ? ' (capped)' : ''
  }`;
}

export function AnalysisPanel({
  selectedLocation,
  radiusMeters,
  onRadiusChange,
  dataSource,
  analysis,
  mapDataState,
  onAnalyze,
}: AnalysisPanelProps) {
  const [customRadiusInput, setCustomRadiusInput] = useState(false);
  const isPresetRadius = RADIUS_PRESETS.some((preset) => preset === radiusMeters);
  const showCustomRadius = customRadiusInput || !isPresetRadius;
  const view = analysis.view;
  const isAnalyzing = analysis.status === 'loading';
  const showStaleResults = Boolean(view) && analysis.stale;

  function activateCustomRadius() {
    setCustomRadiusInput(true);
    if (isPresetRadius) onRadiusChange(2_000);
  }

  return (
    <aside aria-label="Location analysis panel" className="analysis-panel">
      <div className="analysis-panel__header">
        <div>
          <p className="section-eyebrow">SITE ANALYSIS</p>
          <h1>Location overview</h1>
        </div>
        <span className="preview-badge">
          {dataSource === 'database' ? 'POSTGIS' : 'FIXTURES'}
        </span>
      </div>

      <p
        className={`map-data-source-strip map-data-source-strip--${mapDataState.status}`}
        data-testid="map-data-source"
      >
        <Database aria-hidden="true" size={12} />
        {mapDataStateLabel(mapDataState)}
      </p>

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
            <p>Visual ring only · PostGIS runs the maths</p>
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

        <button
          className="analyze-button"
          disabled={isAnalyzing || dataSource !== 'database'}
          onClick={onAnalyze}
          type="button"
        >
          {isAnalyzing ? (
            <LoaderCircle aria-hidden="true" className="analyze-button__spinner" size={15} />
          ) : view && !analysis.stale ? (
            <RefreshCw aria-hidden="true" size={15} />
          ) : null}
          {isAnalyzing
            ? 'Analyzing in PostGIS…'
            : dataSource !== 'database'
              ? 'Analysis requires database mode'
              : 'Analyze this radius'}
        </button>
        {showStaleResults ? (
          <p className="analysis-stale-note" role="status">
            <TriangleAlert aria-hidden="true" size={13} />
            Radius or candidate changed · run the analysis again for authoritative numbers.
          </p>
        ) : null}
      </section>

      <div className="analysis-preview-note">
        <CircleHelp aria-hidden="true" size={16} strokeWidth={1.8} />
        <p>
          <strong>The ring is visual only.</strong> Counts, nearest branch and revenue come from
          meter-based PostGIS <code>ST_DWithin</code> queries, never from browser geometry.
        </p>
      </div>

      <section aria-labelledby="metrics-title" className="analysis-section metrics-section">
        <div className="section-heading-row section-heading-row--metrics">
          <div>
            <h2 id="metrics-title">
              {view ? `Within ${view.radiusLabel}` : `Within ${formatRadius(radiusMeters)}`}
            </h2>
            <p>
              {analysis.status === 'error'
                ? 'Analysis failed'
                : view
                  ? 'Server-side PostGIS aggregates'
                  : 'Not analyzed yet'}
            </p>
          </div>
          <span className="metrics-lock" title={analysisSourceLabel(dataSource, analysis)}>
            {dataSource === 'database' ? (
              <Database aria-hidden="true" size={15} />
            ) : (
              <FlaskConical aria-hidden="true" size={15} />
            )}
          </span>
        </div>

        {analysis.status === 'error' ? (
          <div className="analysis-error" role="alert">
            <TriangleAlert aria-hidden="true" size={15} />
            <p>{analysis.errorMessage ?? 'The radius analysis could not be completed.'}</p>
          </div>
        ) : null}

        <div className={`metric-grid${showStaleResults ? ' is-stale' : ''}`}>
          <MetricCard
            icon={UsersRound}
            label="Customers"
            value={view?.metrics.find((metric) => metric.id === 'customers')?.value}
          />
          <MetricCard
            icon={Wallet}
            label="Customer revenue"
            value={view?.metrics.find((metric) => metric.id === 'revenue')?.value}
          />
          <MetricCard
            icon={Store}
            label="Competitors"
            value={view?.metrics.find((metric) => metric.id === 'competitors')?.value}
          />
          <MetricCard
            icon={Landmark}
            label="Commercial POIs"
            value={view?.metrics.find((metric) => metric.id === 'places')?.value}
          />
        </div>

        <div className={`analysis-submetrics${showStaleResults ? ' is-stale' : ''}`}>
          <div className="analysis-submetric">
            <span>Branches</span>
            <strong>{view?.metrics.find((metric) => metric.id === 'branches')?.value ?? '—'}</strong>
          </div>
          <div className="analysis-submetric">
            <span>Nearest branch</span>
            <strong>
              {view?.nearestBranch
                ? `${view.nearestBranch.distance} · ${view.nearestBranch.name}`
                : '—'}
            </strong>
          </div>
        </div>

        {view && view.categories.length > 0 ? (
          <div className={`analysis-categories${showStaleResults ? ' is-stale' : ''}`}>
            <h3>Category breakdown</h3>
            <ul>
              {view.categories.map((category) => (
                <li key={category.key}>
                  <span>{category.label}</span>
                  <strong>{category.count}</strong>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
          A configurable, explainable scoring model will be added in a later phase; Phase 3 only
          returns observed PostGIS aggregates.
        </p>
        <button className="score-preview-card__link" disabled type="button">
          Explore score inputs <ArrowUpRight aria-hidden="true" size={14} />
        </button>
      </section>

      <div className="analysis-panel__footer">
        <span className="analysis-panel__source">{analysisSourceLabel(dataSource, analysis)}</span>
        <span>
          <ShieldCheck aria-hidden="true" size={11} /> Synthetic demo data
        </span>
      </div>
    </aside>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersRound;
  label: string;
  value?: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card__topline">
        <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
      </div>
      <span className="metric-card__value">{value ?? '—'}</span>
      <span className="metric-card__label">{label}</span>
    </div>
  );
}
