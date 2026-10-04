import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database/database.types';

let adminClient: SupabaseClient<Database> | null = null;

/**
 * Stateless elevated client for the fixed server-only synthetic demo API.
 * Never import this module from a client component or reuse the cookie-aware
 * SSR client for spatial RPCs.
 */
export function getAdminSupabaseClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const legacyServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = secretKey || legacyServiceRoleKey;

  if (!supabaseUrl || !apiKey) {
    throw new Error(
      'Server-side database configuration is missing. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).',
    );
  }

  adminClient = createClient<Database>(supabaseUrl, apiKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return adminClient;
}
