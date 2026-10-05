/**
 * Column mapping: which uploaded column feeds which canonical field.
 *
 * The mapping is stored per import job as `{ "<source header>": "<field>" }`.
 * Suggestions are generated from a multilingual alias table (Uzbek Latin,
 * Russian/Cyrillic and English headings are all expected in this market) but are
 * always a starting point: the user can change every one of them, and only exact
 * alias matches are preselected. A partial match is offered, never assumed.
 */
import type { ImportTargetEntity } from './limits';

export const CANONICAL_FIELDS = [
  'name',
  'external_id',
  'phone',
  'company',
  'address',
  'latitude',
  'longitude',
  'revenue',
  'order_count',
  'last_order_date',
  'segment',
  'category',
  'subcategory',
  'source',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export type ColumnMapping = Record<string, CanonicalField>;

export type FieldKind = 'text' | 'decimal' | 'integer' | 'date' | 'coordinate';

export interface TargetFieldDefinition {
  field: CanonicalField;
  label: string;
  kind: FieldKind;
  required: boolean;
  help?: string;
}

const SHARED_TEXT: TargetFieldDefinition[] = [
  { field: 'name', label: 'Name', kind: 'text', required: false },
  { field: 'external_id', label: 'External id', kind: 'text', required: false, help: 'Deterministic duplicate checks use this value.' },
  { field: 'address', label: 'Address', kind: 'text', required: false, help: 'Rows with an address and no coordinates enter the geocoding workflow.' },
  { field: 'latitude', label: 'Latitude', kind: 'coordinate', required: false },
  { field: 'longitude', label: 'Longitude', kind: 'coordinate', required: false },
  { field: 'source', label: 'Source label', kind: 'text', required: false },
];

export const TARGET_FIELDS: Record<ImportTargetEntity, TargetFieldDefinition[]> = {
  customers: [
    { field: 'name', label: 'Customer name', kind: 'text', required: false },
    { field: 'external_id', label: 'External id', kind: 'text', required: false },
    { field: 'phone', label: 'Phone', kind: 'text', required: false, help: 'Kept as text and never shown on the map.' },
    { field: 'company', label: 'Company', kind: 'text', required: false },
    { field: 'address', label: 'Address', kind: 'text', required: false },
    { field: 'latitude', label: 'Latitude', kind: 'coordinate', required: false },
    { field: 'longitude', label: 'Longitude', kind: 'coordinate', required: false },
    { field: 'revenue', label: 'Revenue', kind: 'decimal', required: false, help: 'Exact decimal; used only in aggregates.' },
    { field: 'order_count', label: 'Order count', kind: 'integer', required: false },
    { field: 'last_order_date', label: 'Last order date', kind: 'date', required: false },
    { field: 'segment', label: 'Segment', kind: 'text', required: false },
    { field: 'source', label: 'Source label', kind: 'text', required: false },
  ],
  locations: [
    ...SHARED_TEXT,
    { field: 'category', label: 'Category', kind: 'text', required: false, help: 'Defaults to "imported" when unmapped.' },
    { field: 'subcategory', label: 'Subcategory', kind: 'text', required: false },
  ],
};

/**
 * Heading aliases, normalized (lowercase, punctuation removed). Ordered by
 * confidence: the first exact match wins.
 */
const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  name: [
    'name', 'ism', 'fio', 'full name', 'client', 'client name', 'customer', 'customer name',
    'mijoz', 'mijoz nomi', 'mijozlar', 'клиент', 'клиенты', 'имя', 'фио', 'наименование',
    'название', 'company name', 'shaxs', 'kontakt',
  ],
  external_id: [
    'id', 'external id', 'externalid', 'client id', 'clientid', 'customer id', 'code', 'kod',
    'код', 'идентификатор', 'mijoz id', 'unikal id', 'external code',
  ],
  phone: [
    'phone', 'phone number', 'telefon', 'telefon raqami', 'tel', 'mobile', 'mobile phone',
    'aloqa', 'телефон', 'мобильный', 'контакт', 'raqam',
  ],
  company: ['company', 'kompaniya', 'tashkilot', 'organization', 'organisation', 'firma', 'компания', 'организация', 'фирма'],
  address: ['address', 'manzil', 'адрес', 'yuridik manzil', 'полный адрес', 'location address', 'manzili'],
  latitude: ['latitude', 'lat', 'широта', 'kenglik', 'latituda', 'lattitude'],
  longitude: ['longitude', 'lng', 'lon', 'long', 'долгота', 'uzunlik', 'longituda', 'longtitude'],
  revenue: [
    'revenue', 'sales', 'savdo', 'savdo summasi', 'tushum', 'summa', 'amount', 'total',
    'total revenue', 'выручка', 'сумма', 'продажи', 'оборот',
  ],
  order_count: [
    'orders', 'order count', 'order_count', 'ordercount', 'buyurtma', 'buyurtmalar',
    'buyurtma soni', 'заказы', 'количество заказов', 'кол-во заказов', 'soni',
  ],
  last_order_date: [
    'last order date', 'last_order_date', 'lastorder', 'oxirgi sana', 'sana', 'date',
    'дата', 'дата заказа', 'последний заказ',
  ],
  segment: ['segment', 'segments', 'сегмент', 'toifa', 'segmenti', 'mijoz segmenti'],
  category: ['category', 'kategoriya', 'kategoriyasi', 'категория', 'tur', 'type', 'tip'],
  subcategory: ['subcategory', 'sub kategoriya', 'subkategoriya', 'подкатегория', 'sub tur'],
  source: ['source', 'manba', 'источник', 'provenance'],
};

