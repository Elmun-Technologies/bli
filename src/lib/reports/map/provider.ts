/**
 * The static-map abstraction used by report generation.
 *
 * PDF generation must never depend on a browser: MapLibre remains the
 * application's interactive map, while reports embed a static image produced by
 * a provider. The provider only ever receives aggregate report data — candidate
 * labels, coordinates and the analysis radius — and never a customer point, so
 * the PII boundary holds across the network boundary too.
 *
 * Two implementations exist:
 *   - MapboxReportMapProvider  production, Mapbox Static Images API
 *   - FakeReportMapProvider    deterministic fixture bytes for tests and CI
 */

export type ReportMapMimeType = 'image/png' | 'image/jpeg';

export interface ReportMapMarker {
  /** Presentation label: A..E for a comparison, a single letter for one site. */
  label: string;
  longitude: number;
  latitude: number;
}

export interface ReportMapRequestBase {
  markers: ReportMapMarker[];
  width: number;
  height: number;
  /** Suggested zoom when there is exactly one marker. */
  zoom?: number;
  /** Extra padding in pixels around the fitted markers. */
  padding?: number;
}

export interface SingleLocationMapRequest extends ReportMapRequestBase {
  /** Radius drawn around the single marker, in meters. */
  radiusMeters: number;
}

export interface ComparisonMapRequest extends ReportMapRequestBase {
  /** Radius shared by every marker, in meters. */
  radiusMeters: number;
}

export interface ReportMapResult {
  bytes: Uint8Array;
  mimeType: ReportMapMimeType;
  /** Provider name, stored in the snapshot when the report is created. */
  provider: string;
  /** Attribution text the report must print. */
  attribution: string;
  width: number;
  height: number;
}

export interface ReportMapProvider {
  readonly name: string;
  /** The attribution this provider's imagery legally requires. */
  readonly attribution: string;
  readonly available: boolean;
  renderSingleLocationMap(request: SingleLocationMapRequest): Promise<ReportMapResult>;
  renderComparisonMap(request: ComparisonMapRequest): Promise<ReportMapResult>;
}

/** A provider failure that must never corrupt a report snapshot. */
export class ReportMapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportMapError';
  }
}

/** A stable, documented attribution line for a provider-less report. */
export const NO_MAP_ATTRIBUTION =
  'No static map was included in this report. Every figure comes from the stored analysis.';
