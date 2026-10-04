import Link from 'next/link';

import { AppShell } from '@/components/app/app-shell';
import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { requireSessionUser } from '@/lib/auth/session';
import {
  listAuthorizedWorkspaces,
  resolveWorkspaceAccess,
  type AuthorizedWorkspace,
} from '@/lib/auth/workspace-access';
import { resolveDataSourceMode } from '@/lib/spatial/data-source';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

interface WorkspacePageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { workspaceId } = await params;
  const user = await requireSessionUser(`/workspaces/${workspaceId}`);

  // The workspace id comes from the URL and is untrusted input: membership is
  // resolved server-side against the database, so editing the URL can never
  // widen access. A foreign and a missing workspace render the same state.
  const workspace = await resolveWorkspaceAccess(user.id, workspaceId);

  if (!workspace) return <NoAccessState />;

  const memberships = await listAuthorizedWorkspaces(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-foreground">{workspace.name}</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
            {ROLE_LABELS[workspace.role] ?? workspace.role}
          </span>
          <WorkspaceSelector memberships={memberships} current={workspace.id} />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{user.email ?? 'Signed in'}</span>
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <AppShell dataSource={resolveDataSourceMode()} workspaceId={workspace.id} />
    </div>
  );
}

function WorkspaceSelector({
  memberships,
  current,
}: {
  memberships: AuthorizedWorkspace[];
  current: string;
}) {
  const others = memberships.filter((membership) => membership.id !== current);
  if (others.length === 0) return null;

  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="Your workspaces">
      {others.map((membership) => (
        <Link
          key={membership.id}
          href={`/workspaces/${membership.id}`}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          {membership.name}
        </Link>
      ))}
    </nav>
  );
}

function NoAccessState() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          {SAFE_AUTH_MESSAGES.noWorkspaceAccess}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a workspace you belong to, or sign in with another account.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            href="/workspaces"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Your workspaces
          </Link>
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Sign out
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
