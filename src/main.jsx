import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./auth/AuthGate.jsx";
import { getOrgId, load, save } from "./lib/workspaceApi.js";

// Phase 2: expose the per-company persistence API to the (import-free) app.
// App.jsx picks this up from window.__sdvWorkspaceApi and uses it to load/save
// each company's workspace. If it's absent (standalone artifact), the app just
// runs session-only.
if (typeof window !== "undefined") {
  window.__sdvWorkspaceApi = { getOrgId, load, save };
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
