# SDVsolution — Authentication & company isolation setup

This adds a real sign-in gate in front of the app and enforces **"Company X data
for Company X emails only"** on the server. It uses **Supabase** (managed auth +
Postgres). No separate backend server to run — the React app talks to Supabase
directly, and **Row-Level Security (RLS)** does the isolation.

Total time: ~20–30 minutes. Free tier is fine to start.

---

## Part 1 — Create the Supabase project

1. Go to **https://supabase.com** → sign up (use your SDVsolution email).
2. **New project**. Name it `sdvsolution`. Choose a region near your users.
   Set a strong database password (save it in your password manager).
3. Wait ~2 minutes for it to provision.

## Part 2 — Create the database schema (isolation rules)

1. In the project, open **SQL Editor → New query**.
2. Open `supabase/setup.sql` from this repo, copy **all** of it, paste, **Run**.
   You should see "Success." This creates the `organizations` and `memberships`
   tables, the sign-up trigger that assigns each user to their company by email
   domain, and the RLS policies that keep companies separated.
3. **Phase 2 (per-company data persistence):** open a new query, paste all of
   `supabase/phase2_workspaces.sql`, and **Run**. This adds the `workspaces`
   table (one JSON document per company) with RLS, so everything each company
   does in the tool — requirements, K-Matrix, imported DBC/LDF/ARXML, baselines,
   review status, standards — is saved to their own isolated row and reloaded on
   next sign-in. Skip this only if you want sign-in isolation without saved data.

## Part 3 — Configure auth behavior

1. **Authentication → Providers → Email**: make sure **Email** is enabled and
   **"Confirm email"** is **ON** (this is what proves a person controls their
   company address).
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://app.sdvsolution.com`
   - **Redirect URLs**: add `https://app.sdvsolution.com` (and
     `http://localhost:5173` for local testing).
3. Optional — **Authentication → Emails**: customize the confirmation and
   password-reset email templates with your branding.

## Part 4 — Get your API keys

1. **Project Settings → API**. Copy:
   - **Project URL** → this is `VITE_SUPABASE_URL`
   - **anon / public** key → this is `VITE_SUPABASE_ANON_KEY`
   (The **service_role** key is secret — never put it in this app.)

## Part 5 — Add the keys to Vercel

1. Vercel → your `sdvsolution-app` project → **Settings → Environment
   Variables**.
2. Add both, for **Production** and **Preview**:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
3. **Deployments → Redeploy** the latest so the new vars are baked in.

For local dev: copy `.env.example` to `.env` and fill in the same two values,
then `npm install && npm run dev`.

## Part 6 — Test

1. Open `https://app.sdvsolution.com`. You should now see the **Sign in** screen
   (not the tool).
2. **Sign up** with a work email, e.g. `you@yourcompany.com`. Confirm via the
   email link, then sign in — you land in the tool.
3. Try signing up with `someone@gmail.com` → it's rejected ("use your work
   email"). Your own address is allow-listed in `AuthGate.jsx` (`OWNER_EMAILS`)
   so you can always get in.
4. In Supabase → **Table Editor → organizations / memberships** you'll see the
   company row and the member row created automatically.

---

## How the company rule works

- Sign-up requires a work email. Public mailbox domains (gmail, outlook, …) are
  blocked for creating a company — see `PUBLIC_DOMAINS` in
  `src/auth/AuthGate.jsx`.
- The email's domain (`companyx.com`) is the company key. The DB trigger
  (`handle_new_user` in `setup.sql`) creates the org on the first user from a
  domain (that user becomes **owner**) and adds later same-domain users as
  **members**.
- **RLS** ensures every query is automatically filtered to the caller's org, so
  Company X can never read Company Y — even if someone tampers with the
  browser code, because the rule runs on Supabase's servers.

## Assistant — enable file reading & changes (Anthropic API)

The in-app **Assistant** (attach a PDF / Excel / Word file, or ask it to make
changes) calls Claude through a secure serverless proxy at `api/assistant.js`
so your API key never ships to the browser. To turn it on:

1. Get an API key from **console.anthropic.com → API Keys** (`sk-ant-...`).
2. Vercel → your project → **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key  (Production + Preview)
   - `ANTHROPIC_MODEL` = `claude-sonnet-5`  (optional — set a current model id)
3. **Redeploy.** The `api/` folder deploys automatically as a Vercel function.

Notes: API usage is billed to your Anthropic account. Attached files are read
in the browser; only the extracted text is sent with your message. The Assistant
can apply changes it's allowed to make (e.g. add interfaces, edit a node); it
states what it's changing first. Without the key set, the Assistant returns a
clear "backend not configured" message and the rest of the app is unaffected.

## Customizing

- **Allow-list your own domain / admins**: edit `OWNER_EMAILS` in `AuthGate.jsx`.
- **Add/remove blocked public domains**: edit `PUBLIC_DOMAINS` in `AuthGate.jsx`.
- **Pre-provision a company** (e.g. a signed customer) before they sign up:
  insert a row into `organizations` with their `domain` in the SQL Editor.
- **SSO** (SAML / Google Workspace) is an Enterprise-tier item; the "Sign in
  with SSO" button currently points customers to contact sales. Supabase
  supports SAML SSO on its Pro plan when you're ready.

## Team invites & roles (Phase 4)

Run **`supabase/phase4_team.sql`** once in the SQL Editor. It adds:

- Three roles — **owner · admin · editor**. Owner = billing + team + edit,
  Admin = team + edit, Editor = edit. Every member can edit and counts toward a
  billed seat. Legacy `member` rows are treated as `editor`.
- An **`invitations`** table + RLS so an owner/admin can pre-authorize a
  teammate's email (any domain — contractors on gmail etc. work once invited).
- The sign-up trigger now honors a pending invite **before** email-domain
  auto-join, so an invited user lands in the inviting company with the invited
  role.
- `email_is_invited()` (anon-callable) so AuthGate lets an invited personal-email
  address through the "use your work email" rule.
- A guard that blocks removing/demoting the **last owner** of a company.

**How inviting works (no email service needed):** in the app, top bar →
**Billing → Team** tab. Enter the teammate's email, pick a role, **Add to team**.
Share the app link; they sign up at `app.sdvsolution.com` with that email and are
dropped straight into your company with the assigned role. Owners/admins can
change roles or remove members from the same tab.

## What's NOT done yet (Phase 2)

Right now the **access** is gated and isolated, but the tool's requirements data
still lives in the browser session (it isn't saved to the company database yet).
To get shared, persistent, per-company data (real team collaboration + storage),
migrate the app's stores into the `projects` / `requirements` tables — the
template and matching RLS are at the bottom of `setup.sql`. See
`SDVsolution_Auth_Plan.md` for the phased plan.
