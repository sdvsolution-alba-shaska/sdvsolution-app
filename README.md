# SDVsolution — app (Vite + React)

The SDVsolution requirements tool packaged as a deployable single‑page app.
This is the **client‑side product** (session data, no server accounts yet). Real
sign‑up / login / billing is a separate backend project (see the Offering Plan).

## What's inside
- `src/App.jsx` — the full application (the tool).
- `src/main.jsx` — mounts the app into `#root`.
- `index.html` — page shell; loads Tailwind via Play CDN for the utility classes.
- `vite.config.js`, `package.json` — build config.

## Run locally
```
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs static files to dist/
npm run preview    # serve the production build
```

## Deploy (recommended: Vercel or Netlify — they run the build for you)

**Vercel**
1. Push this folder to a new GitHub repo (e.g. `sdvsolution-app`).
2. vercel.com → New Project → import the repo.
3. Framework preset: **Vite**. Build command: `npm run build`. Output dir: `dist`.
4. Deploy → you get a URL like `https://sdvsolution-app.vercel.app`.

**Netlify**
1. Push to a repo, then netlify.com → Add new site → Import.
2. Build command: `npm run build`. Publish directory: `dist`. Deploy.

**GitHub Pages** (also possible)
- Set `base` in `vite.config.js` to `"/<repo-name>/"`, build, and publish `dist/`
  (e.g. via a Pages Action or the `gh-pages` branch).

## Custom subdomain: app.sdvsolution.com
In your host (Vercel/Netlify), add the domain `app.sdvsolution.com`. Then in
**Squarespace → Domains → sdvsolution.com → DNS → Custom Records**, add a **CNAME**:
- Name: `app`  →  Data: the target the host gives you
  (Vercel: `cname.vercel-dns.com` · Netlify: `<your-site>.netlify.app`).
Enable HTTPS in the host once DNS verifies. Your marketing site's
"Start free trial" / "Login" buttons already point to `https://app.sdvsolution.com`.

## Production note on Tailwind
`index.html` uses the Tailwind Play CDN so the app's utility classes work with zero
config. For a fully self‑hosted, optimized build, add Tailwind as a dev dependency
(`tailwindcss postcss autoprefixer`), a `tailwind.config.js` scanning `./src/**/*.{jsx}`,
and an `index.css` with the `@tailwind` directives imported in `main.jsx`; then remove
the CDN script.

## Next: real accounts & billing
To turn this into a paid SaaS (login, per‑user persistence, Stripe subscriptions),
add a backend: an auth provider, a database (multi‑tenant), and Stripe Billing with
entitlement gating. See `SDVsolution_Offering_Plan.md`.
