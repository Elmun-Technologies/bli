import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeHeader,
  rawValueFor,
  suggestColumnMapping,
  validateColumnMapping,
  type ColumnMapping,
} from './column-mapping';

test('mapping: English headings are suggested exactly', () => {
  const { suggested, suggestions } = suggestColumnMapping(
    ['Customer Name', 'Phone', 'Address', 'Latitude', 'Longitude', 'Revenue', 'Orders', 'Segment'],
    'customers',
  );

  assert.deepEqual(suggested, {
    'Customer Name': 'name',
    Phone: 'phone',
    Address: 'address',
    Latitude: 'latitude',
    Longitude: 'longitude',
    Revenue: 'revenue',
    Orders: 'order_count',
    Segment: 'segment',
  });
  assert.ok(suggestions.every((suggestion) => suggestion.confidence === 'exact'));
});

test('mapping: Uzbek Latin and Cyrillic headings are both recognized', () => {
  const uzbek = suggestColumnMapping(
    ['Mijoz', 'Telefon', 'Manzil', 'Kenglik', 'Uzunlik', 'Savdo', 'Buyurtma', 'Sana'],
    'customers',
  ).suggested;
  assert.deepEqual(uzbek, {
    Mijoz: 'name',
    Telefon: 'phone',
    Manzil: 'address',
    Kenglik: 'latitude',
    Uzunlik: 'longitude',
    Savdo: 'revenue',
    Buyurtma: 'order_count',
    Sana: 'last_order_date',
  });

  const cyrillic = suggestColumnMapping(
    ['Клиент', 'Телефон', 'Адрес', 'Широта', 'Долгота', 'Выручка', 'Заказы', 'Сегмент'],
    'customers',
  ).suggested;
  assert.deepEqual(cyrillic, {
    Клиент: 'name',
    Телефон: 'phone',
    Адрес: 'address',
    Широта: 'latitude',
    Долгота: 'longitude',
    Выручка: 'revenue',
    Заказы: 'order_count',
    Сегмент: 'segment',
  });
});

test('mapping: a field is never suggested twice, and partial matches are only offered', () => {
  const { suggested, suggestions } = suggestColumnMapping(
    ['Name', 'Client', 'Цена клиента'],
    'customers',
  );
  assert.deepEqual(suggested, { Name: 'name' });
  const statuses = Object.fromEntries(suggestions.map((s) => [s.header, s.confidence]));
  assert.equal(statuses.Client, 'none');
  assert.equal(statuses.Name, 'exact');
  assert.ok(!Object.values(suggested).includes('phone'));
});

test('mapping: headers are normalized before matching', () => {
  assert.equal(normalizeHeader('  Phone_Number  '), 'phone number');
  assert.equal(normalizeHeader('Адрес-доставки'), 'адрес доставки');
  assert.equal(normalizeHeader('E-mail / Aloqa'), 'e mail aloqa');

  const { suggested } = suggestColumnMapping(['PHONE NUMBER', 'order-count'], 'customers');
  assert.equal(suggested['PHONE NUMBER'], 'phone');
  assert.equal(suggested['order-count'], 'order_count');
});

test('mapping: validation rejects unknown, duplicated and missing spatial fields', () => {
  const unknownField = validateColumnMapping({ A: 'name', B: 'not_a_field' as never }, 'customers');
  assert.equal(unknownField.ok, false);
  assert.match(unknownField.errors.join(' '), /not a customers field/);

  const duplicateField = validateColumnMapping(
    { A: 'latitude', B: 'latitude', C: 'name' },
    'customers',
  );
  assert.equal(duplicateField.ok, false);
  assert.match(duplicateField.errors.join(' '), /Both "A" and "B"/);

  const halfCoordinate = validateColumnMapping({ A: 'latitude' }, 'customers');
  assert.equal(halfCoordinate.ok, false);
  assert.match(halfCoordinate.errors.join(' '), /both Latitude and Longitude/);

  const noSpatialInput = validateColumnMapping({ A: 'name' }, 'locations');
  assert.equal(noSpatialInput.ok, false);
  assert.match(noSpatialInput.errors.join(' '), /Latitude and Longitude, or an Address/);

  const fine = validateColumnMapping({ A: 'name', B: 'address' }, 'locations');
  assert.equal(fine.ok, true);
});

test('mapping: customers accept coordinates, an address, or both', () => {
  assert.equal(validateColumnMapping({ A: 'latitude', B: 'longitude' }, 'customers').ok, true);
  assert.equal(validateColumnMapping({ A: 'address' }, 'customers').ok, true);
  assert.equal(
    validateColumnMapping({ A: 'latitude', B: 'longitude', C: 'address' }, 'customers').ok,
    true,
  );
});

test('raw values are read back through the mapping, never by canonical guesswork', () => {
  const mapping: ColumnMapping = { Mijoz: 'name', Savdo: 'revenue', Manzil: 'address' };
  const raw = { Mijoz: 'Ali Valiyev', Savdo: '1250000.50', Manzil: 'Toshkent, Amir Temur 1', Izoh: 'private note' };

  assert.equal(rawValueFor(mapping, raw, 'name'), 'Ali Valiyev');
  assert.equal(rawValueFor(mapping, raw, 'revenue'), '1250000.50');
  assert.equal(rawValueFor(mapping, raw, 'address'), 'Toshkent, Amir Temur 1');
  // An unmapped canonical field is null: the preview can never invent a column.
  assert.equal(rawValueFor(mapping, raw, 'phone'), null);
  // A column that is not part of the mapping is never reachable.
  assert.equal(rawValueFor(mapping, raw, 'company'), null);
  // Missing and empty cells stay distinguishable at the raw level.
  assert.equal(rawValueFor(mapping, { ...raw, Mijoz: '' }, 'name'), '');
  assert.equal(rawValueFor(mapping, { Savdo: '1' }, 'name'), null);
  // Two headers mapped to one field resolve deterministically (first wins).
  assert.equal(rawValueFor({ A: 'name', B: 'name' }, { A: 'first', B: 'second' }, 'name'), 'first');
});
