/**
 * Row validation for one import.
 *
 * Each staged row ends up in exactly one of three states:
 *   valid           - everything required is present and a coordinate exists
 *   needs_geocoding - valid apart from its coordinate, which an address can supply
 *   invalid         - at least one blocking error, reported with a row number,
 *                     a field, a machine-readable code and a safe message
 *
 * Errors are never discarded: the row stays staged, the export includes it, and
 * nothing is written to the production tables until an explicit commit.
 */
import type { ImportTargetEntity } from './limits';
import type { CanonicalField, ColumnMapping } from './column-mapping';
import { validateColumnMapping } from './column-mapping';
import {
  normalizeTextCell,
  parseCalendarDate,
  parseCoordinate,
  parseDecimalAmount,
  parseWholeNumber,
  type NormalizationIssue,
} from './normalize';

export interface RowValidationError {
  code: string;
  field: string;
  message: string;
}

export type RowValidationStatus = 'valid' | 'needs_geocoding' | 'invalid';

export interface RowValidationResult {
  rowNumber: number;
  status: RowValidationStatus;
  normalized: Record<string, string | null>;
  errors: RowValidationError[];
  longitude: number | null;
  latitude: number | null;
  /** Coordinates look swapped: reported for confirmation, never auto-corrected. */
  coordinateWarning: string | null;
  /** Address used for geocoding, when the row needs one. */
  geocodingAddress: string | null;
}

export interface StagedRowInput {
  rowNumber: number;
  rawData: Record<string, unknown>;
}

function withField(issue: NormalizationIssue, field: string): RowValidationError {
  return { code: issue.code, field, message: issue.message };
}

function textValue(
  rawData: Record<string, unknown>,
  header: string | undefined,
  field: string,
  errors: RowValidationError[],
  normalized: Record<string, string | null>,
): string | null {
  if (header === undefined) return null;
  const result = normalizeTextCell(rawData[header]);
  if (!result.ok) {
    errors.push(withField(result.issue, field));
    return null;
  }
  normalized[field] = result.value;
  return result.value;
}

/**
 * Validates every staged row of one import against its mapping. Duplicate
 * external ids are detected across the whole import (the first occurrence wins,
 * the later ones are reported), which is the deterministic duplicate rule for
 * Phase 5 - no fuzzy matching, no silent merging.
 */
