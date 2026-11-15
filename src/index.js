import { unzipSync } from "fflate";
import UI_HTML from "./ui.html";

// =====================================================================
//  שיגור — upload files, get a live website
//  Security model (see SECURITY.md):
//   • Login with a password → HttpOnly + Secure + SameSite=Strict cookie
//     holding an HMAC-signed session. The password is never stored in
//     the browser, so page scripts cannot read it.
//   • Brute-force protection: 5 wrong passwords per IP → 15 min lockout.
//   • Every write needs the session cookie + a custom header + same-origin.
//   • Hosted sites run sandboxed (CSP sandbox, opaque origin), so a hosted
//     page can never touch the admin session, cookies or API.
//   • Strict security headers on the admin page (CSP with nonce, no
//     framing, HSTS, no indexing).
//   • Upload checks: size limits, file-count limits, zip-bomb guard,
//     path-traversal guard.
// =====================================================================

// ---------- settings ----------
const MAX_TOTAL = 50 * 1024 * 1024;   // 50MB per site (uncompressed)
const MAX_FILE = 24 * 1024 * 1024;    // KV limit is 25MiB per value
const MAX_FILES = 500;
const MIN_KEY_LEN = 12;               // minimum password length
const SESSION_DAYS = 7;
const MAX_FAILS = 5;                  // wrong passwords before lockout
const LOCK_SECONDS = 15 * 60;
const COOKIE = "__Host-shigur";
const RESERVED = new Set(["api", "admin", "s", "www", "static", "login"]);

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

// headers on every API / admin response
const BASE_SEC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...BASE_SEC, ...extra },
  });
}

// ---------- crypto helpers ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function hmacKey(env) {
  // SESSION_SECRET is optional; otherwise derived from the password.
  // Changing UPLOAD_KEY therefore logs out every device.
  const secret = env.SESSION_SECRET || ("shigur-session:" + env.UPLOAD_KEY);
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// constant-time password check (compare HMACs so length doesn't leak)
async function passwordOk(env, given) {
  if (!env.UPLOAD_KEY || typeof given !== "string") return false;
  const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", k, enc.encode(given)),
    crypto.subtle.sign("HMAC", k, enc.encode(env.UPLOAD_KEY)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function makeSession(env) {
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, n: b64u(crypto.getRandomValues(new Uint8Array(12))) })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
  return payload + "." + sig;
}

async function sessionOk(env, token) {
  if (!token || !env.UPLOAD_KEY) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64u(sig), enc.encode(payload));
    if (!valid) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    return typeof exp === "number" && exp > Date.now();
  } catch { return false; }
}

function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

// same-origin + custom header = no CSRF, and blocks sandboxed hosted pages (Origin: null)
function sameOrigin(req, url) {
  if (req.headers.get("x-shigur") !== "1") return false;
  const o = req.headers.get("origin");
  if (o && o !== url.origin) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return true;
}

async function authed(req, env, url) {
  return sameOrigin(req, url) && (await sessionOk(env, getCookie(req, COOKIE)));
}

// ---------- brute-force protection ----------
const ipOf = req => req.headers.get("cf-connecting-ip") || "local";
async function lockedOut(env, ip) {
  const n = parseInt((await env.SITES.get("rl:" + ip)) || "0", 10);
  return n >= MAX_FAILS;
}
async function recordFail(env, ip) {
  const n = parseInt((await env.SITES.get("rl:" + ip)) || "0", 10) + 1;
  await env.SITES.put("rl:" + ip, String(n), { expirationTtl: LOCK_SECONDS });
  return n;
}

// ---------- slugs & paths ----------
function cleanSlug(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function randomSlug() {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, b => a[b % a.length]).join("");
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

// strip a single shared top folder ("my-site/index.html" -> "index.html")
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
    if (htmls.length === 1) files["index.html"] = files[htmls[0]];
  }
  return files;
}

// ---------- upload ----------
async function handleUpload(req, env, url) {
  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_TOTAL + 1024 * 1024) return json({ error: "האתר גדול מ-50MB" }, 413);

  let form;
  try { form = await req.formData(); } catch { return json({ error: "בקשה לא תקינה" }, 400); }

  const name = String(form.get("name") || "").replace(/[\x00-\x1f]/g, "").slice(0, 80);
  let slug = cleanSlug(form.get("slug"));
  const replace = form.get("replace") === "1";

  let files = {};
  let total = 0;
  const all = form.getAll("files");
  const relPaths = form.getAll("paths");
  if (all.length > MAX_FILES) return json({ error: `יותר מדי קבצים (מקסימום ${MAX_FILES})` }, 413);

  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    if (typeof entry === "string") continue;
    const buf = new Uint8Array(await entry.arrayBuffer());
    const rel = relPaths[i] || entry.name;

    if (/\.zip$/i.test(entry.name) && all.length === 1) {
      // zip-bomb guard: check declared sizes BEFORE decompressing
      let declared = 0, count = 0, tooBig = false;
      let unz;
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
        if (!cp) continue;
        files[cp] = data; total += data.length;
      }
    } else {
      const cp = cleanPath(rel);
      if (!cp) continue;
      files[cp] = buf; total += buf.length;
    }
    if (total > MAX_TOTAL) return json({ error: "האתר גדול מ-50MB" }, 413);
  }

  files = normalize(files);
  const paths = Object.keys(files);
  if (!paths.length) return json({ error: "לא נמצאו קבצים" }, 400);
  if (paths.length > MAX_FILES) return json({ error: `יותר מדי קבצים (מקסימום ${MAX_FILES})` }, 413);
  if (!files["index.html"]) return json({ error: "חסר קובץ index.html באתר" }, 400);
  for (const p of paths) if (files[p].length > MAX_FILE) return json({ error: `הקובץ ${p} גדול מדי` }, 413);

  if (slug) {
    if (RESERVED.has(slug)) return json({ error: "השם הזה שמור, בחרו אחר" }, 409);
    const existing = await env.SITES.get("m:" + slug, "json");
    if (existing && !replace) return json({ error: "השם תפוס", taken: true }, 409);
    if (existing && replace) await deleteSite(env, slug, existing);
  } else {
    do { slug = randomSlug(); } while (await env.SITES.get("m:" + slug));
  }

  for (const p of paths) {
    await env.SITES.put(`f:${slug}:${p}`, files[p], { metadata: { t: typeOf(p) } });
  }
  const meta = { slug, name: name || slug, created: Date.now(), files: paths, size: total };
  await env.SITES.put("m:" + slug, JSON.stringify(meta), {
    metadata: { name: meta.name, created: meta.created, size: total, count: paths.length },
  });

  return json({ ok: true, slug, url: `${url.origin}/s/${slug}/` });
}

