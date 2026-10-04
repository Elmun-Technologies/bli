import assert from 'node:assert/strict';
import test from 'node:test';

import { DATA_SOURCE_MODES, resolveDataSourceMode } from './data-source';

test('database mode is the explicit default', () => {
  assert.equal(resolveDataSourceMode(undefined), 'database');
  assert.equal(resolveDataSourceMode(''), 'database');
  assert.equal(resolveDataSourceMode('database'), 'database');
});

test('fixture mode must be requested explicitly', () => {
  assert.equal(resolveDataSourceMode('fixtures'), 'fixtures');
});

test('an unknown data source never falls back to fixtures or database silently', () => {
  assert.throws(() => resolveDataSourceMode('fixture'), /DATA_SOURCE/);
  assert.throws(() => resolveDataSourceMode('postgis'), /DATA_SOURCE/);
});

test('both supported modes are declared for the UI', () => {
  assert.deepEqual([...DATA_SOURCE_MODES], ['database', 'fixtures']);
});
