import { unzipSync } from "fflate";
import UI_HTML from "./ui.html";

// ---------- settings ----------
const MAX_TOTAL = 50 * 1024 * 1024;   // 50MB per site
const MAX_FILE = 24 * 1024 * 1024;    // KV limit is 25MiB per value
const MAX_FILES = 500;
const RESERVED = new Set(["api", "admin", "s", "www", "static"]);

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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------- helpers ----------
function authed(req, env) {
  if (!env.UPLOAD_KEY) return false;
  const k = req.headers.get("x-key") || "";
  if (k.length !== env.UPLOAD_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ env.UPLOAD_KEY.charCodeAt(i);
  return diff === 0;
}

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
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out || out.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(out) || /(^|\/)Thumbs\.db$/i.test(out)) return null;
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
  // no index.html but exactly one html at the root -> treat it as the home page
  if (!files["index.html"]) {
    const htmls = paths.filter(p => /\.html?$/i.test(p) && !p.includes("/"));
    if (htmls.length === 1) { files["index.html"] = files[htmls[0]]; }
  }
  return files;
}

// ---------- upload ----------
async function handleUpload(req, env, origin) {
  if (!authed(req, env)) return json({ error: "סיסמה שגויה" }, 401);

  let form;
  try { form = await req.formData(); } catch { return json({ error: "בקשה לא תקינה" }, 400); }

  const name = String(form.get("name") || "").slice(0, 80);
  let slug = cleanSlug(form.get("slug"));
  const replace = form.get("replace") === "1";

  // gather files
  let files = {};
  let total = 0;
  const all = form.getAll("files");
  const relPaths = form.getAll("paths");
  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    if (typeof entry === "string") continue;
    const buf = new Uint8Array(await entry.arrayBuffer());
    const rel = relPaths[i] || entry.name;
    if (/\.zip$/i.test(entry.name) && all.length === 1) {
      let unz;
      try { unz = unzipSync(buf); } catch { return json({ error: "קובץ ה-ZIP פגום" }, 400); }
      for (const [p, data] of Object.entries(unz)) {
        if (p.endsWith("/")) continue;
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

  // choose slug
  if (slug) {
    if (RESERVED.has(slug)) return json({ error: "השם הזה שמור, בחרו אחר" }, 409);
    const existing = await env.SITES.get("m:" + slug, "json");
    if (existing && !replace) return json({ error: "השם תפוס", taken: true }, 409);
    if (existing && replace) await deleteSite(env, slug, existing);
  } else {
    do { slug = randomSlug(); } while (await env.SITES.get("m:" + slug));
  }

  // store
  for (const p of paths) {
    await env.SITES.put(`f:${slug}:${p}`, files[p], { metadata: { t: typeOf(p) } });
  }
  const meta = { slug, name: name || slug, created: Date.now(), files: paths, size: total };
  await env.SITES.put("m:" + slug, JSON.stringify(meta), { metadata: { name: meta.name, created: meta.created, size: total, count: paths.length } });

  return json({ ok: true, slug, url: `${origin}/s/${slug}/` });
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

// ---------- serving ----------
async function serveSite(req, env, slug, rest) {
  let path = decodeURIComponent(rest || "");
  const tryKeys = [];
  if (!path || path.endsWith("/")) tryKeys.push(path + "index.html");
  else { tryKeys.push(path, path + ".html", path + "/index.html"); }

  for (const p of tryKeys) {
    const { value, metadata } = await env.SITES.getWithMetadata(`f:${slug}:${p}`, "arrayBuffer");
    if (value) {
      if (p.endsWith("/index.html") && !path.endsWith("/") && path && p !== path) {
        // folder without trailing slash -> redirect so relative links work
        return Response.redirect(new URL(req.url).href.replace(/\/?$/, "/"), 301);
      }
      return new Response(value, {
        headers: {
          "content-type": (metadata && metadata.t) || typeOf(p),
          "cache-control": /\.html?$/i.test(p) ? "public, max-age=60" : "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
    }
  }
  // custom 404 page if the site has one
  const nf = await env.SITES.get(`f:${slug}:404.html`, "arrayBuffer");
  if (nf) return new Response(nf, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  const exists = await env.SITES.get("m:" + slug);
  return new Response(exists ? "הדף לא נמצא" : "האתר לא קיים", {
    status: 404, headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = url.origin;
    const p = url.pathname;

    if (p === "/" && req.method === "GET") {
      return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (p === "/api/status") return json({ ready: !!env.UPLOAD_KEY });
    if (p === "/api/check" && req.method === "POST") return json({ ok: authed(req, env) }, authed(req, env) ? 200 : 401);
    if (p === "/api/upload" && req.method === "POST") return handleUpload(req, env, origin);

    if (p === "/api/sites" && req.method === "GET") {
      if (!authed(req, env)) return json({ error: "סיסמה שגויה" }, 401);
      return json({ sites: await listSites(env, origin) });
    }
    const del = p.match(/^\/api\/sites\/([a-z0-9-]+)$/);
    if (del && req.method === "DELETE") {
      if (!authed(req, env)) return json({ error: "סיסמה שגויה" }, 401);
      return json({ ok: await deleteSite(env, del[1]) });
    }
    if (p === "/api/slug" && req.method === "GET") {
      const s = cleanSlug(url.searchParams.get("s"));
      if (!s) return json({ slug: "", free: false });
      const free = !RESERVED.has(s) && !(await env.SITES.get("m:" + s));
      return json({ slug: s, free });
    }

    const m = p.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
    if (m) {
      if (!m[2]) return Response.redirect(`${origin}/s/${m[1]}/${url.search}`, 301);
      return serveSite(req, env, m[1], m[2].slice(1));
    }

    return new Response("לא נמצא", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
