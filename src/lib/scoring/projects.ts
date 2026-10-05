/**
 * Project context for every saved-candidate, analysis and comparison workflow.
 *
 * Phase 6.5 removed the last implicit rule: the server no longer picks the
 * oldest (or first) project of a workspace. A project is either named explicitly
 * by the caller and verified against the caller's own workspace, or - when the
 * workspace holds exactly one active project - resolved unambiguously and
 * reported back in the response.
 *
 * The resolver is a pure function so the server, the interface and the tests all
 * agree on one rule set. It is deliberately order-independent: the repository
 * never selects "the oldest" or "the first" row.
 */

export interface WorkspaceProjectSummary {
  id: string;
  name: string;
  status: string;
}

/**
 * One safe message for "the caller did not give us a usable project". A missing
 * project id, a project id of another workspace, a project id that does not
 * exist and a project id whose owner is not a member all produce this exact
 * response, so the endpoint is never a resource-existence oracle.
 */
export const PROJECT_REQUIRED_MESSAGE = 'Select a project in this workspace before continuing.';

/** The zero-project state. Nothing is created automatically. */
export const NO_PROJECT_MESSAGE =
  'No project is available. Create or select a project before running location analysis.';

export type ProjectResolution =
  | { status: 'resolved'; projectId: string }
  | { status: 'empty' }
  | { status: 'required' }
  | { status: 'unknown' };

/**
 * Resolves the project a request may act on.
 *
 * - an explicit id is accepted only when it is one of the caller's own
 *   (workspace-visible) projects, never silently replaced;
 * - no id is only acceptable when the workspace has exactly one project;
 * - zero projects and several projects without an id never guess.
 */
export function resolveProjectContext(
  projects: readonly WorkspaceProjectSummary[],
  requestedProjectId: string | null,
): ProjectResolution {
  if (requestedProjectId !== null) {
    const known = projects.some((project) => project.id === requestedProjectId);
    return known
      ? { status: 'resolved', projectId: requestedProjectId }
      : { status: 'unknown' };
  }

  if (projects.length === 0) return { status: 'empty' };
  if (projects.length === 1) return { status: 'resolved', projectId: projects[0].id };
  return { status: 'required' };
}

/** Human label of the empty state the interface shows when nothing is selectable. */
export function projectEmptyStateMessage(): string {
  return NO_PROJECT_MESSAGE;
}
