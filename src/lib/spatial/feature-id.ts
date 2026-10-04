export const DATABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const DEMO_FIXTURE_ID_PATTERN = /^(?:customer|competitor|branch|place)-\d{2}$/;
export const TRANSIENT_CANDIDATE_ID_PATTERN = /^candidate-site-\d+$/;

/**
 * Identifiers the demo map API is allowed to return: opaque database UUIDs
 * (database mode) or known synthetic fixture identifiers (fixtures mode).
 * Anything else — especially contact-shaped values — is refused before it can
 * reach map data.
 */
export function isAllowedServerMapFeatureId(value: string): boolean {
  return DATABASE_UUID_PATTERN.test(value) || DEMO_FIXTURE_ID_PATTERN.test(value);
}

/**
 * Identifiers accepted in the browser map layer. This adds the transient
 * candidate marker, which only ever exists client-side and must never be
 * accepted from an API response.
 */
export function isAllowedMapFeatureId(value: string): boolean {
  return isAllowedServerMapFeatureId(value) || TRANSIENT_CANDIDATE_ID_PATTERN.test(value);
}
