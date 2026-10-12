// figurdiscover — Supabase Edge Function "ai-analyze"
// Sends the site's AI requests to Claude using YOUR Anthropic API key, kept secret on Supabase.
// Only signed-in users of your site can use it (protects your API bill).
// Secrets to add in Supabase → Edge Functions → Secrets:
//   ANTHROPIC_API_KEY = your key from console.anthropic.com   (required)
//   ANTHROPIC_MODEL   = claude-sonnet-5-5                       (optional)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) only signed-in users (a real user session, not the public anon key)
  const auth = req.headers.get("authorization") || "";
  try {
    const payload = JSON.parse(atob(auth.replace(/^Bearer\s+/i, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.role !== "authenticated") return json({ error: "login" }, 401);
  } catch (_) {
    return json({ error: "login" }, 401);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

  // 2) validate and limit the request size
  let body: { messages?: { role: string; content: string }[]; max_tokens?: number };
  try { body = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const messages = (body.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 30000) }));
  if (!messages.length || messages[0].role !== "user") return json({ error: "no messages" }, 400);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1500, 200), 2500);

  // 3) ask Claude
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
      max_tokens: maxTokens,
      system: "You are the analysis assistant of figurdiscover.com, a financial and statistical analysis website. Answer in the language of the user's message, clearly and concisely, using Markdown. Never invent numbers that are not in the data. Remind users that results are not binding financial, tax or legal advice.",
      messages,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: data?.error?.message || "anthropic " + r.status }, 502);
  const text = (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  return json({ text, truncated: data.stop_reason === "max_tokens" });
});
