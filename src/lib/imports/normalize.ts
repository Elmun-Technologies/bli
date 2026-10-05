/**
 * Value normalization for imported cells.
 *
 * Rules that shape everything else in this module:
 *   * the original source value is never destroyed - it stays in `raw_data`, and
 *     normalization produces the separate `normalized_data` projection;
 *   * money is handled as an exact decimal string, never as a JavaScript float,
 *     so PostgreSQL `numeric(18,2)` receives exactly what the source said;
 *   * phone numbers and other identifiers stay text, never numbers;
 *   * nothing here guesses silently: suspicious input is reported as a row error
 *     and a human decides.
 */
import { IMPORT_LIMITS } from './limits';

export interface NormalizationIssue {
  code: string;
  field: string;
  message: string;
}

export type NormalizedCell =
  | { ok: true; value: string | null }
  | { ok: false; issue: NormalizationIssue };

/**
 * Control characters (and the DEL range) are replaced before anything else: a
 * spreadsheet cell can contain them, and they have no place in a stored value.
 * Written as a code-point test rather than a character class so the linter does
 * not have to be silenced.
 */
function isControlCharacter(codePoint: number): boolean {
  if (codePoint === 0x7f) return true;
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) return true;
  return false;
}

function stripControlCharacters(text: string): string {
  let result = '';
  for (const character of text) {
    result += isControlCharacter(character.codePointAt(0) ?? 0) ? ' ' : character;
  }
  return result;
}

/** Cell values arrive as strings already; this trims and limits them. */
export function normalizeTextCell(value: unknown): NormalizedCell {
  if (value === null || value === undefined) return { ok: true, value: null };

  const text = stripControlCharacters(String(value))
    .replace(/\s+/g, ' ')
    .trim();

  if (text === '') return { ok: true, value: null };
  if (text.length > IMPORT_LIMITS.maxCellLength) {
    return {
      ok: false,
      issue: {
        code: 'value_too_long',
        field: '',
        message: `Value is longer than ${IMPORT_LIMITS.maxCellLength} characters.`,
      },
    };
  }
  return { ok: true, value: text };
}

/**
 * Exact-decimal money parsing.
 *
 * Accepts `1 250 000.50`, `1,250,000.50`, `1250000,50` and plain `1250`, and
 * returns a canonical `-?\d+(\.\d{1,2})?` string. Grouping separators are only
 * removed when they are unambiguously grouping: `1,5` stays a decimal comma,
 * while `1,500` is read as one thousand five hundred because the group of three
 * digits cannot be a decimal fraction.
 */
export function parseDecimalAmount(value: unknown): NormalizedCell {
  const normalized = normalizeTextCell(value);
  if (!normalized.ok) return normalized;
  if (normalized.value === null) return { ok: true, value: null };

  let text = normalized.value
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/[^\d.,\-+()]/g, (character) => `\u0000${character}`);

  if (text.includes('\u0000')) {
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Amount contains unexpected characters.' },
    };
  }

  // Accounting negatives: (1234.50) means -1234.50.
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (text === '' || !/^[\d.,]+$/.test(text)) {
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Amount is not a valid number.' },
    };
  }

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let integerPart = text;
  let fractionPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator.
    const decimalIndex = Math.max(lastDot, lastComma);
    integerPart = text.slice(0, decimalIndex);
    fractionPart = text.slice(decimalIndex + 1);
  } else if (lastComma >= 0) {
    const commaCount = (text.match(/,/g) ?? []).length;
    const tail = text.slice(lastComma + 1);
    // A single comma with 1-2 digits after it is a decimal comma; anything else
    // is grouping.
    if (commaCount === 1 && tail.length >= 1 && tail.length <= 2) {
      integerPart = text.slice(0, lastComma);
      fractionPart = tail;
    } else {
      integerPart = text.replace(/,/g, '');
    }
  } else if (lastDot >= 0) {
    const dotCount = (text.match(/\./g) ?? []).length;
    const tail = text.slice(lastDot + 1);
    if (dotCount > 1 && tail.length === 3) {
      // 1.250.000 -> grouping dots only.
      integerPart = text.replace(/\./g, '');
    } else if (dotCount > 1) {
      return {
        ok: false,
        issue: { code: 'invalid_number', field: '', message: 'Amount has an ambiguous decimal separator.' },
      };
    } else {
      integerPart = text.slice(0, lastDot);
      fractionPart = tail;
    }
  }

  integerPart = integerPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integerPart) && integerPart !== '') {
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Amount is not a valid number.' },
    };
  }
  if (fractionPart !== '' && !/^\d+$/.test(fractionPart)) {
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Amount has an invalid fraction.' },
    };
  }
  if (fractionPart.length > 2) {
    return {
      ok: false,
      issue: {
        code: 'invalid_number',
        field: '',
        message: 'Amount has more than two decimal places; money must be exact.',
      },
    };
  }

  const digits = integerPart.replace(/^0+(?=\d)/, '');
  if (digits.length > 16) {
    // numeric(18,2) has 16 integer digits available.
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Amount is too large to store exactly.' },
    };
  }

  const sign = negative && /[1-9]/.test(digits + fractionPart) ? '-' : '';
  const fraction = fractionPart === '' ? '00' : fractionPart.padEnd(2, '0');
  return { ok: true, value: `${sign}${digits === '' ? '0' : digits}.${fraction}` };
}

