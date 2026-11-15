// =====================================================================
//  Per-site database (Cloudflare D1)
//  Public API for hosted sites:  /api/data/<slug>/...
//   • add a record to a collection        POST /api/data/<slug>/c/<coll>
//   • read a public collection            GET  /api/data/<slug>/c/<coll>?limit&sort&dir
//   • counters (likes, views...)          GET/POST /api/data/<slug>/n/<name>
//  Collections whose name starts with "_" are PRIVATE: visitors can only
//  write to them (e.g. a contact form); only the site owner reads them.
// =====================================================================

const MAX_RECORD = 4 * 1024;        // bytes per record
const MAX_RECORDS_PER_SITE = 10000;
const MAX_COUNTERS_PER_SITE = 200;
const NAME_RE = /^_?[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const FIELD_RE = /^[a-zA-Z0-9_]{1,40}$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function out(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...CORS },
  });
}

let ready = false;
export async function ensureSchema(env) {
  if (ready || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, coll TEXT NOT NULL,
      data TEXT NOT NULL, created INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS rec_site_coll ON records(site, coll, created)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS views (
      site TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(site, day))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS counters (
      site TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(site, name))`),
  ]);
  ready = true;
}

async function rateLimited(env, key) {
  if (!env.WRITE_LIMIT) return false;
  try { const { success } = await env.WRITE_LIMIT.limit({ key }); return !success; } catch { return false; }
}

const shape = r => {
  let d = {};
  try { d = JSON.parse(r.data); } catch {}
  return { id: r.id, created: r.created, ...d };
};

// ---------- public API used by hosted sites ----------
export async function handlePublicData(req, env, slug, rest) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return out({ error: "database not configured" }, 503);
  await ensureSchema(env);

  const site = await env.SITES.get("m:" + slug);
  if (!site) return out({ error: "site not found" }, 404);

  const [kind, name] = rest.split("/");
  if (!name || !NAME_RE.test(name)) return out({ error: "invalid name" }, 400);
  const isPrivate = name.startsWith("_");
  const ip = req.headers.get("cf-connecting-ip") || "local";

  // ----- collections -----
  if (kind === "c") {
    if (req.method === "GET") {
      if (isPrivate) return out({ error: "private collection" }, 403);
      const url = new URL(req.url);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
      const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
      const sort = url.searchParams.get("sort") || "created";
      if (sort !== "created" && !FIELD_RE.test(sort)) return out({ error: "invalid sort" }, 400);
      const orderBy = sort === "created" ? `created ${dir}, id ${dir}` : `json_extract(data, '$.' || ?3) ${dir}, id DESC`;
      const stmt = env.DB.prepare(`SELECT id, data, created FROM records WHERE site = ?1 AND coll = ?2 ORDER BY ${orderBy} LIMIT ${limit}`);
      const { results } = await (sort === "created" ? stmt.bind(slug, name) : stmt.bind(slug, name, sort)).all();
      return out({ items: results.map(shape) });
    }
    if (req.method === "POST") {
      if (await rateLimited(env, `${ip}:${slug}`)) return out({ error: "too many requests, slow down" }, 429);
      const text = await req.text();
      if (text.length > MAX_RECORD) return out({ error: "record too large (max 4KB)" }, 413);
      let data;
      try { data = JSON.parse(text); } catch { return out({ error: "invalid JSON" }, 400); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return out({ error: "record must be an object" }, 400);
      delete data.id; delete data.created;
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE site = ?1").bind(slug).first();
      if (n >= MAX_RECORDS_PER_SITE) return out({ error: "this site's database is full" }, 507);
      const created = Date.now();
      const r = await env.DB.prepare("INSERT INTO records (site, coll, data, created) VALUES (?1, ?2, ?3, ?4)")
        .bind(slug, name, JSON.stringify(data), created).run();
      return out(isPrivate ? { ok: true } : { ok: true, item: { id: r.meta.last_row_id, created, ...data } });
    }
  }

  // ----- counters -----
  if (kind === "n") {
    if (req.method === "GET") {
      const row = await env.DB.prepare("SELECT value FROM counters WHERE site = ?1 AND name = ?2").bind(slug, name).first();
      return out({ value: row ? row.value : 0 });
    }
    if (req.method === "POST") {
      if (await rateLimited(env, `${ip}:${slug}`)) return out({ error: "too many requests, slow down" }, 429);
      let by = 1;
      try { const b = await req.json(); if (b && (b.by === 1 || b.by === -1)) by = b.by; } catch {}
      const exists = await env.DB.prepare("SELECT 1 FROM counters WHERE site = ?1 AND name = ?2").bind(slug, name).first();
      if (!exists) {
        const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM counters WHERE site = ?1").bind(slug).first();
        if (n >= MAX_COUNTERS_PER_SITE) return out({ error: "too many counters" }, 507);
      }
      const row = await env.DB.prepare(
        "INSERT INTO counters (site, name, value) VALUES (?1, ?2, ?3) ON CONFLICT(site, name) DO UPDATE SET value = value + ?3 RETURNING value"
      ).bind(slug, name, by).first();
      return out({ value: row.value });
    }
  }
  return out({ error: "not found" }, 404);
}

// ---------- owner API (used from the admin page, session-authenticated) ----------
export async function ownerSummary(env, slug) {
  if (!env.DB) return { collections: [], counters: [], total: 0, max: MAX_RECORDS_PER_SITE };
  await ensureSchema(env);
  const { results: colls } = await env.DB.prepare(
    "SELECT coll AS name, COUNT(*) AS count, MAX(created) AS last FROM records WHERE site = ?1 GROUP BY coll ORDER BY last DESC"
  ).bind(slug).all();
  const { results: counters } = await env.DB.prepare("SELECT name, value FROM counters WHERE site = ?1 ORDER BY name").bind(slug).all();
  const total = colls.reduce((a, c) => a + c.count, 0);
  return { collections: colls, counters, total, max: MAX_RECORDS_PER_SITE };
}

export async function ownerList(env, slug, coll, before) {
  await ensureSchema(env);
  const b = parseInt(before || "0", 10);
  const { results } = await env.DB.prepare(
    `SELECT id, data, created FROM records WHERE site = ?1 AND coll = ?2 ${b ? "AND id < ?3" : ""} ORDER BY id DESC LIMIT 100`
  ).bind(...(b ? [slug, coll, b] : [slug, coll])).all();
  return results.map(shape);
}

export async function ownerDeleteRecord(env, slug, coll, id) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM records WHERE site = ?1 AND coll = ?2 AND id = ?3").bind(slug, coll, parseInt(id, 10)).run();
}

export async function ownerDeleteCollection(env, slug, coll) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM records WHERE site = ?1 AND coll = ?2").bind(slug, coll).run();
}

export async function ownerResetCounter(env, slug, name) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM counters WHERE site = ?1 AND name = ?2").bind(slug, name).run();
}

export async function deleteSiteData(env, slug) {
  if (!env.DB) return;
  await ensureSchema(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM records WHERE site = ?1").bind(slug),
    env.DB.prepare("DELETE FROM counters WHERE site = ?1").bind(slug),
    env.DB.prepare("DELETE FROM views WHERE site = ?1").bind(slug),
  ]);
}

export const NAME_OK = n => NAME_RE.test(n);

// ---------- the tiny library hosted sites load: <script src="/shigur.js"></script> ----------
export const SDK = `/* שיגור — מסד נתונים לאתר. תיעוד: /docs */
(function () {
  var m = location.pathname.match(/^\\/s\\/([a-z0-9-]+)\\//);
  var slug = m ? m[1] : null;
  var base = "/api/data/" + slug;
  function call(method, path, body) {
    if (!slug) return Promise.reject(new Error("shigur: הדף לא רץ מתוך אתר בשיגור"));
    return fetch(base + path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; });
    });
  }
  window.shigur = {
    site: slug,
    add: function (collection, data) { return call("POST", "/c/" + encodeURIComponent(collection), data).then(function (d) { return d.item || true; }); },
    send: function (collection, data) { return call("POST", "/c/" + encodeURIComponent(collection.charAt(0) === "_" ? collection : "_" + collection), data).then(function () { return true; }); },
    list: function (collection, opts) {
      opts = opts || {};
      var q = "?limit=" + (opts.limit || 50) + "&sort=" + encodeURIComponent(opts.sort || "created") + "&dir=" + (opts.dir || "desc");
      return call("GET", "/c/" + encodeURIComponent(collection) + q).then(function (d) { return d.items; });
    },
    count: function (name) { return call("GET", "/n/" + encodeURIComponent(name)).then(function (d) { return d.value; }); },
    increment: function (name) { return call("POST", "/n/" + encodeURIComponent(name), { by: 1 }).then(function (d) { return d.value; }); },
    decrement: function (name) { return call("POST", "/n/" + encodeURIComponent(name), { by: -1 }).then(function (d) { return d.value; }); }
  };
})();
`;

// ---------- page-view stats ----------
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless/i;
const israelDay = (t = Date.now()) => new Date(t + 2 * 3600e3).toISOString().slice(0, 10); // close enough for daily buckets

export function shouldCount(req) {
  if (req.method !== "GET") return false;
  if (BOT_RE.test(req.headers.get("user-agent") || "")) return false;
  const purpose = req.headers.get("sec-purpose") || req.headers.get("purpose") || "";
  if (/prefetch|prerender/i.test(purpose)) return false;
  return true;
}

export async function recordView(env, slug) {
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await env.DB.prepare("INSERT INTO views (site, day, n) VALUES (?1, ?2, 1) ON CONFLICT(site, day) DO UPDATE SET n = n + 1")
      .bind(slug, israelDay()).run();
  } catch {}
}

export async function siteStats(env, slug) {
  if (!env.DB) return { days: [], today: 0, week: 0, month: 0, total: 0 };
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT day, n FROM views WHERE site = ?1 ORDER BY day DESC LIMIT 400").bind(slug).all();
  const total = (await env.DB.prepare("SELECT COALESCE(SUM(n),0) AS t FROM views WHERE site = ?1").bind(slug).first()).t;
  const map = Object.fromEntries(results.map(r => [r.day, r.n]));
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = israelDay(Date.now() - i * 864e5); days.push({ day: d, n: map[d] || 0 }); }
  const sum = k => days.slice(-k).reduce((a, x) => a + x.n, 0);
  return { days, today: sum(1), week: sum(7), month: sum(30), total };
}
