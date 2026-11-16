// =====================================================================
//  Sign in with GitHub / Microsoft (server-side OAuth 2.0 code flow).
//  • Client ID + secret are set by the admin in the admin page and kept
//    in KV; the secret is write-only (never sent back to a browser).
//  • A random "state" in a short-lived HttpOnly cookie blocks login CSRF.
//  • Users get ids prefixed by provider ("gh:", "ms:") so accounts never mix.
// =====================================================================

const STATE_COOKIE = "__Host-shigur-oauth";

export const PROVIDERS = {
  github: {
    label: "GitHub",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    prefix: "gh:",
  },
  microsoft: {
    label: "Microsoft",
    // "consumers" = personal Microsoft accounts (Outlook / Hotmail / Live)
    authorize: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    scope: "openid email profile",
    prefix: "ms:",
  },
};

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export async function providerConfig(env, name) {
  return (await env.SITES.get("sys:oauth:" + name, "json")) || null;
}

export async function enabledProviders(env) {
  const out = [];
  for (const name of Object.keys(PROVIDERS)) {
    const c = await providerConfig(env, name);
    if (c && c.id && c.secret) out.push(name);
  }
  return out;
}

function getCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

const page = (msg, ok) => `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>שיגור</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#eef1f6;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#7cff6b}</style>
${ok ? '<meta http-equiv="refresh" content="0;url=/">' : ""}</head><body><div><p style="font-size:18px">${msg}</p><p><a href="/">חזרה לשיגור</a></p></div></body></html>`;

function htmlResponse(html, status = 200, extra = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra,
    },
  });
}

// GET /auth/<provider>  → redirect to the provider
export async function startLogin(req, env, url, name) {
  const P = PROVIDERS[name];
  const cfg = await providerConfig(env, name);
  if (!P || !cfg) return htmlResponse(page("שיטת הכניסה הזו לא מופעלת"), 404);
  const state = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const q = new URLSearchParams({
    client_id: cfg.id,
    redirect_uri: `${url.origin}/auth/${name}/callback`,
    scope: P.scope,
    state,
    response_type: "code",
  });
  if (name === "microsoft") q.set("response_mode", "query");
  if (name === "github") q.set("allow_signup", "true");
  return new Response(null, {
    status: 302,
    headers: {
      location: `${P.authorize}?${q}`,
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
    },
  });
}

async function exchangeAndFetchUser(env, url, name, cfg, code) {
  if (env.TEST_OAUTH_MOCK && url.hostname === "localhost") return JSON.parse(env.TEST_OAUTH_MOCK)[name];
  const P = PROVIDERS[name];
  const redirect_uri = `${url.origin}/auth/${name}/callback`;
  const body = new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri, grant_type: "authorization_code" });
  if (name === "microsoft") body.set("scope", P.scope);
  const tr = await fetch(P.token, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || tok.error) throw new Error("token");

  if (name === "github") {
    const h = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "shigur" };
    const [u, emails] = await Promise.all([
      fetch("https://api.github.com/user", { headers: h }).then(r => r.json()),
      fetch("https://api.github.com/user/emails", { headers: h }).then(r => r.json()),
    ]);
    const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) : null;
    if (!u || !u.id || !primary) return null;
    return { id: String(u.id), email: primary.email, name: u.name || u.login };
  }

  // microsoft: id_token came straight from the token endpoint over TLS (OIDC code flow),
  // so its payload is trusted without a separate signature check.
  if (!tok.id_token) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromB64u(tok.id_token.split(".")[1])));
  if (payload.aud !== cfg.id) return null;
  const email = payload.email || payload.preferred_username;
  if (!payload.sub || !email || !/@/.test(email)) return null;
  return { id: String(payload.oid || payload.sub), email, name: payload.name || email };
}

// GET /auth/<provider>/callback  → verify state, exchange code, create session
export async function finishLogin(req, env, url, name, { makeSession, sessionCookie, sessionDays }) {
  const P = PROVIDERS[name];
  const cfg = await providerConfig(env, name);
  const clearState = `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (!P || !cfg) return htmlResponse(page("שיטת הכניסה הזו לא מופעלת"), 404);

  const state = url.searchParams.get("state");
  const saved = getCookie(req, STATE_COOKIE);
  if (!state || !saved || state !== saved) return htmlResponse(page("פג תוקף הכניסה. נסו שוב."), 400, { "set-cookie": clearState });
  if (url.searchParams.get("error")) return htmlResponse(page("הכניסה בוטלה"), 400, { "set-cookie": clearState });
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return htmlResponse(page("בקשה לא תקינה"), 400, { "set-cookie": clearState });

  let u;
  try { u = await exchangeAndFetchUser(env, url, name, cfg, code); } catch { u = null; }
  if (!u) return htmlResponse(page("לא הצלחנו להתחבר. נסו שוב."), 502, { "set-cookie": clearState });

  const user = { sub: P.prefix + u.id, email: String(u.email).toLowerCase(), name: String(u.name).slice(0, 80), via: name };
  if (await env.SITES.get("ban:" + user.sub)) return htmlResponse(page("החשבון הזה נחסם"), 403, { "set-cookie": clearState });

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", clearState);
  headers.append("set-cookie", sessionCookie(await makeSession(env, user), sessionDays * 86400));
  return new Response(page("מתחברים…", true), { status: 200, headers });
}
