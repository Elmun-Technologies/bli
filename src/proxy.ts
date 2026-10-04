import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Supabase SSR session refresh (Next.js `proxy` file convention, the successor
 * to `middleware` in Next 16). It refreshes the auth cookie on navigation and
 * keeps the cookie in sync, but it is never an authorization gate: every
 * protected page and route handler re-validates the session server-side and
 * membership is always decided by the database.
 *
 * When Supabase is not configured (for example the fixtures-only smoke run) the
 * proxy is a no-op rather than a failure.
 */
export async function proxy(request: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  try {
    // Refreshes the session when the access token has expired. Failures are
    // ignored here: the protected pages and routes decide authorization.
    await supabase.auth.getUser();
  } catch {
    // Never surface auth internals from the proxy.
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)',
  ],
};
