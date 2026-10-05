import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSessionUser } from '@/lib/auth/session';
import { sanitizeRedirectPath, signInErrorMessage } from '@/lib/auth/messages';

export const dynamic = 'force-dynamic';

interface SignInPageProps {
  searchParams: Promise<{ error?: string; redirectTo?: string; signedOut?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const redirectTo = sanitizeRedirectPath(params.redirectTo);

  const user = await getSessionUser();
  if (user) redirect(redirectTo);

  const errorMessage = signInErrorMessage(params.error);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <section className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Access the workspaces your account is a member of.
          </p>
        </header>

        {params.signedOut ? (
          <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            You have been signed out.
          </p>
        ) : null}

        {errorMessage ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </p>
        ) : null}

        <form action="/api/auth/sign-in" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="redirectTo" value={redirectTo} />
          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={200}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-xs text-muted-foreground">
          Accounts are created by an operator. See{' '}
          <Link href="/" className="underline">
            the public demo
          </Link>{' '}
          for the synthetic dataset.
        </p>
      </section>
    </main>
  );
}