/**
 * Reads a canonical field's original value back out of a staged row.
 *
 * `raw_data` is keyed by *source header* (the spreadsheet's own words), while
 * previews and exports present canonical fields. This inverts the stored mapping
 * so a canonical column can be read without ever exposing an unmapped column.
 * When two headers map to the same field the first one wins, deterministically.
 */
export function rawValueFor(
  mapping: ColumnMapping,
  rawData: Record<string, unknown>,
  field: CanonicalField,
): string | null {
  for (const [header, mapped] of Object.entries(mapping)) {
    if (mapped !== field) continue;
    const value = rawData[header];
    if (value === undefined || value === null) return null;
    return String(value);
  }
  return null;
}

export function normalizeHeader(header: string): string {
  return header
    .toLocaleLowerCase('en')
    .replace(/ё/g, 'е')
    .replace(/[._\-/\\()[\]{}:;,'"`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ColumnSuggestion {
  header: string;
  field: CanonicalField | null;
  /** exact: a known alias; partial: only a substring match; none: unknown */
  confidence: 'exact' | 'partial' | 'none';
}

/**
 * Suggests a mapping for every source column. Only `exact` alias matches are
 * returned as automatic selections; `partial` matches are reported so the UI can
 * offer them without choosing for the user.
 */
export function suggestColumnMapping(
  headers: string[],
  target: ImportTargetEntity,
): { suggestions: ColumnSuggestion[]; suggested: ColumnMapping } {
  const available = new Set(TARGET_FIELDS[target].map((definition) => definition.field));
  const taken = new Set<CanonicalField>();
  const suggestions: ColumnSuggestion[] = [];
  const suggested: ColumnMapping = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    let exact: CanonicalField | null = null;
    let exactButTaken: CanonicalField | null = null;

    for (const field of CANONICAL_FIELDS) {
      if (!available.has(field)) continue;
      if (!FIELD_ALIASES[field].includes(normalized)) continue;
      if (taken.has(field)) {
        // The header names a real field, but an earlier column already claimed
        // it. Offering some other field through partial matching here would be a
        // misleading guess, so the column is left unmapped for the user to set.
        exactButTaken = field;
        continue;
      }
      exact = field;
      break;
    }

    if (exact) {
      taken.add(exact);
      suggested[header] = exact;
      suggestions.push({ header, field: exact, confidence: 'exact' });
      continue;
    }

    if (exactButTaken) {
      suggestions.push({ header, field: null, confidence: 'none' });
      continue;
    }

    let partial: CanonicalField | null = null;
    for (const field of CANONICAL_FIELDS) {
      if (!available.has(field) || taken.has(field)) continue;
      const matches = FIELD_ALIASES[field].some(
        (alias) => alias.length >= 4 && (normalized.includes(alias) || alias.includes(normalized)),
      );
      if (matches) {
        partial = field;
        break;
      }
    }

    suggestions.push({ header, field: partial, confidence: partial ? 'partial' : 'none' });
  }

  return { suggestions, suggested };
}

export interface MappingValidationResult {
  ok: boolean;
  errors: string[];
  /** canonical field -> source header */
  byField: Partial<Record<CanonicalField, string>>;
}

/**
 * Validates a submitted mapping: known fields only, one source column per field,
 * and every required field mapped. Spatial requirements are checked per row
 * instead (a customer needs coordinates *or* an address, not both).
 */
export function validateColumnMapping(
  mapping: ColumnMapping,
  target: ImportTargetEntity,
): MappingValidationResult {
  const errors: string[] = [];
  const allowed = new Set(TARGET_FIELDS[target].map((definition) => definition.field));
  const byField: Partial<Record<CanonicalField, string>> = {};

  for (const [header, field] of Object.entries(mapping)) {
    if (field === null || field === undefined) continue;
    if (!allowed.has(field)) {
      errors.push(`Column "${header}" is mapped to "${field}", which is not a ${target} field.`);
      continue;
    }
    if (byField[field] !== undefined) {
      errors.push(`Both "${byField[field]}" and "${header}" are mapped to "${field}".`);
      continue;
    }
    byField[field] = header;
  }

  for (const definition of TARGET_FIELDS[target]) {
    if (definition.required && byField[definition.field] === undefined) {
      errors.push(`${definition.label} is required.`);
    }
  }

  if (target === 'customers') {
    const hasLatitude = byField.latitude !== undefined;
    const hasLongitude = byField.longitude !== undefined;
    const hasAddress = byField.address !== undefined;
    if (hasLatitude !== hasLongitude) {
      errors.push('Map both Latitude and Longitude, or neither.');
    }
    if (!hasLatitude && !hasAddress) {
      errors.push('Map Latitude and Longitude, or an Address column to geocode.');
    }
  }

  if (target === 'locations' && byField.latitude === undefined && byField.address === undefined) {
    errors.push('Map Latitude and Longitude, or an Address column to geocode.');
  }

  return { ok: errors.length === 0, errors, byField };
}

export function targetFieldDefinitions(target: ImportTargetEntity): TargetFieldDefinition[] {
  return TARGET_FIELDS[target];
}
