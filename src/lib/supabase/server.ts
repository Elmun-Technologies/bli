import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Creates a request-scoped Supabase client for Server Components and Route
 * Handlers. This foundation uses only the public anon/publishable key; no
 * service-role key is accepted here. Authentication and RLS policies are
 * introduced in a later phase.
 */
export async function createSupabaseServerClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Set SUPABASE_URL and SUPABASE_ANON_KEY to use Supabase server services.',
    );
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot always write cookies. Route handlers or
          // middleware will own session refresh when authentication is added.
        }
      },
    },
  });
}
