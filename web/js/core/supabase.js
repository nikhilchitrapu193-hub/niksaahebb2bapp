// =============================================================================
// supabase.js — creates the single shared Supabase client.
//
// supabase-js is vendored (web/vendor/supabase.js) and loaded with a classic
// <script> tag BEFORE any module, which defines window.supabase.
// =============================================================================

import { config } from './config.js';

if (!globalThis.supabase?.createClient) {
  throw new Error(
    'supabase-js not loaded. Add <script src="../vendor/supabase.js"></script> before your module script.'
  );
}

export const supabase = globalThis.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Accessor used by admin modules that need the raw client (e.g. admin/orders.js). */
export const getSupabase = () => supabase;