export function validateImportRows(
  rows: StagedRowInput[],
  mapping: ColumnMapping,
  target: ImportTargetEntity,
): { results: RowValidationResult[]; mappingErrors: string[] } {
  const mappingValidation = validateColumnMapping(mapping, target);
  if (!mappingValidation.ok) {
    return { results: [], mappingErrors: mappingValidation.errors };
  }

  const byField = mappingValidation.byField;
  const seenExternalIds = new Map<string, number>();
  const results: RowValidationResult[] = [];

  for (const row of rows) {
    const errors: RowValidationError[] = [];
    const normalized: Record<string, string | null> = {};

    const externalIdKey = target === 'customers' ? 'external_id' : 'external_id';
    const externalId = textValue(row.rawData, byField.external_id, externalIdKey, errors, normalized);
    const name = textValue(row.rawData, byField.name, 'name', errors, normalized);
    const address = textValue(row.rawData, byField.address, 'address', errors, normalized);
    textValue(row.rawData, byField.source, 'source', errors, normalized);

    if (target === 'locations' && name === null && !errors.some((error) => error.field === 'name')) {
      errors.push({ code: 'missing_required_value', field: 'name', message: 'Name is required.' });
    }

    if (externalId !== null) {
      const existing = seenExternalIds.get(externalId);
      if (existing !== undefined) {
        errors.push({
          code: 'duplicate_external_id',
          field: 'external_id',
          message: `External id also appears on row ${existing}.`,
        });
      } else {
        seenExternalIds.set(externalId, row.rowNumber);
      }
    }

    if (target === 'customers') {
      textValue(row.rawData, byField.phone, 'phone', errors, normalized);
      textValue(row.rawData, byField.company, 'company', errors, normalized);
      textValue(row.rawData, byField.segment, 'segment', errors, normalized);

      if (byField.revenue !== undefined) {
        const revenue = parseDecimalAmount(row.rawData[byField.revenue]);
        if (!revenue.ok) errors.push(withField(revenue.issue, 'revenue'));
        else normalized.revenue = revenue.value;
      }

      if (byField.order_count !== undefined) {
        const orders = parseWholeNumber(row.rawData[byField.order_count]);
        if (!orders.ok) errors.push(withField(orders.issue, 'order_count'));
        else normalized.order_count = orders.value;
      }

      if (byField.last_order_date !== undefined) {
        const date = parseCalendarDate(row.rawData[byField.last_order_date]);
        if (!date.ok) errors.push(withField(date.issue, 'last_order_date'));
        else normalized.last_order_date = date.value;
      }
    }

    if (target === 'locations') {
      textValue(row.rawData, byField.category, 'category', errors, normalized);
      textValue(row.rawData, byField.subcategory, 'subcategory', errors, normalized);
    }

    const latitude = byField.latitude !== undefined
      ? parseCoordinate(row.rawData[byField.latitude!], 'latitude')
      : ({ ok: true, value: null } as const);
    const longitude = byField.longitude !== undefined
      ? parseCoordinate(row.rawData[byField.longitude!], 'longitude')
      : ({ ok: true, value: null } as const);

    let coordinateWarning: string | null = null;
    if (!latitude.ok) errors.push(withField(latitude.issue, 'latitude'));
    if (!longitude.ok) errors.push(withField(longitude.issue, 'longitude'));

    // A swapped pair is reported for confirmation: if either column fails its own
    // range check but both values fit when read the other way round, the mapping
    // is the likely culprit. Nothing is swapped automatically, and a swap that
    // cannot be detected this way (both values inside both ranges, e.g. the
    // Tashkent pair 41.3/69.3) stays unflagged - see docs/imports.md.
    if (!latitude.ok || !longitude.ok) {
      const latitudeColumnAsLongitude = parseCoordinate(row.rawData[byField.latitude!], 'longitude');
      const longitudeColumnAsLatitude = parseCoordinate(row.rawData[byField.longitude!], 'latitude');
      if (latitudeColumnAsLongitude.ok && longitudeColumnAsLatitude.ok) {
        coordinateWarning = 'Latitude and longitude look swapped. Confirm the column mapping.';
        errors.push({
          code: 'coordinate_swap_suspected',
          field: 'latitude',
          message: coordinateWarning,
        });
      }
    }

    const latValue = latitude.ok ? latitude.value : null;
    const lonValue = longitude.ok ? longitude.value : null;
    if (latValue !== null) normalized.latitude = String(latValue);
    if (lonValue !== null) normalized.longitude = String(lonValue);

    const hasCoordinate = latValue !== null && lonValue !== null;
    const hasPartialCoordinate = (latValue === null) !== (lonValue === null);
    if (hasPartialCoordinate) {
      errors.push({
        code: 'missing_required_value',
        field: latValue === null ? 'latitude' : 'longitude',
        message: 'Provide both latitude and longitude.',
      });
    }

    let status: RowValidationStatus;
    let geocodingAddress: string | null = null;

    if (errors.length > 0) {
      status = 'invalid';
    } else if (hasCoordinate) {
      status = 'valid';
    } else if (address !== null) {
      status = 'needs_geocoding';
      geocodingAddress = address;
    } else {
      status = 'invalid';
      errors.push({
        code: 'missing_spatial_input',
        field: 'address',
        message: 'Row has no coordinates and no address to geocode.',
      });
    }

    results.push({
      rowNumber: row.rowNumber,
      status,
      normalized,
      errors,
      longitude: lonValue,
      latitude: latValue,
      coordinateWarning,
      geocodingAddress,
    });
  }

  return { results, mappingErrors: [] };
}

/** Canonical fields the commit/final record will carry, for the preview table. */
export function previewFieldsFor(target: ImportTargetEntity): CanonicalField[] {
  if (target === 'customers') {
    return ['name', 'external_id', 'phone', 'company', 'address', 'revenue', 'order_count', 'segment'];
  }
  return ['name', 'category', 'subcategory', 'address', 'external_id'];
}
