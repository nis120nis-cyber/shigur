import { unzipSync } from "fflate";
import UI_HTML from "./ui.html";
import { PRIVACY, TERMS, DOCS } from "./legal.js";
import { handlePublicData, ownerSummary, ownerList, ownerDeleteRecord, ownerDeleteCollection, ownerResetCounter, deleteSiteData, NAME_OK, SDK } from "./data.js";

// =====================================================================
//  שיגור — upload files, get a live website
//  Login: "Sign in with Google". The Google ID token is verified on the
//  server (signature against Google's public keys, audience, issuer,
//  expiry, verified email). No passwords, no client secret.
//  See SECURITY.md for the full model.
// =====================================================================

// ---------- settings ----------
const MAX_TOTAL = 50 * 1024 * 1024;   // 50MB per site (uncompressed)
const MAX_FILE = 24 * 1024 * 1024;    // KV limit is 25MiB per value
const MAX_FILES = 500;                // files per site
const SITES_PER_PERIOD = 2;           // new sites a user may create per period (admin is unlimited)
const PERIOD_MONTHS = 4;              // rolling window; deleting a site does NOT give the slot back
const DAILY_FILES_PER_USER = 300;     // file writes per user per day (protects the free KV quota)
const SESSION_DAYS = 7;
const COOKIE = "__Host-shigur";
const RESERVED = new Set(["api", "admin", "s", "www", "static", "login"]);
const GOOGLE_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

const TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  pdf: "application/pdf", wasm: "application/wasm", webmanifest: "application/manifest+json",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
};
const typeOf = p => TYPES[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

const BASE_SEC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...BASE_SEC, ...extra },
  });
}

// ---------- encoding helpers ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Google ID token verification ----------
let jwksCache = null; // { keys, exp }
async function googleKeys(env, url) {
  // local testing only: allows a test key set on localhost
  if (env.TEST_JWKS && url.hostname === "localhost") return JSON.parse(env.TEST_JWKS).keys;
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const r = await fetch(GOOGLE_JWKS, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error("jwks");
  const { keys } = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  jwksCache = { keys, exp: Date.now() + Math.min(parseInt(m ? m[1] : "3600", 10), 21600) * 1000 };
  return keys;
}

async function verifyGoogleToken(env, url, token) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(dec.decode(fromB64u(parts[0])));
    payload = JSON.parse(dec.decode(fromB64u(parts[1])));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;

  const keys = await googleKeys(env, url);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64u(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISS.has(payload.iss)) return null;
  if (payload.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (typeof payload.exp !== "number" || payload.exp < now - 60) return null;
  if (typeof payload.iat === "number" && payload.iat > now + 300) return null;
  if (!payload.sub || !payload.email || payload.email_verified !== true) return null;
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), name: String(payload.name || payload.email).slice(0, 80) };
}

// ---------- sessions (HMAC-signed cookie, secret kept in KV) ----------
let secretCache = null;
async function sessionKey(env) {
  if (!secretCache) {
    let s = await env.SITES.get("sys:secret");
    if (!s) {
      s = b64u(crypto.getRandomValues(new Uint8Array(32)));
      await env.SITES.put("sys:secret", s);
    }
    secretCache = s;
  }
  return crypto.subtle.importKey("raw", enc.encode(secretCache), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeSession(env, user) {
  const payload = b64u(enc.encode(JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload)));
  return payload + "." + sig;
}

async function readSession(env, token) {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), fromB64u(sig), enc.encode(payload));
    if (!ok) return null;
    const s = JSON.parse(dec.decode(fromB64u(payload)));
    if (typeof s.exp !== "number" || s.exp < Date.now() || !s.sub) return null;
    return s;
  } catch { return null; }
}

function getCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
const sessionCookie = (v, maxAge) => `${COOKIE}=${v}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

// same-origin + custom header = no CSRF; also blocks sandboxed hosted pages (Origin: null)
function sameOrigin(req, url) {
  if (req.headers.get("x-shigur") !== "1") return false;
  const o = req.headers.get("origin");
  if (o && o !== url.origin) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return true;
}

async function isAdmin(env, email) {
  return !!env.ADMIN_EMAIL_SHA256 && (await sha256hex(email)) === env.ADMIN_EMAIL_SHA256;
}

async function currentUser(req, env, url) {
  if (!sameOrigin(req, url)) return null;
  const s = await readSession(env, getCookie(req, COOKIE));
  if (!s) return null;
  if (await env.SITES.get("ban:" + s.sub)) return null;
  s.admin = await isAdmin(env, s.email);
  return s;
}

// ---------- slugs & paths ----------
function cleanSlug(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function randomSlug() {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => a[b % a.length]).join("");
}
function cleanPath(p) {
  p = String(p).replace(/\\/g, "/").replace(/^\/+/, "");
  if (/[\x00-\x1f]/.test(p)) return null;
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out || out.length > 300 || out.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(out) || /(^|\/)Thumbs\.db$/i.test(out)) return null;
  return out;
}
function normalize(files) {
  let paths = Object.keys(files);
  if (!paths.length) return files;
  const tops = new Set(paths.map(p => p.includes("/") ? p.split("/")[0] : ""));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0] + "/";
    const out = {};
    for (const p of paths) out[p.slice(top.length)] = files[p];
    files = out; paths = Object.keys(files);
  }
  if (!files["index.html"]) {
    const htmls = paths.filter(p => /\.html?$/i.test(p) && !p.includes("/"));
    if (htmls.length === 1) { files["index.html"] = files[htmls[0]]; delete files[htmls[0]]; }
  }
  return files;
}

// ---------- per-user index ----------
async function userSites(env, sub) {
  return (await env.SITES.get("u:" + sub, "json")) || [];
}
async function setUserSites(env, sub, list) {
  if (list.length) await env.SITES.put("u:" + sub, JSON.stringify(list));
  else await env.SITES.delete("u:" + sub);
}

// ---------- creation limit: 2 new sites per rolling 4 months ----------
function addMonths(t, m) { const d = new Date(t); d.setMonth(d.getMonth() + m); return d.getTime(); }
async function creationLog(env, sub) {
  const log = (await env.SITES.get("cl:" + sub, "json")) || [];
  const since = addMonths(Date.now(), -PERIOD_MONTHS);
  return log.filter(t => t > since).sort((a, b) => a - b);
}
async function planFor(env, user) {
  const recent = await creationLog(env, user.sub);
  const left = Math.max(0, SITES_PER_PERIOD - recent.length);
  return {
    perPeriod: SITES_PER_PERIOD, months: PERIOD_MONTHS, created: recent.length, left,
    nextAt: left ? null : addMonths(recent[0], PERIOD_MONTHS), unlimited: !!user.admin,
  };
}

// ---------- upload ----------
async function handleUpload(req, env, url, user) {
  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_TOTAL + 1024 * 1024) return json({ error: "האתר גדול מ-50MB" }, 413);

  let form;
  try { form = await req.formData(); } catch { return json({ error: "בקשה לא תקינה" }, 400); }

  const name = String(form.get("name") || "").replace(/[\x00-\x1f]/g, "").slice(0, 80);
  let slug = cleanSlug(form.get("slug"));
  const replace = form.get("replace") === "1";

  let files = {}, total = 0;
  const all = form.getAll("files");
  const relPaths = form.getAll("paths");
  if (all.length > MAX_FILES) return json({ error: `יותר מדי קבצים (מקסימום ${MAX_FILES})` }, 413);

  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    if (typeof entry === "string") continue;
    const buf = new Uint8Array(await entry.arrayBuffer());
    const rel = relPaths[i] || entry.name;
    if (/\.zip$/i.test(entry.name) && all.length === 1) {
      let declared = 0, count = 0, tooBig = false, unz;
      try {
        unz = unzipSync(buf, {
          filter: f => {
            if (f.name.endsWith("/")) return false;
            count++; declared += f.originalSize;
            if (count > MAX_FILES || declared > MAX_TOTAL || f.originalSize > MAX_FILE) { tooBig = true; return false; }
            return true;
          },
        });
      } catch { return json({ error: "קובץ ה-ZIP פגום" }, 400); }
      if (tooBig) return json({ error: "ה-ZIP גדול מדי אחרי פתיחה (מקסימום 50MB / 500 קבצים)" }, 413);
      for (const [p, data] of Object.entries(unz)) {
        const cp = cleanPath(p);
        if (cp) { files[cp] = data; total += data.length; }
      }
    } else {
      const cp = cleanPath(rel);
      if (cp) { files[cp] = buf; total += buf.length; }
    }
    if (total > MAX_TOTAL) return json({ error: "האתר גדול מ-50MB" }, 413);
  }

  files = normalize(files);
  const paths = Object.keys(files);
  if (!paths.length) return json({ error: "לא נמצאו קבצים" }, 400);
  if (paths.length > MAX_FILES) return json({ error: `יותר מדי קבצים (מקסימום ${MAX_FILES})` }, 413);
  if (!files["index.html"]) return json({ error: "חסר קובץ index.html באתר" }, 400);
  for (const p of paths) if (files[p].length > MAX_FILE) return json({ error: `הקובץ ${p} גדול מדי` }, 413);

  // daily quota
  const qKey = `q:${user.sub}:${today()}`;
  const used = parseInt((await env.SITES.get(qKey)) || "0", 10);
  if (!user.admin && used + paths.length > DAILY_FILES_PER_USER) {
    return json({ error: `הגעתם למכסה היומית (${DAILY_FILES_PER_USER} קבצים ביום). נסו שוב מחר.` }, 429);
  }

  const mine = await userSites(env, user.sub);
  let existing = null;
  if (slug) {
    if (RESERVED.has(slug)) return json({ error: "השם הזה שמור, בחרו אחר" }, 409);
    existing = await env.SITES.get("m:" + slug, "json");
    if (existing) {
      if (!replace) return json({ error: "השם תפוס", taken: true }, 409);
      if (existing.owner !== user.sub && !user.admin) return json({ error: "האתר הזה שייך למישהו אחר" }, 403);
    }
  } else {
    do { slug = randomSlug(); } while (await env.SITES.get("m:" + slug));
  }
  let recent = null;
  if (!existing && !user.admin) {
    recent = await creationLog(env, user.sub);
    if (recent.length >= SITES_PER_PERIOD) {
      const next = new Date(addMonths(recent[0], PERIOD_MONTHS)).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
      return json({ error: `אפשר ליצור עד ${SITES_PER_PERIOD} אתרים חדשים בכל ${PERIOD_MONTHS} חודשים. האתר הבא יתאפשר ב-${next}. בינתיים אפשר לעדכן אתרים קיימים.`, limit: true }, 403);
    }
  }

  const owner = existing ? existing.owner : user.sub;
  const ownerEmail = existing ? existing.ownerEmail : user.email;
  if (existing) await deleteFiles(env, slug, existing);

  for (const p of paths) {
    await env.SITES.put(`f:${slug}:${p}`, files[p], { metadata: { t: typeOf(p) } });
  }
  await env.SITES.put(qKey, String(used + paths.length), { expirationTtl: 2 * 86400 });

  const meta = { slug, name: name || slug, created: Date.now(), files: paths, size: total, owner, ownerEmail };
  await env.SITES.put("m:" + slug, JSON.stringify(meta), {
    metadata: { name: meta.name, created: meta.created, size: total, count: paths.length, owner, ownerEmail },
  });
  if (owner === user.sub && !mine.includes(slug)) { mine.push(slug); await setUserSites(env, user.sub, mine); }
  if (recent) { recent.push(Date.now()); await env.SITES.put("cl:" + user.sub, JSON.stringify(recent)); }

  return json({ ok: true, slug, url: `${url.origin}/s/${slug}/` });
}

async function deleteFiles(env, slug, meta) {
  for (const p of meta.files || []) await env.SITES.delete(`f:${slug}:${p}`);
}

async function deleteSite(env, slug, user) {
  const meta = await env.SITES.get("m:" + slug, "json");
  if (!meta) return { ok: false, status: 404 };
  if (user && meta.owner !== user.sub && !user.admin) return { ok: false, status: 403 };
  await deleteFiles(env, slug, meta);
  await env.SITES.delete("m:" + slug);
  await deleteSiteData(env, slug);
  const list = await userSites(env, meta.owner);
  await setUserSites(env, meta.owner, list.filter(s => s !== slug));
  return { ok: true };
}

async function listSites(env, origin, user) {
  const out = [];
  if (user.admin) {
    let cursor;
    do {
      const r = await env.SITES.list({ prefix: "m:", cursor });
      for (const k of r.keys) {
        const md = k.metadata || {};
        out.push({ slug: k.name.slice(2), url: `${origin}/s/${k.name.slice(2)}/`, ...md, mine: md.owner === user.sub });
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
  } else {
    for (const slug of await userSites(env, user.sub)) {
      const m = await env.SITES.get("m:" + slug, "json");
      if (m) out.push({ slug, url: `${origin}/s/${slug}/`, name: m.name, created: m.created, size: m.size, count: m.files.length, mine: true });
    }
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

// ---------- serving hosted sites ----------
const SITE_SEC = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

async function serveSite(req, env, slug, rest) {
  let path;
  try { path = decodeURIComponent(rest || ""); } catch { path = rest || ""; }
  const tryKeys = (!path || path.endsWith("/")) ? [path + "index.html"] : [path, path + ".html", path + "/index.html"];
  for (const p of tryKeys) {
    const { value, metadata } = await env.SITES.getWithMetadata(`f:${slug}:${p}`, "arrayBuffer");
    if (value) {
      if (p === path + "/index.html") return Response.redirect(new URL(req.url).href.replace(/\/?(\?.*)?$/, "/$1"), 301);
      return new Response(req.method === "HEAD" ? null : value, {
        headers: {
          "content-type": (metadata && metadata.t) || typeOf(p),
          "cache-control": /\.html?$/i.test(p) ? "public, max-age=60" : "public, max-age=3600",
          ...SITE_SEC,
        },
      });
    }
  }
  const nf = await env.SITES.get(`f:${slug}:404.html`, "arrayBuffer");
  if (nf) return new Response(nf, { status: 404, headers: { "content-type": "text/html; charset=utf-8", ...SITE_SEC } });
  const exists = await env.SITES.get("m:" + slug);
  return new Response(exists ? "הדף לא נמצא" : "האתר לא קיים", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...SITE_SEC } });
}

// ---------- admin page ----------
function adminPage(env) {
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const html = UI_HTML
    .replaceAll("<script>", `<script nonce="${nonce}">`)
    .replace("__CLIENT_ID__", String(env.GOOGLE_CLIENT_ID || "").replace(/[^A-Za-z0-9.\-_]/g, ""));
  const g = "https://accounts.google.com/gsi/";
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}' ${g}client; style-src 'unsafe-inline' https://fonts.googleapis.com ${g}style; ` +
        `font-src https://fonts.gstatic.com; img-src data: https://*.googleusercontent.com; connect-src 'self' ${g}; ` +
        `frame-src ${g}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      "cross-origin-opener-policy": "same-origin-allow-popups",
      ...BASE_SEC,
    },
  });
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const ready = !!env.GOOGLE_CLIENT_ID;

    const m = p.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      if (!m[2]) return Response.redirect(`${url.origin}/s/${m[1]}/${url.search}`, 301);
      return serveSite(req, env, m[1], m[2].slice(1));
    }

    // per-site database: public API for hosted sites + the JS library
    if (p === "/shigur.js") {
      return new Response(SDK, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" } });
    }
    const dm = p.match(/^\/api\/data\/([a-z0-9-]+)\/([cn]\/[^/]+)$/);
    if (dm) return handlePublicData(req, env, dm[1], dm[2]);
    if (p.startsWith("/api/data/")) return json({ error: "not found" }, 404);

    if (p === "/" && req.method === "GET") return adminPage(env);
    if (p === "/docs") {
      return new Response(DOCS, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", ...BASE_SEC } });
    }
    if (p === "/privacy" || p === "/terms") {
      return new Response(p === "/privacy" ? PRIVACY : TERMS, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", ...BASE_SEC, "x-robots-tag": "index" } });
    }
    if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\nAllow: /s/\nAllow: /privacy\nAllow: /terms\nAllow: /docs\n", { headers: { "content-type": "text/plain" } });

    if (p.startsWith("/api/")) {
      if (p === "/api/status" && req.method === "GET") {
        let me = null;
        if (ready) {
          const s = await readSession(env, getCookie(req, COOKIE));
          if (s && !(await env.SITES.get("ban:" + s.sub))) me = { name: s.name, email: s.email, admin: await isAdmin(env, s.email) };
        }
        return json({ ready, me });
      }
      if (!ready) return json({ error: "האתר לא מוגדר" }, 503);

      if (p === "/api/login" && req.method === "POST") {
        if (!sameOrigin(req, url)) return json({ error: "בקשה נדחתה" }, 403);
        let body = {};
        try { body = await req.json(); } catch {}
        let user;
        try { user = await verifyGoogleToken(env, url, body.credential); } catch { return json({ error: "לא הצלחנו לאמת מול גוגל, נסו שוב" }, 502); }
        if (!user) return json({ error: "ההתחברות נכשלה" }, 401);
        if (await env.SITES.get("ban:" + user.sub)) return json({ error: "החשבון הזה נחסם" }, 403);
        const admin = await isAdmin(env, user.email);
        return json({ ok: true, me: { name: user.name, email: user.email, admin } }, 200,
          { "set-cookie": sessionCookie(await makeSession(env, user), SESSION_DAYS * 86400) });
      }

      if (p === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

      const user = await currentUser(req, env, url);
      if (!user) return json({ error: "צריך להתחבר" }, 401);

      if (p === "/api/upload" && req.method === "POST") return handleUpload(req, env, url, user);
      if (p === "/api/sites" && req.method === "GET") return json({ sites: await listSites(env, url.origin, user), admin: user.admin });

      const del = p.match(/^\/api\/sites\/([a-z0-9-]+)$/);
      if (del && req.method === "DELETE") {
        const r = await deleteSite(env, del[1], user);
        return json(r.ok ? { ok: true } : { error: r.status === 403 ? "זה לא האתר שלך" : "לא נמצא" }, r.ok ? 200 : r.status);
      }

      // ----- plan & purchase (any user) -----
      if (p === "/api/me/plan" && req.method === "GET") return json(await planFor(env, user));
      // owner: manage a site's data
      const om = p.match(/^\/api\/sites\/([a-z0-9-]+)\/(data|counters)(?:\/([^/]+))?(?:\/(\d+))?$/);
      if (om) {
        const [, slug, what, name, id] = om;
        const meta = await env.SITES.get("m:" + slug, "json");
        if (!meta) return json({ error: "לא נמצא" }, 404);
        if (meta.owner !== user.sub && !user.admin) return json({ error: "זה לא האתר שלך" }, 403);
        if (!env.DB) return json({ error: "מסד הנתונים לא מוגדר" }, 503);
        if (name && !NAME_OK(name)) return json({ error: "שם לא תקין" }, 400);
        if (what === "data" && !name && req.method === "GET") return json(await ownerSummary(env, slug));
        if (what === "data" && name && !id && req.method === "GET") return json({ items: await ownerList(env, slug, name, url.searchParams.get("before")) });
        if (what === "data" && name && !id && req.method === "DELETE") { await ownerDeleteCollection(env, slug, name); return json({ ok: true }); }
        if (what === "data" && name && id && req.method === "DELETE") { await ownerDeleteRecord(env, slug, name, id); return json({ ok: true }); }
        if (what === "counters" && name && req.method === "DELETE") { await ownerResetCounter(env, slug, name); return json({ ok: true }); }
        return json({ error: "לא נמצא" }, 404);
      }

      if (p === "/api/slug" && req.method === "GET") {
        const s = cleanSlug(url.searchParams.get("s"));
        if (!s) return json({ slug: "", free: false });
        return json({ slug: s, free: !RESERVED.has(s) && !(await env.SITES.get("m:" + s)) });
      }

      // admin: block a user and delete all their sites
      if (p === "/api/ban" && req.method === "POST") {
        if (!user.admin) return json({ error: "אין הרשאה" }, 403);
        let body = {};
        try { body = await req.json(); } catch {}
        const sub = String(body.owner || "");
        if (!sub || sub === user.sub) return json({ error: "בקשה לא תקינה" }, 400);
        await env.SITES.put("ban:" + sub, "1");
        for (const slug of await userSites(env, sub)) await deleteSite(env, slug, null);
        return json({ ok: true });
      }

      return json({ error: "לא נמצא" }, 404);
    }

    return new Response("לא נמצא", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...BASE_SEC } });
  },
};