async function deleteSite(env, slug, meta) {
  meta = meta || await env.SITES.get("m:" + slug, "json");
  if (!meta) return false;
  for (const p of meta.files || []) await env.SITES.delete(`f:${slug}:${p}`);
  await env.SITES.delete("m:" + slug);
  return true;
}

async function listSites(env, origin) {
  const out = [];
  let cursor;
  do {
    const r = await env.SITES.list({ prefix: "m:", cursor });
    for (const k of r.keys) {
      const slug = k.name.slice(2);
      out.push({ slug, url: `${origin}/s/${slug}/`, ...(k.metadata || {}) });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

// ---------- serving hosted sites ----------
// Hosted pages run in a sandbox with an opaque origin: their scripts work,
// but they cannot read this domain's cookies/storage or call the admin API.
const SITE_SEC = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

async function serveSite(req, env, slug, rest) {
  let path;
  try { path = decodeURIComponent(rest || ""); } catch { path = rest || ""; }
  const tryKeys = [];
  if (!path || path.endsWith("/")) tryKeys.push(path + "index.html");
  else tryKeys.push(path, path + ".html", path + "/index.html");

  for (const p of tryKeys) {
    const { value, metadata } = await env.SITES.getWithMetadata(`f:${slug}:${p}`, "arrayBuffer");
    if (value) {
      if (p === path + "/index.html") {
        return Response.redirect(new URL(req.url).href.replace(/\/?(\?.*)?$/, "/$1"), 301);
      }
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
  return new Response(exists ? "הדף לא נמצא" : "האתר לא קיים", {
    status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...SITE_SEC },
  });
}

// ---------- admin page ----------
function adminPage() {
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const html = UI_HTML.replace("<script>", `<script nonce="${nonce}">`);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; ` +
        `font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; form-action 'none'; ` +
        `frame-ancestors 'none'; base-uri 'none'`,
      ...BASE_SEC,
    },
  });
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const ready = !!env.UPLOAD_KEY && env.UPLOAD_KEY.length >= MIN_KEY_LEN;

    // hosted sites (public)
    const m = p.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      if (!m[2]) return Response.redirect(`${url.origin}/s/${m[1]}/${url.search}`, 301);
      return serveSite(req, env, m[1], m[2].slice(1));
    }

    if (p === "/" && req.method === "GET") return adminPage();
    if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\nAllow: /s/\n", { headers: { "content-type": "text/plain" } });

    if (p.startsWith("/api/")) {
      if (p === "/api/status" && req.method === "GET") {
        return json({ ready, loggedIn: ready && (await sessionOk(env, getCookie(req, COOKIE))) });
      }
      if (!ready) return json({ error: "האתר לא מוגדר" }, 503);

      if (p === "/api/login" && req.method === "POST") {
        if (!sameOrigin(req, url)) return json({ error: "בקשה נדחתה" }, 403);
        const ip = ipOf(req);
        if (await lockedOut(env, ip)) return json({ error: "יותר מדי ניסיונות. נסו שוב בעוד 15 דקות." }, 429);
        let body = {};
        try { body = await req.json(); } catch {}
        if (!(await passwordOk(env, body.password))) {
          const n = await recordFail(env, ip);
          const left = Math.max(0, MAX_FAILS - n);
          return json({ error: left ? `סיסמה שגויה (נשארו ${left} ניסיונות)` : "יותר מדי ניסיונות. נסו שוב בעוד 15 דקות." }, left ? 401 : 429);
        }
        await env.SITES.delete("rl:" + ip);
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
      }

      if (p === "/api/logout" && req.method === "POST") {
        return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
      }

      // everything below requires a valid session
      if (!(await authed(req, env, url))) return json({ error: "צריך להתחבר מחדש" }, 401);

      if (p === "/api/upload" && req.method === "POST") return handleUpload(req, env, url);
      if (p === "/api/sites" && req.method === "GET") return json({ sites: await listSites(env, url.origin) });
      const del = p.match(/^\/api\/sites\/([a-z0-9-]+)$/);
      if (del && req.method === "DELETE") return json({ ok: await deleteSite(env, del[1]) });
      if (p === "/api/slug" && req.method === "GET") {
        const s = cleanSlug(url.searchParams.get("s"));
        if (!s) return json({ slug: "", free: false });
        return json({ slug: s, free: !RESERVED.has(s) && !(await env.SITES.get("m:" + s)) });
      }
      return json({ error: "לא נמצא" }, 404);
    }

    return new Response("לא נמצא", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...BASE_SEC } });
  },
};
