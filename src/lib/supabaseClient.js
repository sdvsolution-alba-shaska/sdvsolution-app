// Supabase client — reads config from Vite env vars.
// Set these in .env (local) and in Vercel → Project → Settings → Environment Variables:
//   VITE_SUPABASE_URL       = https://<your-project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  = <your anon/public key>
//
// The anon key is safe to expose in the browser: it can only do what your
// Row-Level Security (RLS) policies allow. Real tenant isolation is enforced
// server-side by RLS (see supabase/setup.sql). Never put the *service_role*
// key in this app.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Surfaced by AuthGate so a missing/incomplete config shows a clear message
// instead of a blank screen.
export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
