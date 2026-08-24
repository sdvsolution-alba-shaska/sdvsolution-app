// AuthGate — wraps the app so nobody reaches the tool without signing in.
// Handles: sign in, sign up (work-email/company-domain rule), email
// verification, forgot-password, and sign-out. Access isolation between
// companies is enforced server-side by Supabase RLS (see supabase/setup.sql);
// this component is the front door.
import React, { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabaseClient.js";

// Public / free mailbox providers are NOT companies — block them at sign-up so
// each account maps to a real corporate domain (Company X). Extend as needed.
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
  "pm.me", "msn.com", "qq.com", "163.com", "126.com",
]);

// Anyone in this set may sign up with any domain (platform owner/admins).
// Put your own address here so you can always get in.
const OWNER_EMAILS = new Set([
  "gshaska@gmail.com",
]);

// Your own staff domains — always allowed, never treated as "personal" email.
// Everyone with an address at one of these domains gets into the SDVsolution
// team workspace.
const OWNER_DOMAINS = new Set([
  "sdvsolution.com",
]);

function domainOf(email) {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

const wrap = {
  minHeight: "100vh", display: "flex", alignItems: "center",
  justifyContent: "center", background: "#F7F9FC",
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Helvetica,Arial,sans-serif",
  padding: 24,
};
const card = {
  width: "100%", maxWidth: 420, background: "#fff", borderRadius: 16,
  border: "1px solid #E4E7EC", boxShadow: "0 20px 60px rgba(16,24,40,.10)",
  padding: 32,
};
const label = { display: "block", fontSize: 13, fontWeight: 700, color: "#344054", margin: "16px 0 6px" };
const input = {
  width: "100%", boxSizing: "border-box", border: "1px solid #E4E7EC",
  borderRadius: 10, padding: "12px 14px", fontSize: 14, background: "#F9FAFB", color: "#101828",
};
const primaryBtn = {
  width: "100%", marginTop: 22, padding: "13px 16px", borderRadius: 10, border: "none",
  background: "#3730E0", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
};
const ghostBtn = {
  width: "100%", marginTop: 10, padding: "12px 16px", borderRadius: 10,
  border: "1px solid #E4E7EC", background: "#F9FAFB", color: "#101828",
  fontWeight: 600, fontSize: 14, cursor: "pointer",
};
const linkBtn = { background: "none", border: "none", color: "#3730E0", fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 };
const note = (color) => ({ fontSize: 13, fontWeight: 500, marginTop: 14, color, lineHeight: 1.5 });

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: "#9CFF3A", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#0F1B2D" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
      </span>
      <span style={{ fontWeight: 800, fontSize: 18, color: "#0F1B2D" }}>SDVsolution</span>
    </div>
  );
}

function ConfigMissing() {
  return (
    <div style={wrap}>
      <div style={card}>
        <Logo />
        <h2 style={{ fontSize: 20, color: "#0F1B2D", margin: "10px 0 8px" }}>Sign-in not configured yet</h2>
        <p style={note("#667085")}>
          This build needs its Supabase keys. Set <code>VITE_SUPABASE_URL</code> and
          <code> VITE_SUPABASE_ANON_KEY</code> in Vercel → Settings → Environment
          Variables (and in a local <code>.env</code>), then redeploy. See
          <code> AUTH_SETUP.md</code>.
        </p>
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  // ui state
  const [mode, setMode] = useState("signin"); // signin | signup | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!supabaseConfigured) { setChecking(false); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) return <ConfigMissing />;
  if (checking) {
    return <div style={{ ...wrap, color: "#667085" }}>Loading…</div>;
  }

  // Authenticated → render the actual app. Expose sign-out to the (import-free)
  // app so it can show a "Sign out" button in its own top bar next to App Feedback.
  if (session) {
    if (typeof window !== "undefined") {
      window.__sdvAuth = { signOut: () => supabase.auth.signOut(), email: session.user?.email || "" };
    }
    return <>{children}</>;
  }

  const reset = () => { setErr(""); setMsg(""); };

  async function handleSignIn(e) {
    e.preventDefault(); reset(); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setErr(error.message);
  }

  async function handleSignUp(e) {
    e.preventDefault(); reset();
    const clean = email.trim().toLowerCase();
    const dom = domainOf(clean);
    if (!dom) { setErr("Enter a valid email address."); return; }
    if (!OWNER_EMAILS.has(clean) && !OWNER_DOMAINS.has(dom) && PUBLIC_DOMAINS.has(dom)) {
      setErr("Please use your work email. Personal addresses (gmail, outlook, etc.) can't create a company workspace.");
      return;
    }
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setBusy(true);
    // The email domain is stored on the user; a DB trigger assigns them to
    // their company workspace and blocks cross-company access (see setup.sql).
    const { error } = await supabase.auth.signUp({
      email: clean,
      password,
      options: {
        data: { company_domain: dom },
        emailRedirectTo: window.location.origin,
      },
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMsg("Check your inbox to confirm your email, then sign in. Only teammates with an @" + dom + " address can join your company workspace.");
    setMode("signin");
  }

  async function handleForgot(e) {
    e.preventDefault(); reset();
    const clean = email.trim().toLowerCase();
    if (!clean) { setErr("Enter your email first."); return; }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(clean, { redirectTo: window.location.origin });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMsg("If that email has an account, a password-reset link is on its way.");
    setMode("signin");
  }

  const title = mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset password" : "Sign in";
  const onSubmit = mode === "signup" ? handleSignUp : mode === "forgot" ? handleForgot : handleSignIn;

  return (
    <div style={wrap}>
      <form style={card} onSubmit={onSubmit}>
        <Logo />
        <h2 style={{ fontSize: 24, color: "#0F1B2D", margin: "12px 0 4px" }}>{title}</h2>

        <label style={label} htmlFor="ag-email">Work email</label>
        <input id="ag-email" style={input} type="email" autoComplete="email"
               placeholder="you@company.com" value={email}
               onChange={(e) => setEmail(e.target.value)} required />

        {mode !== "forgot" && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 0 6px" }}>
              <label style={{ ...label, margin: 0 }} htmlFor="ag-pass">Password</label>
              {mode === "signin" && (
                <button type="button" style={linkBtn} onClick={() => { reset(); setMode("forgot"); }}>Forgot password?</button>
              )}
            </div>
            <input id="ag-pass" style={input} type="password"
                   autoComplete={mode === "signup" ? "new-password" : "current-password"}
                   placeholder={mode === "signup" ? "At least 8 characters" : "Password"}
                   value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        )}

        {err && <div style={note("#B42318")}>{err}</div>}
        {msg && <div style={note("#067647")}>{msg}</div>}

        <button style={primaryBtn} type="submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "→  Sign In"}
        </button>

        {mode === "signin" && (
          <button type="button" style={ghostBtn}
                  onClick={() => setErr("SSO is available on the Enterprise plan — contact hello@sdvsolution.com to set up SAML/Google Workspace SSO for your company.")}>
            ☁  Sign in with SSO
          </button>
        )}

        <div style={{ borderTop: "1px solid #EAECF0", margin: "22px 0 0", paddingTop: 18, textAlign: "center", fontSize: 14, color: "#344054" }}>
          {mode === "signin" ? (
            <>No account yet?{" "}
              <button type="button" style={linkBtn} onClick={() => { reset(); setMode("signup"); }}>→ Sign up</button>
            </>
          ) : (
            <>Already have an account?{" "}
              <button type="button" style={linkBtn} onClick={() => { reset(); setMode("signin"); }}>Sign in</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
