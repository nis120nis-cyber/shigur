// =====================================================================
//  Automatic site improvement on upload (no AI, free).
//  Fixes common problems in HTML files and reports things that won't work.
// =====================================================================

const dec = new TextDecoder("utf-8", { fatal: false });
const enc = new TextEncoder();
const MAX_HTML = 2 * 1024 * 1024;
const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌐</text></svg>">`;

const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textOf = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function insertInHead(html, snippet) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + "\n" + snippet);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + "\n<head>\n" + snippet + "\n</head>");
  return "<head>\n" + snippet + "\n</head>\n" + html;
}

function improveHtml(html, siteName, fixes) {
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ""])[1] + (/<head/i.test(html) ? "" : html.slice(0, 3000));
  const add = [];

  if (!/<meta[^>]+charset/i.test(head)) { add.push('<meta charset="UTF-8">'); fixes.add("עברית תוצג נכון (קידוד UTF-8)"); }
  if (!/<meta[^>]+name=["']?viewport/i.test(head)) { add.push('<meta name="viewport" content="width=device-width, initial-scale=1">'); fixes.add("התאמה לטלפון (viewport)"); }

  let title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  if (!title) {
    title = siteName;
    if (/<title[^>]*>\s*<\/title>/i.test(html)) html = html.replace(/<title[^>]*>\s*<\/title>/i, `<title>${esc(title)}</title>`);
    else add.push(`<title>${esc(title)}</title>`);
    fixes.add("כותרת לטאב בדפדפן");
  }

  if (!/property=["']?og:title/i.test(head)) {
    const desc = textOf(html).slice(0, 160);
    add.push(`<meta property="og:title" content="${esc(title.replace(/<[^>]+>/g, ""))}">`);
    add.push(`<meta property="og:type" content="website">`);
    if (desc && !/property=["']?og:description/i.test(head)) add.push(`<meta property="og:description" content="${esc(desc)}">`);
    if (desc && !/<meta[^>]+name=["']?description/i.test(head)) add.push(`<meta name="description" content="${esc(desc)}">`);
    fixes.add("תצוגה מקדימה יפה בוואטסאפ ובגוגל");
  }

  if (!/<link[^>]+rel=["']?[^"'>]*icon/i.test(head)) { add.push(FAVICON); fixes.add("אייקון לטאב (favicon)"); }

  if (add.length) html = insertInHead(html, add.join("\n"));

  // Hebrew page without direction → RTL
  if (/[֐-׿]/.test(textOf(html).slice(0, 5000)) && /<html/i.test(html) && !/<html[^>]*\sdir=/i.test(html)) {
    html = html.replace(/<html/i, '<html dir="rtl"' + (/<html[^>]*\slang=/i.test(html) ? "" : ' lang="he"'));
    fixes.add("כיוון מימין לשמאל (RTL)");
  }

  // lazy-load images
  let lazy = 0;
  html = html.replace(/<img\b(?![^>]*\bloading=)([^>]*)>/gi, (m, rest) => { lazy++; return `<img loading="lazy"${rest}>`; });
  if (lazy) fixes.add(`טעינה מהירה של ${lazy} תמונות`);

  return html;
}

function checkHtml(path, html, files, warnings) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const missing = new Set();
  const refRe = /\b(?:src|href)\s*=\s*(?:["']([^"'#?]*)[^"']*["']|([^\s>"'#?]+))/gi;
  let m;
  while ((m = refRe.exec(html))) {
    const ref = (m[1] ?? m[2] ?? "").trim();
    if (!ref || /^(?:[a-z]+:|\/\/|data:|mailto:|tel:|javascript:|#|\{|\$)/i.test(ref)) continue;
    if (ref === "/shigur.js" || ref.startsWith("/")) continue;
    let target = ref;
    try { target = decodeURIComponent(ref); } catch {}
    const parts = [];
    for (const seg of (dir + target).split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    const full = parts.join("/");
    if (!full) continue;
    if (!files.has(full) && !files.has(full + "/index.html") && !files.has(full + ".html")) missing.add(ref);
  }
  if (missing.size) warnings.add(`קבצים שהאתר מחפש ולא הועלו: ${[...missing].slice(0, 5).join(", ")}${missing.size > 5 ? " ועוד" : ""}`);
  if (/\bsrc\s*=\s*["']http:\/\//i.test(html) || /<link[^>]+href\s*=\s*["']http:\/\//i.test(html)) warnings.add("יש קישורים ל-http:// (לא מאובטח). דפדפנים חוסמים אותם, עדיף לשנות ל-https://");
  if (/\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(html)) warnings.add("האתר שומר נתונים בדפדפן (localStorage/cookies), וזה לא יעבוד בשיגור. אפשר להשתמש במסד הנתונים של שיגור במקום (ראו 📖)");
  if (/<form[^>]+action\s*=\s*["'](?!#|javascript)[^"']+/i.test(html)) warnings.add("יש טופס ששולח לשרת אחר, והוא לא יעבוד. אפשר לשמור פניות עם shigur.send (ראו 📖)");
}

// files: { path: Uint8Array } → mutates HTML files in place, returns report
export function improveSite(files, siteName, doFix) {
  const fixes = new Set(), warnings = new Set();
  const names = new Set(Object.keys(files));
  for (const [path, buf] of Object.entries(files)) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(path) && buf.length > 2 * 1024 * 1024) warnings.add(`התמונה ${path} גדולה (${(buf.length / 1048576).toFixed(1)}MB), והאתר ייטען לאט. מומלץ לכווץ אותה`);
    if (!/\.html?$/i.test(path) || buf.length > MAX_HTML) continue;
    let html = dec.decode(buf);
    if (doFix) {
      const out = improveHtml(html, siteName, fixes);
      if (out !== html) { files[path] = enc.encode(out); html = out; }
    }
    checkHtml(path, html, names, warnings);
  }
  return { fixes: [...fixes], warnings: [...warnings] };
}
