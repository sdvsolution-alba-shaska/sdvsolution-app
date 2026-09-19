import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "/" for a subdomain (app.sdvsolution.com) or Netlify/Vercel root.
// For GitHub Pages project hosting, set base to "/<repo-name>/".
export default defineConfig({
  plugins: [react()],
  base: "/",
});
