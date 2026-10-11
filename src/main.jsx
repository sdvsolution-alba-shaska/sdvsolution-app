import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./auth/AuthGate.jsx";
import { getOrgId, load, save } from "./lib/workspaceApi.js";
import * as codegen from "./lib/codegen.js";
import { PILOT_MODELS } from "./lib/pilotModels.js";
import * as reqChecks from "./lib/reqChecks.js";
import * as reviewLifecycle from "./lib/reviewLifecycle.js";

// Phase 2: expose the per-company persistence API to the (import-free) app.
// App.jsx picks this up from window.__sdvWorkspaceApi and uses it to load/save
// each company's workspace. If it's absent (standalone artifact), the app just
// runs session-only.
if (typeof window !== "undefined") {
  window.__sdvWorkspaceApi = { getOrgId, load, save };
  // Phase 1: the deterministic Behavior Model -> C/test generator (same module the build runner will use).
  window.__sdvCodegen = { ...codegen, pilots: PILOT_MODELS };
  // Quality checks for the curated requirement sets (EARS pattern vs wording, singular, missing attributes).
  window.__sdvReqChecks = reqChecks;
  // Review lifecycle rules for curated requirements and Behavior Models (reviewer / approver gates, withdraw-on-edit, roll-up).
  window.__sdvReview = reviewLifecycle;
  // Phase 5: build jobs and runner registration (signed-in users; the server re-checks every gate).
  const buildCall = async (body) => {
    const tok = window.__sdvAuth && window.__sdvAuth.getToken ? await window.__sdvAuth.getToken() : null;
    const r = await fetch("/api/builds", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "Request failed (" + r.status + ")"); e.status = r.status; e.reasons = j.reasons; throw e; }
    return j;
  };
  window.__sdvBuildApi = {
    request: (bmId, baselineId) => buildCall({ action: "request", bmId, baselineId }),
    list: (bmId) => buildCall({ action: "list", bmId }),
    get: (id, files) => buildCall({ action: "get", id, files: !!files }),
    cancel: (id) => buildCall({ action: "cancel", id }),
    runnerCreate: (name) => buildCall({ action: "runner_create", name }),
    runnerList: () => buildCall({ action: "runner_list" }),
    runnerRevoke: (id) => buildCall({ action: "runner_revoke", id }),
  };
}

// AuthGate is the front door: it renders the sign-in screen until the user is
// authenticated, then renders the app. Company-level data isolation is
// enforced server-side by Supabase RLS (see supabase/setup.sql).
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);