/** Non-negative integer counts such as order counts. */
export function parseWholeNumber(value: unknown): NormalizedCell {
  const normalized = normalizeTextCell(value);
  if (!normalized.ok) return normalized;
  if (normalized.value === null) return { ok: true, value: null };

  const text = normalized.value.replace(/[\s\u00a0\u202f]/g, '').replace(/,/g, '');
  if (!/^\d+$/.test(text)) {
    // Excel sometimes hands a whole number over as 12.0.
    if (/^\d+\.0+$/.test(text)) {
      return { ok: true, value: String(Number.parseInt(text.split('.')[0], 10)) };
    }
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Value must be a whole number.' },
    };
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    return {
      ok: false,
      issue: { code: 'invalid_number', field: '', message: 'Value is too large for an integer column.' },
    };
  }
  return { ok: true, value: String(parsed) };
}

/** Latitude/longitude as finite numbers in range. */
export function parseCoordinate(
  value: unknown,
  kind: 'latitude' | 'longitude',
): { ok: true; value: number | null } | { ok: false; issue: NormalizationIssue } {
  const normalized = normalizeTextCell(value);
  if (!normalized.ok) {
    return { ok: false, issue: { ...normalized.issue, code: `invalid_${kind}` } };
  }
  if (normalized.value === null) return { ok: true, value: null };

  const text = normalized.value.replace(/\s/g, '').replace(',', '.');
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    return {
      ok: false,
      issue: { code: `invalid_${kind}`, field: '', message: `Value is not a valid ${kind}.` },
    };
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      issue: { code: `invalid_${kind}`, field: '', message: `Value is not a finite ${kind}.` },
    };
  }

  const limit = kind === 'latitude' ? 90 : 180;
  if (parsed < -limit || parsed > limit) {
    return {
      ok: false,
      issue: { code: `invalid_${kind}`, field: '', message: `Value is outside the valid ${kind} range.` },
    };
  }

  return { ok: true, value: Math.round(parsed * 1e7) / 1e7 };
}

/**
 * Dates as `YYYY-MM-DD`. Excel gives real dates, which read-excel-file hands
 * over as ISO strings; text dates are accepted in the common day-first and
 * ISO shapes only (never guessed for ambiguous formats like 03/04/2026).
 */
export function parseCalendarDate(value: unknown): NormalizedCell {
  const normalized = normalizeTextCell(value);
  if (!normalized.ok) return normalized;
  if (normalized.value === null) return { ok: true, value: null };

  const text = normalized.value;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      return { ok: true, value: candidate };
    }
  }

  // `d/m/yyyy` is only accepted when the day cannot also be a month (day > 12).
  // Anything else - 03/04/2026 could be 3 April or 4 March - is reported instead
  // of guessed, because a wrong business date is worse than a row error.
  const dayFirst = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
  if (dayFirst) {
    const day = Number.parseInt(dayFirst[1], 10);
    const month = Number.parseInt(dayFirst[2], 10);
    const year = Number.parseInt(dayFirst[3], 10);

    if (day > 12 && month <= 12) {
      const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const parsed = new Date(`${candidate}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
        return { ok: true, value: candidate };
      }
      return {
        ok: false,
        issue: { code: 'invalid_date', field: '', message: 'Date is not a real calendar date.' },
      };
    }

    return {
      ok: false,
      issue: {
        code: 'invalid_date',
        field: '',
        message: 'Date is ambiguous (could be day/month or month/day); write it as YYYY-MM-DD.',
      },
    };
  }

  return {
    ok: false,
    issue: { code: 'invalid_date', field: '', message: 'Date must be written as YYYY-MM-DD.' },
  };
}

/**
 * Address normalization is deliberately conservative: collapse whitespace and
 * optionally append the market country when the caller asks for it. Street and
 * building semantics are never rewritten, and the caller keeps the original.
 */
export function normalizeAddress(value: unknown): string | null {
  const normalized = normalizeTextCell(value);
  if (!normalized.ok || normalized.value === null) return null;
  return normalized.value;
}

export function buildGeocodingQuery(
  address: string,
  options: { country?: string | null } = {},
): string {
  const base = address.replace(/\s+/g, ' ').trim();
  const country = options.country?.trim();
  if (!country) return base;
  const alreadyMentionsCountry = base.toLocaleLowerCase('en').includes(country.toLocaleLowerCase('en'));
  return alreadyMentionsCountry ? base : `${base}, ${country}`;
}
