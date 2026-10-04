/**
 * The exact user-facing security messages for Phase 4. Everything the browser
 * can see comes from this list: no SQL, policy names, JWT details, schema
 * information or credential hints may ever reach the client.
 */
export const SAFE_AUTH_MESSAGES = {
  invalidCredentials: 'Invalid email or password.',
  noWorkspaceAccess: 'You do not have access to this workspace.',
  sessionExpired: 'Session expired. Please sign in again.',
  noWorkspaces: 'Your account is not a member of any workspace yet.',
  signInFailed: 'Sign-in could not be completed. Please try again.',
  signInRequired: 'Sign in to continue to your workspace.',
} as const;

export type SignInErrorCode = 'invalid_credentials' | 'invalid_request' | 'unavailable';

/** Maps a sign-in error code from the URL back to its safe message. */
export function signInErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case 'invalid_credentials':
      return SAFE_AUTH_MESSAGES.invalidCredentials;
    case 'invalid_request':
      return SAFE_AUTH_MESSAGES.signInFailed;
    case 'unavailable':
      return SAFE_AUTH_MESSAGES.signInFailed;
    default:
      return null;
  }
}

/**
 * Only same-site absolute paths are accepted as post-sign-in destinations, so a
 * crafted `redirectTo` can never turn the sign-in route into an open redirect.
 */
export function sanitizeRedirectPath(value: string | null | undefined, fallback = '/workspaces'): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback;
  }
  if (candidate.includes('://') || candidate.includes('\n') || candidate.includes('\r')) return fallback;
  return candidate.length > 512 ? fallback : candidate;
}
