// =====================================================================
//  AI editor — edit a site's file from a plain-language request.
//  Uses the Anthropic API with the admin's key (stored in KV, never
//  sent back to the browser). The model returns exact search/replace
//  edits, so even big files cost little and nothing else is touched.
// =====================================================================

const MODEL = "claude-sonnet-5-5";
const MAX_FILE_CHARS = 120_000;       // ~30k tokens of input
const MAX_PROMPT = 2000;
export const AI_PER_DAY = 15;         // per user (admin: 100)
const ADMIN_PER_DAY = 100;
const EDITABLE = /\.(html?|css|js|mjs|json|txt|svg|xml|webmanifest)$/i;

const SYSTEM = `You edit one file of a static website hosted on "Shigur" (שיגור), an Israeli site host.
The user writes a request (usually in Hebrew). Make the change by calling the apply_edits tool.

Rules for edits:
- Each edit has "find" (an EXACT substring of the current file that appears EXACTLY ONCE — copy it character-for-character and include enough surrounding context to be unique) and "replace" (the new text).
- To add new content, anchor on a unique nearby string (for example "</body>" or "</style>") and include that anchor in "replace".
- Change only what the request needs. Keep the rest of the file byte-for-byte.
- Keep the site's language and direction (most sites are Hebrew, dir="rtl"). Write any new visible text in the site's language.
- Produce clean, modern, mobile-friendly HTML/CSS/JS.

Platform facts:
- Sites run in a sandbox: localStorage, sessionStorage, IndexedDB and cookies do NOT work.
- For data that must persist or be shared between visitors, use the Shigur database. Add once: <script src="/shigur.js"></script>
  API (all return Promises):
    shigur.add(collection, object)          -> saves a public record, returns it (with id, created)
    shigur.list(collection, {limit, sort, dir}) -> array of records; sort is a field name or "created"; dir "asc"|"desc"
    shigur.send(collection, object)         -> saves a PRIVATE record (contact forms) only the owner can read in the Shigur admin
    shigur.count(name) / shigur.increment(name) / shigur.decrement(name) -> counters
  Limits: 4KB per record, 20 writes per minute per visitor. For "live" updates, poll list() every few seconds.
- ALWAYS render visitor-submitted data with textContent (never innerHTML) to prevent XSS.
- Forms must call preventDefault() and save with the Shigur database (there is no server endpoint to POST to).

"summary": 1-2 short sentences IN HEBREW telling the user what you changed.
If the request is unclear, unsafe, or impossible on this platform, return no edits and explain why in "summary" (in Hebrew).`;

const TOOL = {
  name: "apply_edits",
  description: "Apply exact search/replace edits to the file and report a short Hebrew summary.",
  input_schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { find: { type: "string" }, replace: { type: "string" } },
          required: ["find", "replace"],
        },
      },
      summary: { type: "string" },
    },
    required: ["edits", "summary"],
  },
};

export const isEditable = p => EDITABLE.test(p);

export async function getKey(env) {
  return env.ANTHROPIC_API_KEY || (await env.SITES.get("sys:anthropic")) || "";
}

export function keyLooksValid(k) {
  return typeof k === "string" && /^sk-ant-[A-Za-z0-9_\-]{20,300}$/.test(k.trim());
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; if (n > 1) break; }
  return n;
}

export function applyEdits(text, edits) {
  const applied = [], failed = [];
  for (const e of edits || []) {
    if (typeof e.find !== "string" || typeof e.replace !== "string") { failed.push("עריכה לא תקינה"); continue; }
    const n = countOccurrences(text, e.find);
    if (n === 1) { text = text.replace(e.find, () => e.replace); applied.push(e.find.slice(0, 60)); }
    else failed.push(e.find.slice(0, 60));
  }
  return { text, applied, failed };
}

