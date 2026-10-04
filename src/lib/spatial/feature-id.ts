export const DATABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const DEMO_FIXTURE_ID_PATTERN = /^(?:customer|competitor|branch|place)-\d{2}$/;
export const TRANSIENT_CANDIDATE_ID_PATTERN = /^candidate-site-\d+$/;

/**
 * Map feature identifiers are opaque UUIDs (database mode) or known synthetic
 * fixture identifiers. Anything else — especially contact-shaped values — is
 * refused before it can reach map data.
 */
export function isAllowedMapFeatureId(value: string): boolean {
  return (
    DATABASE_UUID_PATTERN.test(value) ||
    DEMO_FIXTURE_ID_PATTERN.test(value) ||
    TRANSIENT_CANDIDATE_ID_PATTERN.test(value)
  );
}
