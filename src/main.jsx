import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./auth/AuthGate.jsx";

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
