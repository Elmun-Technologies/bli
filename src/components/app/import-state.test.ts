import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSummary,
  canAdvance,
  committableRows,
  EMPTY_COUNTERS,
  geocodingComplete,
  IMPORT_STEPS,
  jobStatusLabel,
  nextStep,
  pendingGeocodingRows,
  previousStep,
  stepForJobStatus,
  stepIndex,
} from './import-state';

test('wizard: the six steps are in the documented order', () => {
  assert.deepEqual([...IMPORT_STEPS], ['upload', 'columns', 'mapping', 'validation', 'geocoding', 'commit']);
  assert.equal(stepIndex('upload'), 0);
  assert.equal(stepIndex('commit'), 5);
  assert.equal(nextStep('upload'), 'columns');
  assert.equal(previousStep('commit'), 'geocoding');
  assert.equal(nextStep('commit'), 'commit', 'the last step is a fixed point');
  assert.equal(previousStep('upload'), 'upload');
});

test('wizard: a step cannot be skipped past what the user has actually done', () => {
  const nothing = {
    hasFile: false,
    hasHeaders: false,
    awaitingSheet: false,
    mappingApplied: false,
    validated: false,
  };
  assert.equal(canAdvance('upload', nothing), false);
  assert.equal(canAdvance('columns', nothing), false);
  assert.equal(canAdvance('mapping', nothing), false);
  assert.equal(canAdvance('validation', nothing), false);
  assert.equal(canAdvance('geocoding', nothing), true);

  assert.equal(canAdvance('upload', { ...nothing, hasFile: true }), true);
  assert.equal(canAdvance('columns', { ...nothing, hasFile: true, hasHeaders: true }), true);
  assert.equal(
    canAdvance('columns', { ...nothing, hasFile: true, hasHeaders: true, awaitingSheet: true }),
    false,
    'a workbook with several sheets needs a choice first',
  );
  assert.equal(canAdvance('mapping', { ...nothing, hasFile: true, hasHeaders: true, mappingApplied: true }), true);
  assert.equal(
    canAdvance('validation', { ...nothing, hasFile: true, hasHeaders: true, validated: true }),
    true,
  );
  assert.equal(canAdvance('commit', { ...nothing, validated: true }), false, 'commit is driven by the button');
});

test('wizard: counters drive the geocoding progress and the commit count', () => {
  const counters = {
    ...EMPTY_COUNTERS,
    totalRows: 10,
    validRows: 7,
    invalidRows: 2,
    needsGeocodingRows: 1,
    geocodedRows: 3,
    failedGeocodingRows: 0,
    committedRows: 4,
  };

  assert.equal(pendingGeocodingRows(counters), 1);
  assert.equal(committableRows(counters), 3);
  assert.equal(geocodingComplete(counters), false);
  assert.equal(geocodingComplete({ ...counters, needsGeocodingRows: 0 }), true);
});

test('wizard: the summary reports every outcome the brief asks for', () => {
  const summary = buildSummary({
    counters: {
      ...EMPTY_COUNTERS,
      totalRows: 10,
      validRows: 9,
      invalidRows: 1,
      needsGeocodingRows: 0,
      committedRows: 9,
      failedGeocodingRows: 0,
    },
    geocodedRows: 5,
    coordinatesSupplied: 4,
    datasetCreated: true,
    destination: 'Tashkent customers (March)',
  });

  assert.equal(summary.imported, 9);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.geocoded, 5);
  assert.equal(summary.coordinatesSupplied, 4);
  assert.equal(summary.datasetCreated, true);
  assert.equal(summary.destination, 'Tashkent customers (March)');
});

test('wizard: resuming an import opens the step that matches its status', () => {
  assert.equal(stepForJobStatus('uploaded', false), 'columns');
  assert.equal(stepForJobStatus('mapping_required', false), 'mapping');
  assert.equal(stepForJobStatus('mapping_required', true), 'validation');
  assert.equal(stepForJobStatus('review_required', true), 'validation');
  assert.equal(stepForJobStatus('ready', true), 'commit');
  assert.equal(stepForJobStatus('completed', true), 'commit');
  assert.equal(stepForJobStatus('failed', true), 'upload');
});

test('wizard: statuses read as plain language, never as enum values', () => {
  assert.equal(jobStatusLabel('uploaded'), 'File uploaded');
  assert.equal(jobStatusLabel('mapping_required'), 'Mapping needed');
  assert.equal(jobStatusLabel('ready'), 'Ready to import');
  assert.equal(jobStatusLabel('review_required'), 'Needs review');
  assert.equal(jobStatusLabel('completed'), 'Completed');
  assert.equal(jobStatusLabel('failed'), 'Failed');
});
