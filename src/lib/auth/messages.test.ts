import assert from 'node:assert/strict';
import test from 'node:test';

import { SAFE_AUTH_MESSAGES, sanitizeRedirectPath, signInErrorMessage } from './messages';

test('every security message is the approved wording', () => {
  assert.equal(SAFE_AUTH_MESSAGES.invalidCredentials, 'Invalid email or password.');
  assert.equal(SAFE_AUTH_MESSAGES.noWorkspaceAccess, 'You do not have access to this workspace.');
  assert.equal(SAFE_AUTH_MESSAGES.sessionExpired, 'Session expired. Please sign in again.');
});

test('sign-in error codes map to safe messages only', () => {
  assert.equal(signInErrorMessage('invalid_credentials'), SAFE_AUTH_MESSAGES.invalidCredentials);
  assert.equal(signInErrorMessage('invalid_request'), SAFE_AUTH_MESSAGES.signInFailed);
  assert.equal(signInErrorMessage(undefined), null);
  // Unknown codes fall through to no message rather than echoing the input.
  assert.equal(signInErrorMessage('42501 permission denied for table workspace_members'), null);
});

test('redirect targets stay on this site', () => {
  assert.equal(sanitizeRedirectPath('/workspaces'), '/workspaces');
  assert.equal(sanitizeRedirectPath('/workspaces/abc?tab=map'), '/workspaces/abc?tab=map');
  assert.equal(sanitizeRedirectPath(undefined), '/workspaces');
  assert.equal(sanitizeRedirectPath(''), '/workspaces');
  assert.equal(sanitizeRedirectPath('https://evil.example/steal'), '/workspaces');
  assert.equal(sanitizeRedirectPath('//evil.example/steal'), '/workspaces');
  assert.equal(sanitizeRedirectPath('/\\evil.example'), '/workspaces');
  assert.equal(sanitizeRedirectPath('/ok\nHeader: injected'), '/workspaces');
  assert.equal(sanitizeRedirectPath(`/${'a'.repeat(600)}`), '/workspaces');
});
