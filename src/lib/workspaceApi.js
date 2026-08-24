// Per-company workspace persistence API (Phase 2).
// The app (App.jsx) stays import-free so it also runs as a standalone artifact;
// main.jsx registers these three functions on window.__sdvWorkspaceApi, and the
// app calls them if present. All access is gated by Supabase RLS, so a company
// can only ever read/write its own workspace row.
import { supabase, supabaseConfigured } from "./supabaseClient.js";

// The signed-in user's organization id (from their membership row; RLS-safe).
export async function getOrgId() {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("memberships").select("org_id").limit(1).maybeSingle();
  if (error) throw error;
  return data ? data.org_id : null;
}

// Load this company's workspace document (or null if none saved yet).
export async function load(orgId) {
  if (!supabaseConfigured || !orgId) return null;
  const { data, error } = await supabase
    .from("workspaces").select("data").eq("org_id", orgId).maybeSingle();
  if (error) throw error;
  return data ? data.data : null;
}

// Upsert this company's workspace document.
export async function save(orgId, doc) {
  if (!supabaseConfigured || !orgId) return;
  const { data: auth } = await supabase.auth.getUser();
  const row = {
    org_id: orgId,
    data: doc,
    updated_at: new Date().toISOString(),
    updated_by: auth && auth.user ? auth.user.id : null,
  };
  const { error } = await supabase
    .from("workspaces").upsert(row, { onConflict: "org_id" });
  if (error) throw error;
}
