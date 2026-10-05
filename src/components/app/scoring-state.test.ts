import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analysisFreshnessMessage,
  analysisHeadline,
  mapCandidatesFromPayload,
  comparisonReady,
  selectionMessage,
  snapshotSummary,
  scoringTabLabel,
  SCORING_TABS,
  toggleCandidateSelection,
} from './scoring-state';
import { parseScoringAnalysis } from '@/lib/scoring/payload';

function payload(name: 'stored-analysis' | 'stored-comparison') {
  const url = new URL(`../../lib/scoring/__fixtures__/${name}.payload.json`, import.meta.url);
  return parseScoringAnalysis(JSON.parse(readFileSync(url, 'utf8')));
}

test('the section offers the three documented tabs', () => {
  assert.deepEqual(SCORING_TABS, ['analyze', 'compare', 'models']);
  assert.equal(scoringTabLabel('analyze'), 'Analyze a site');
  assert.equal(scoringTabLabel('compare'), 'Compare sites');
  assert.equal(scoringTabLabel('models'), 'Scoring models');
});

test('the candidate label cap is five and the selection keeps its order', () => {
  let selection: string[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    selection = toggleCandidateSelection(selection, id);
  }

  assert.deepEqual(selection, ['a', 'b', 'c', 'd', 'e']);
  selection = toggleCandidateSelection(selection, 'c');
  assert.deepEqual(selection, ['a', 'b', 'd', 'e']);
  selection = toggleCandidateSelection(selection, 'f');
  assert.ok(selection.includes('f'));
  assert.equal(selection.length, 5);
});

test('a comparison is ready between two and five sites, never outside', () => {
  assert.equal(comparisonReady(0), false);
  assert.equal(comparisonReady(1), false);
  assert.equal(comparisonReady(2), true);
  assert.equal(comparisonReady(5), true);
  assert.equal(comparisonReady(6), false);
  assert.match(selectionMessage(0), /two to five/);
  assert.match(selectionMessage(1), /one more/);
  assert.match(selectionMessage(3), /3 of 5/);
});

test('map candidates are labelled A..E in stored rank order', () => {
  const candidates = mapCandidatesFromPayload(payload('stored-comparison'));

  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ['A', 'B', 'C'],
  );
  assert.equal(candidates[0].candidateId, payload('stored-comparison').results[0].candidateId);
  assert.deepEqual(candidates[0].coordinates, [
    payload('stored-comparison').results[0].longitude,
    payload('stored-comparison').results[0].latitude,
  ]);
  assert.equal(candidates[2].score, 18.45);
});

test('the headline shows the stored score out of 100 with its band', () => {
  const headline = analysisHeadline(payload('stored-comparison'));

  assert.equal(headline?.scoreText, '34.65 / 100');
  assert.equal(headline?.band, 'Weak');
  assert.equal(headline?.candidateCount, 3);
  assert.equal(headline?.mode, 'comparison');
  assert.equal(headline?.modelName, 'Retail Expansion Model');
  assert.equal(headline?.modelVersion, 1);
  assert.equal(headline?.radiusMeters, 1_000);
});

test('the snapshot line names the model revision, radius and candidate count', () => {
  assert.equal(
    snapshotSummary(payload('stored-analysis')),
    'Retail Expansion Model · v1 · 500 m radius · 1 candidate · snapshot 2026-10-05 06:02 UTC',
  );
});

test('the freshness message appears only for a flagged snapshot', () => {
  assert.equal(analysisFreshnessMessage(payload('stored-analysis')), null);

  const flagged = payload('stored-analysis');
  flagged.analysis.mayBeOutdated = true;
  assert.match(analysisFreshnessMessage(flagged) ?? '', /may be outdated/i);
});
