import { NextResponse, type NextRequest } from 'next/server';

import { SAFE_AUTH_MESSAGES, sanitizeRedirectPath } from '@/lib/auth/messages';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;

interface SignInInput {
  email: string;
  password: string;
  redirectTo: string;
  wantsJson: boolean;
}

async function readSignInInput(request: NextRequest): Promise<SignInInput | null> {
  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body: unknown = await request.json();
      if (typeof body !== 'object' || body === null) return null;
      const record = body as Record<string, unknown>;
      const email = typeof record.email === 'string' ? record.email.trim() : '';
      const password = typeof record.password === 'string' ? record.password : '';
      if (!email || !password) return null;
      return {
        email,
        password,
        redirectTo: sanitizeRedirectPath(
          typeof record.redirectTo === 'string' ? record.redirectTo : null,
        ),
        wantsJson: !(request.headers.get('accept') ?? '').includes('text/html'),
      };
    }

    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || !password) return null;
    return {
      email,
      password,
      redirectTo: sanitizeRedirectPath(String(form.get('redirectTo') ?? '')),
      wantsJson: false,
    };
  } catch {
    return null;
  }
}

function respond(
  request: NextRequest,
  input: SignInInput,
  outcome: 'success' | 'invalid_credentials' | 'invalid_request' | 'unavailable',
) {
  const origin = request.nextUrl.origin;

  if (input.wantsJson) {
    if (outcome === 'success') {
      return NextResponse.json({ signedIn: true, redirectTo: input.redirectTo });
    }
    const status = outcome === 'invalid_request' ? 400 : outcome === 'unavailable' ? 503 : 401;
    const message =
      outcome === 'invalid_credentials'
        ? SAFE_AUTH_MESSAGES.invalidCredentials
        : SAFE_AUTH_MESSAGES.signInFailed;
    return NextResponse.json({ error: { code: outcome, message } }, { status });
  }

  const target =
    outcome === 'success'
      ? new URL(input.redirectTo, origin)
      : new URL(`/sign-in?error=${outcome}`, origin);
  if (outcome !== 'success') {
    target.searchParams.set('redirectTo', input.redirectTo);
  }

  return NextResponse.redirect(target, { status: 303 });
}

export async function POST(request: NextRequest) {
  const input = await readSignInInput(request);
  if (!input) {
    const fallback: SignInInput = {
      email: '',
      password: '',
      redirectTo: '/workspaces',
      wantsJson: !(request.headers.get('accept') ?? '').includes('text/html'),
    };
    return respond(request, fallback, 'invalid_request');
  }

  if (input.email.length > MAX_EMAIL_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    return respond(request, input, 'invalid_credentials');
  }

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return respond(request, input, 'unavailable');
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error) {
    // The provider's message is never forwarded: it can distinguish unknown
    // accounts from wrong passwords.
    return respond(request, input, 'invalid_credentials');
  }

  return respond(request, input, 'success');
}
