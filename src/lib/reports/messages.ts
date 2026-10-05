/**
 * The safe, user-facing report messages.
 *
 * The API answers with a small documented error code and one of these messages,
 * never with a database message, a storage path, a policy name, a SQL fragment
 * or a map token. The same constants are used by the server and by the tests, so
 * a silent wording change is a test failure rather than a surprise in the UI.
 */

import { PROJECT_REQUIRED_MESSAGE } from '@/lib/scoring/projects';

export const REPORT_SAFE_MESSAGES = {
  invalid_request: 'The report request is not valid.',
  project_required: PROJECT_REQUIRED_MESSAGE,
  no_project: 'No project is available in this workspace.',
  access_denied: 'You do not have access to this report.',
  report_not_found: 'Report not found.',
  report_not_ready: 'This report has no PDF yet. Generate it first.',
  report_generation_failed: 'The report PDF could not be generated. Retry is available.',
  report_integrity_failed: 'This report failed its integrity check and was not regenerated.',
  storage_unavailable: 'The report file could not be stored or read.',
} as const;

export type ReportSafeMessageCode = keyof typeof REPORT_SAFE_MESSAGES;

export function reportValidationMessage(code: string): string {
  return code in REPORT_SAFE_MESSAGES
    ? REPORT_SAFE_MESSAGES[code as ReportSafeMessageCode]
    : REPORT_SAFE_MESSAGES.invalid_request;
}
