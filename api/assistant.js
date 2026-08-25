// Vercel serverless function — secure proxy to the Anthropic Messages API.
// The browser calls POST /api/assistant with { model, system, messages, max_tokens };
// the secret API key stays here on the server and is never exposed to the client.
//
// Set these in Vercel → Project → Settings → Environment Variables:
//   ANTHROPIC_API_KEY  (required)  — your Anthropic API key (sk-ant-...)
//   ANTHROPIC_MODEL    (optional)  — a current model id, e.g. claude-sonnet-5
//
// Usage of this key is billed to your Anthropic account.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in the server environment." });
    return;
  }

  // Parse the body (Vercel may pre-parse JSON, or hand us a raw string/stream).
  let payload = req.body;
  try {
    if (payload == null || typeof payload === "string") {
      let raw = typeof payload === "string" ? payload : "";
      if (!raw) raw = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
      payload = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  // Force a valid, current model (client value is ignored) and cap tokens.
  payload.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  payload.max_tokens = Math.min(Math.max(1, payload.max_tokens || 1200), 4096);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader("content-type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "Upstream error: " + (e && e.message ? e.message : String(e)) });
  }
}
