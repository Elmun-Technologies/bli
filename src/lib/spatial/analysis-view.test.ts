import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analysisKey,
  formatCount,
  formatDistanceMeters,
  formatExactDecimal,
  formatRadius,
  toAnalysisPanelView,
  UNAVAILABLE_VALUE,
} from './analysis-view';
import type { RadiusAnalysisDTO } from './contracts';

const analysis: RadiusAnalysisDTO = {
  candidate: [69.2797, 41.3111],
  radiusMeters: 3_000,
  customersCount: 1_284,
  customersRevenueTotal: '1234567.80',
  competitorsCount: 24,
  branchesCount: 9,
  locationsCount: 40,
  categoryDistribution: [
    { kind: 'places', category: 'pharmacy', count: 18 },
    { kind: 'competitors', category: 'grocery', count: 24 },
    { kind: 'places', category: 'market', count: 12 },
  ],
  nearestBranch: { id: '30000000-0000-4000-8000-000000000001', name: 'Synthetic branch 000', distanceMeters: 1_240 },
};

test('server analysis DTO maps to the panel view with exact revenue text', () => {
  const view = toAnalysisPanelView(analysis);

  assert.equal(view.radiusLabel, '3 km');
  assert.deepEqual(
    view.metrics.map((metric) => [metric.id, metric.value]),
    [
      ['customers', '1,284'],
      ['revenue', '1,234,567.80'],
      ['competitors', '24'],
      ['branches', '9'],
      ['places', '40'],
    ],
  );
  assert.deepEqual(view.nearestBranch, { name: 'Synthetic branch 000', distance: '1.2 km' });
  assert.deepEqual(view.categories, [
    { key: 'competitors:grocery', label: 'grocery (competitor)', count: '24' },
    { key: 'places:pharmacy', label: 'pharmacy (POI)', count: '18' },
    { key: 'places:market', label: 'market (POI)', count: '12' },
  ]);
});

test('panel view tolerates an empty analysis result', () => {
  const view = toAnalysisPanelView({
    candidate: [0, 0],
    radiusMeters: 500,
    customersCount: 0,
    customersRevenueTotal: '0',
    competitorsCount: 0,
    branchesCount: 0,
    locationsCount: 0,
    categoryDistribution: [],
    nearestBranch: null,
  });

  assert.equal(view.nearestBranch, null);
  assert.deepEqual(view.categories, []);
  assert.equal(view.metrics.find((metric) => metric.id === 'customers')?.value, '0');
  assert.equal(view.metrics.find((metric) => metric.id === 'revenue')?.value, '0');
});

test('exact decimal formatting never rounds or coerces to floating point', () => {
  assert.equal(formatExactDecimal('123456789012345678.99'), '123,456,789,012,345,678.99');
  assert.equal(formatExactDecimal('0'), '0');
  assert.equal(formatExactDecimal('999'), '999');
  assert.equal(formatExactDecimal('1e21'), UNAVAILABLE_VALUE);
  assert.equal(formatExactDecimal(Number.MAX_SAFE_INTEGER.toString()), '9,007,199,254,740,991');
});

test('counts, radii and distances are formatted for the panel', () => {
  assert.equal(formatCount(1_284), '1,284');
  assert.equal(formatCount(-1), UNAVAILABLE_VALUE);
  assert.equal(formatRadius(500), '500 m');
  assert.equal(formatRadius(1_500), '1.5 km');
  assert.equal(formatDistanceMeters(240.4), '240 m');
  assert.equal(formatDistanceMeters(12_400), '12 km');
  assert.equal(formatDistanceMeters(Number.NaN), UNAVAILABLE_VALUE);
});

test('analysis key changes when candidate or radius changes', () => {
  const base = analysisKey([69.2797, 41.3111], 1_000);

  assert.notEqual(base, analysisKey([69.2797, 41.3111], 3_000));
  assert.notEqual(base, analysisKey([69.28, 41.3111], 1_000));
  assert.equal(base, analysisKey([69.2797, 41.3111], 1_000));
});
