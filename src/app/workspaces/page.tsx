import Link from 'next/link';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { requireSessionUser } from '@/lib/auth/session';
import { listAuthorizedWorkspaces, WorkspaceAccessQueryError } from '@/lib/auth/workspace-access';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

export default async function WorkspacesPage() {
  const user = await requireSessionUser('/workspaces');

  let workspaces: Awaited<ReturnType<typeof listAuthorizedWorkspaces>> | null = null;
  let lookupFailed = false;
  try {
    // Row Level Security decides this list: a caller can only ever see their own
    // memberships, so the selector is built from authorized rows only and never
    // from all-workspaces data filtered in the browser.
    workspaces = await listAuthorizedWorkspaces(user.id);
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) lookupFailed = true;
    else throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Your workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {user.email ?? 'an authenticated user'}.
          </p>
        </div>
        <form action="/api/auth/sign-out" method="post">
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </header>

      {lookupFailed ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {SAFE_AUTH_MESSAGES.signInFailed}
        </p>
      ) : null}

      {workspaces && workspaces.length === 0 ? (
        <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          {SAFE_AUTH_MESSAGES.noWorkspaces}
        </p>
      ) : null}

      <ul className="grid gap-3">
        {(workspaces ?? []).map((workspace) => (
          <li key={workspace.id}>
            <Link
              href={`/workspaces/${workspace.id}`}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted"
            >
              <span className="text-sm font-medium text-foreground">{workspace.name}</span>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {ROLE_LABELS[workspace.role] ?? workspace.role}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
