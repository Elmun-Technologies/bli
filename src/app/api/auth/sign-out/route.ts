import { NextResponse, type NextRequest } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  const wantsJson = !(request.headers.get('accept') ?? '').includes('text/html');

  try {
    const supabase = await createSupabaseServerClient();
    // Clears the auth cookies for this session. A failure is still reported as
    // a completed sign-out so the browser never keeps a half-cleared session.
    await supabase.auth.signOut();
  } catch {
    // Missing configuration or an already-invalid session is not an error here.
  }

  if (wantsJson) {
    return NextResponse.json({ signedOut: true });
  }

  return NextResponse.redirect(new URL('/sign-in?signedOut=1', request.nextUrl.origin), {
    status: 303,
  });
}
