import type { Coordinates } from '@/lib/domain/coordinates';

import type { RadiusAnalysisDTO } from './contracts';

export interface AnalysisMetricRow {
  id: 'customers' | 'revenue' | 'competitors' | 'branches' | 'places';
  label: string;
  value: string;
}

export interface AnalysisCategoryRow {
  key: string;
  label: string;
  count: string;
}

export interface AnalysisPanelView {
  radiusLabel: string;
  metrics: AnalysisMetricRow[];
  nearestBranch: {
    name: string;
    distance: string;
  } | null;
  categories: AnalysisCategoryRow[];
}

export const UNAVAILABLE_VALUE = '—';

export function analysisKey(coordinates: Coordinates, radiusMeters: number): string {
  return `${coordinates[0].toFixed(6)}:${coordinates[1].toFixed(6)}:${radiusMeters}`;
}

export function formatRadius(radiusMeters: number): string {
  if (radiusMeters < 1_000) return `${radiusMeters} m`;

  const kilometers = radiusMeters / 1_000;
  return `${Number.isInteger(kilometers) ? kilometers : kilometers.toFixed(1)} km`;
}

/** Group digits on the exact decimal string; never convert currency to float. */
export function formatExactDecimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return UNAVAILABLE_VALUE;

  const [, sign, integerPart, fractionPart] = match;
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fractionPart ? `.${fractionPart}` : ''}`;
}

export function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return UNAVAILABLE_VALUE;
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDistanceMeters(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return UNAVAILABLE_VALUE;
  if (distanceMeters < 1_000) return `${Math.round(distanceMeters)} m`;

  const kilometers = distanceMeters / 1_000;
  return `${kilometers < 10 ? kilometers.toFixed(1) : Math.round(kilometers)} km`;
}

/** Map the validated server DTO into panel rows. Pure and unit-testable. */
export function toAnalysisPanelView(analysis: RadiusAnalysisDTO): AnalysisPanelView {
  const categories = [...analysis.categoryDistribution]
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .map((category) => ({
      key: `${category.kind}:${category.category}`,
      label: `${category.category} (${category.kind === 'places' ? 'POI' : 'competitor'})`,
      count: formatCount(category.count),
    }));

  return {
    radiusLabel: formatRadius(analysis.radiusMeters),
    metrics: [
      { id: 'customers', label: 'Customers', value: formatCount(analysis.customersCount) },
      {
        id: 'revenue',
        label: 'Customer revenue',
        value: formatExactDecimal(analysis.customersRevenueTotal),
      },
      { id: 'competitors', label: 'Competitors', value: formatCount(analysis.competitorsCount) },
      { id: 'branches', label: 'Branches', value: formatCount(analysis.branchesCount) },
      { id: 'places', label: 'Commercial POIs', value: formatCount(analysis.locationsCount) },
    ],
    nearestBranch: analysis.nearestBranch
      ? {
          name: analysis.nearestBranch.name,
          distance: formatDistanceMeters(analysis.nearestBranch.distanceMeters),
        }
      : null,
    categories,
  };
}
