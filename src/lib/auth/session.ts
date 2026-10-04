import 'server-only';

import { redirect } from 'next/navigation';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * Server-validated session lookup. `auth.getUser()` verifies the JWT with the
 * auth server instead of trusting the cookie contents, so client state is never
 * the source of authorization truth.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return null;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? null };
}

/** Gate for protected pages: unauthenticated visitors are sent to sign-in. */
export async function requireSessionUser(redirectTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/sign-in?redirectTo=${encodeURIComponent(redirectTo)}`);
  }
  return user;
}