async function callClaude(env, url, key, file, content, prompt) {
  // local testing only
  if (env.TEST_AI_MOCK && url.hostname === "localhost") {
    return JSON.parse(env.TEST_AI_MOCK);
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "apply_edits" },
      messages: [{
        role: "user",
        content: `File: ${file}\n\n<current_file>\n${content}\n</current_file>\n\n<request>\n${prompt}\n</request>`,
      }],
    }),
  });
  if (!r.ok) {
    let msg = "";
    try { msg = (await r.json()).error?.message || ""; } catch {}
    if (r.status === 401) throw new Error("מפתח ה-API לא תקין. המנהל צריך לעדכן אותו.");
    if (r.status === 429 || r.status === 529) throw new Error("השירות עמוס כרגע, נסו שוב בעוד דקה.");
    if (/credit|billing|balance/i.test(msg)) throw new Error("נגמר הקרדיט בחשבון ה-API. צריך להטעין ב-console.anthropic.com.");
    throw new Error("שגיאה מה-AI (" + r.status + ")");
  }
  const data = await r.json();
  const tool = (data.content || []).find(c => c.type === "tool_use");
  if (!tool) throw new Error("ה-AI לא החזיר שינויים");
  return tool.input;
}

// POST /api/sites/:slug/ai  {file, prompt}
export async function handleAiEdit(req, env, url, user, slug, meta, typeOf) {
  const key = await getKey(env);
  if (!key) return { status: 503, body: { error: "עריכה עם AI עוד לא הופעלה. המנהל צריך להכניס מפתח API." } };

  let body = {};
  try { body = await req.json(); } catch {}
  const prompt = String(body.prompt || "").trim().slice(0, MAX_PROMPT);
  const file = String(body.file || "index.html");
  if (!prompt) return { status: 400, body: { error: "כתבו מה לשנות" } };
  if (!meta.files.includes(file) || !isEditable(file)) return { status: 400, body: { error: "אי אפשר לערוך את הקובץ הזה" } };

  const qKey = `ai:${user.sub}:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.SITES.get(qKey)) || "0", 10);
  const cap = user.admin ? ADMIN_PER_DAY : AI_PER_DAY;
  if (used >= cap) return { status: 429, body: { error: `הגעתם למכסה היומית (${cap} עריכות). נסו שוב מחר.` } };

  const raw = await env.SITES.get(`f:${slug}:${file}`, "arrayBuffer");
  if (!raw) return { status: 404, body: { error: "הקובץ לא נמצא" } };
  const content = new TextDecoder().decode(raw);
  if (content.length > MAX_FILE_CHARS) return { status: 413, body: { error: "הקובץ גדול מדי לעריכה עם AI (מקסימום כ-120KB)" } };

  // count the attempt before calling (protects the budget even if the call fails midway)
  await env.SITES.put(qKey, String(used + 1), { expirationTtl: 2 * 86400 });

  let result;
  try { result = await callClaude(env, url, key, file, content, prompt); }
  catch (e) { return { status: 502, body: { error: e.message } }; }

  const { text, applied, failed } = applyEdits(content, result.edits);
  if (!applied.length) {
    return { status: 200, body: { ok: false, summary: result.summary || "לא בוצעו שינויים", failed: failed.length, left: cap - used - 1 } };
  }

  // keep one level of undo
  await env.SITES.put(`bk:${slug}:${file}`, raw, { expirationTtl: 30 * 86400 });
  await env.SITES.put(`f:${slug}:${file}`, new TextEncoder().encode(text), { metadata: { t: typeOf(file) } });
  return { status: 200, body: { ok: true, summary: result.summary, applied: applied.length, failed: failed.length, left: cap - used - 1 } };
}

// POST /api/sites/:slug/undo {file}
export async function handleUndo(req, env, slug, meta, typeOf) {
  let body = {};
  try { body = await req.json(); } catch {}
  const file = String(body.file || "index.html");
  if (!meta.files.includes(file)) return { status: 400, body: { error: "קובץ לא תקין" } };
  const bk = await env.SITES.get(`bk:${slug}:${file}`, "arrayBuffer");
  if (!bk) return { status: 404, body: { error: "אין שינוי לבטל" } };
  await env.SITES.put(`f:${slug}:${file}`, bk, { metadata: { t: typeOf(file) } });
  await env.SITES.delete(`bk:${slug}:${file}`);
  return { status: 200, body: { ok: true } };
}
