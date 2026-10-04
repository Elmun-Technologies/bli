import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDLE_ANALYSIS_STATE,
  analysisSourceLabel,
  resolveAnalysisState,
  type AnalysisState,
} from './analysis-state';
import type { AnalysisPanelView } from '@/lib/spatial/analysis-view';

const view: AnalysisPanelView = {
  radiusLabel: '1 km',
  metrics: [
    { id: 'customers', label: 'Customers', value: '120' },
    { id: 'revenue', label: 'Customer revenue', value: '8,213.40' },
    { id: 'competitors', label: 'Competitors', value: '24' },
    { id: 'branches', label: 'Branches', value: '9' },
    { id: 'places', label: 'Commercial POIs', value: '40' },
  ],
  nearestBranch: { name: 'Synthetic branch 000', distance: '240 m' },
  categories: [{ key: 'places:retail', label: 'retail (POI)', count: '40' }],
};

test('completed analysis for the current candidate and radius is not stale', () => {
  const state: AnalysisState = {
    status: 'ready',
    view,
    errorMessage: null,
    key: '69.279700:41.311100:1000',
    stale: false,
  };

  assert.equal(resolveAnalysisState(state, '69.279700:41.311100:1000').stale, false);
});

test('changing only the radius marks previous metrics stale without discarding them', () => {
  const state: AnalysisState = {
    status: 'ready',
    view,
    errorMessage: null,
    key: '69.279700:41.311100:1000',
    stale: false,
  };

  const resolved = resolveAnalysisState(state, '69.279700:41.311100:3000');

  assert.equal(resolved.stale, true);
  assert.deepEqual(resolved.view, view);
  assert.equal(analysisSourceLabel('database', resolved), 'POSTGIS · STALE');
});

test('changing the candidate marks previous metrics stale', () => {
  const state: AnalysisState = {
    status: 'ready',
    view,
    errorMessage: null,
    key: '69.279700:41.311100:1000',
    stale: false,
  };

  assert.equal(resolveAnalysisState(state, '69.280000:41.311100:1000').stale, true);
});

test('idle analysis stays idle and never reports stale metrics', () => {
  const resolved = resolveAnalysisState(IDLE_ANALYSIS_STATE, '69.279700:41.311100:1000');

  assert.equal(resolved.status, 'idle');
  assert.equal(resolved.stale, false);
  assert.equal(resolved.view, null);
});

test('data source labels tell developers which mode is active', () => {
  assert.equal(analysisSourceLabel('database', IDLE_ANALYSIS_STATE), 'POSTGIS · DEMO WORKSPACE');
  assert.equal(analysisSourceLabel('fixtures', IDLE_ANALYSIS_STATE), 'FIXTURES · ANALYSIS DISABLED');
  assert.equal(
    analysisSourceLabel('database', {
      status: 'ready',
      view,
      errorMessage: null,
      key: 'a',
      stale: false,
    }),
    'POSTGIS · SERVER ANALYZED',
  );
});
