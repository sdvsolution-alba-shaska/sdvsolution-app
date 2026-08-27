// POST /api/feedback — create a Jira issue from the in-app "App Feedback" form.
// Runs server-side so the Jira API token is never exposed to the browser, and
// external users (who have no Jira access) can still file feedback.
//
// Vercel env vars (Production):
//   JIRA_BASE_URL     e.g. https://sdvsolution.atlassian.net   (no trailing slash needed)
//   JIRA_EMAIL        the Atlassian account email that owns the API token
//   JIRA_API_TOKEN    from id.atlassian.com → Security → API tokens
//   JIRA_PROJECT_KEY  e.g. AF  (or SCRUM)
//   JIRA_ISSUETYPE    optional, default "Task" (must exist in the project)

function adf(description, context, reporter) {
  const p = (text, strong) => ({ type: "paragraph", content: [{ type: "text", text: String(text || ""), ...(strong ? { marks: [{ type: "strong" }] } : {}) }] });
  const content = [];
  if (description && description.trim()) content.push(p(description));
  content.push(p("Environment", true));
  const c = context || {};
  const line = (k, v) => content.push(p(k + ": " + (v == null || v === "" ? "—" : v)));
  if (reporter) line("Reporter", reporter);
  line("Project", c.project); line("View", c.view); line("Focus", c.focusNode);
  line("Selected", c.selectedNode); line("Table filter", c.filter); line("Loaded", c.loaded);
  line("App version", c.appVersion); line("Time", c.when); line("Browser", c.agent);
  return { type: "doc", version: 1, content };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const base = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  const email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY, issuetype = process.env.JIRA_ISSUETYPE || "Task";
  if (!base || !email || !token || !projectKey) { res.status(500).json({ error: "Jira env vars not set (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY)." }); return; }

  let body = req.body;
  try { if (body == null || typeof body === "string") { let raw = typeof body === "string" ? body : await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }); body = raw ? JSON.parse(raw) : {}; } }
  catch (e) { res.status(400).json({ error: "Invalid JSON body" }); return; }

  const type = (body.type === "Bug" ? "Bug" : "Improvement");
  const summary = String(body.summary || "").trim().slice(0, 240);
  if (!summary) { res.status(400).json({ error: "Summary is required" }); return; }

  const payload = {
    fields: {
      project: { key: projectKey },
      summary: "[" + type + "] " + summary,
      description: adf(body.description, body.context, body.reporter),
      issuetype: { name: issuetype },
      labels: ["app-feedback", type.toLowerCase()],
    },
  };

  try {
    const auth = "Basic " + Buffer.from(email + ":" + token).toString("base64");
    const r = await fetch(base + "/rest/api/3/issue", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) { res.status(r.status).json({ error: "Jira rejected the request", detail: text.slice(0, 500) }); return; }
    let data = {}; try { data = JSON.parse(text); } catch (e) {}
    res.status(200).json({ key: data.key || null, url: data.key ? base + "/browse/" + data.key : null });
  } catch (e) {
    res.status(502).json({ error: "Could not reach Jira: " + (e && e.message ? e.message : String(e)) });
  }
}
