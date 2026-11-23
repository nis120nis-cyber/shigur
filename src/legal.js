const page = (title, body) => `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — שיגור</title>
<link href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700&family=Heebo:wght@400;500;700&display=swap" rel="stylesheet">
<style>
body{font-family:Heebo,system-ui,sans-serif;background:#F7F6F2;color:#1A1A1A;margin:0;line-height:1.7;font-size:16px;-webkit-font-smoothing:antialiased}
.wrap{max-width:700px;margin:0 auto;padding:64px 22px 72px}
.back{font-size:14px;color:#5C5A54;text-decoration:none;border-bottom:1px solid #D6D2CA;padding-bottom:2px}
h1{font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:clamp(40px,9vw,60px);line-height:1.05;letter-spacing:-.03em;margin:28px 0 8px}
h2{font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:22px;letter-spacing:-.01em;margin:40px 0 6px;padding-top:24px;border-top:1px solid #E5E2DC}
p,li{color:#2E2C28}
a{color:#1E463A}
.muted{color:#5C5A54;font-size:14px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:#F2F0EB;border:1px solid #E5E2DC;border-radius:4px;padding:1px 5px}
pre{background:#FDFCFA;border:1px solid #E5E2DC;border-radius:6px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.6;text-align:left}
pre code{background:none;border:0;padding:0;color:#1A1A1A}
</style></head>
<body><div class="wrap"><a class="back" href="/">→ חזרה לשיגור</a><h1>${title}</h1><div class="muted">עודכן: 15 בנובמבר 2026</div>${body}</div></body></html>`;

export const PRIVACY = page("מדיניות פרטיות", `
<h2>מה אנחנו אוספים</h2>
<p>כשמתחברים עם גוגל אנחנו מקבלים מגוגל רק את השם, כתובת האימייל ומזהה החשבון. לא אנשי קשר, לא קבצים ולא שום מידע נוסף.</p>
<h2>למה</h2>
<p>כדי לזהות אתכם, לשייך אליכם את האתרים שהעליתם ולמנוע ניצול לרעה של השירות.</p>
<h2>הקבצים שאתם מעלים</h2>
<p>הקבצים נשמרים כדי להציג את האתר שלכם, והם גלויים לכל מי שמקבל את הקישור. אל תעלו מידע פרטי או רגיש.</p>
<h2>מידע שמבקרים שולחים לאתרים</h2>
<p>אתרים בשיגור יכולים לשמור מידע שמבקרים שולחים, כמו תגובות, שיאים או פניות מטפסים. המידע נשמר אצלנו ונגיש לבעל האתר. בעל האתר אחראי למידע שהוא אוסף. כתובת IP משמשת רק להגבלת קצב ולא נשמרת.</p>
<h2>סטטיסטיקות</h2>
<p>אנחנו סופרים כמה פעמים נצפה כל אתר בכל יום. נשמר רק מספר, בלי כתובות IP ובלי פרטים על המבקרים.</p>
<h2>עוגיות</h2>
<p>אנחנו משתמשים בעוגייה אחת בלבד, כדי שתישארו מחוברים. אין עוגיות פרסום או מעקב.</p>
<h2>שיתוף עם אחרים</h2>
<p>לא מוכרים ולא משתפים את המידע. השירות מתארח ב-Cloudflare.</p>
<h2>מחיקה</h2>
<p>אפשר למחוק כל אתר בכל רגע מעמוד הניהול. למחיקת כל המידע שלכם, פנו למנהל האתר.</p>`);

export const TERMS = page("תנאי שימוש", `
<h2>השירות</h2>
<p>שיגור מאפשר להעלות קבצי אתר ולקבל קישור ציבורי. השירות ניתן כמו שהוא (AS IS), בלי התחייבות לזמינות.</p>
<h2>אסור להעלות</h2>
<p>אתרי פישינג או התחזות, תוכנות זדוניות, תוכן לא חוקי, הפרת זכויות יוצרים, הטרדה, או כל דבר שפוגע באחרים.</p>
<h2>אכיפה</h2>
<p>המנהל רשאי למחוק כל אתר ולחסום כל משתמש שמפר את התנאים, בלי הודעה מוקדמת.</p>
<h2>מגבלות</h2>
<p>כל חשבון יכול ליצור עד 2 אתרים חדשים בכל 4 חודשים (מחיקת אתר לא מחזירה את המקום). אפשר לעדכן אתרים קיימים בלי הגבלה. עד 50MB לאתר.</p>
<h2>אחריות</h2>
<p>אתם אחראים לתוכן שאתם מעלים.</p>`);

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const code = s => `<pre dir="ltr"><code>${esc(s.trim())}</code></pre>`;

export const DOCS = page("מסד נתונים לאתר שלך", `
<p>כל אתר בשיגור מקבל מסד נתונים משלו. אפשר לשמור בו תגובות, שיאים, הצבעות, לייקים ופניות מטפסים. כל מי שנכנס לאתר רואה את המידע העדכני.</p>

<h2>שלב 1: מוסיפים שורה אחת לאתר</h2>
${code(`<script src="/shigur.js"></script>`)}

<h2>שמירה וקריאה</h2>
${code(`
// שמירת רשומה (כולם רואים)
await shigur.add("comments", { name: "דנה", text: "אתר מעולה!" });

// קריאת 50 האחרונות
const comments = await shigur.list("comments");

// קריאה ממוינת: 10 השיאים הגבוהים
const top = await shigur.list("scores", { sort: "score", dir: "desc", limit: 10 });
`)}

<h2>מונים (לייקים, צפיות, הצבעות)</h2>
${code(`
const likes = await shigur.increment("likes");  // +1 ומחזיר את הערך החדש
const now   = await shigur.count("likes");      // רק קריאה
`)}

<h2>טופס יצירת קשר (פרטי)</h2>
<p><code>send</code> שומר לאוסף פרטי. המבקרים לא יכולים לקרוא אותו, ורק אתם רואים את הפניות בעמוד הניהול של שיגור, בכפתור "נתונים".</p>
${code(`
await shigur.send("contact", { name: "יוסי", phone: "050-0000000", message: "היי" });
`)}

<h2>דוגמה מלאה: קיר תגובות</h2>
${code(`
<input id="name" placeholder="שם">
<input id="text" placeholder="תגובה">
<button id="send">שלח</button>
<ul id="list"></ul>

<script src="/shigur.js"></script>
<script>
  async function load() {
    const items = await shigur.list("comments");
    const ul = document.getElementById("list");
    ul.innerHTML = "";
    for (const c of items) {
      const li = document.createElement("li");
      li.textContent = c.name + ": " + c.text;   // textContent — חשוב לאבטחה!
      ul.appendChild(li);
    }
  }
  document.getElementById("send").onclick = async () => {
    await shigur.add("comments", {
      name: document.getElementById("name").value,
      text: document.getElementById("text").value
    });
    load();
  };
  load();
  setInterval(load, 5000);  // רענון כל 5 שניות — "לייב"
</script>
`)}

<h2>חשוב לדעת</h2>
<ul>
<li><b>כל אחד יכול לכתוב.</b> מה שמבקרים שולחים הוא קלט לא מהימן. הציגו אותו תמיד עם <code>textContent</code> ולא עם <code>innerHTML</code>, אחרת מישהו יוכל להזריק קוד לאתר.</li>
<li><b>אוסף ששמו מתחיל ב-<code>_</code> הוא פרטי:</b> אפשר לכתוב אליו, ורק בעל האתר קורא.</li>
<li><b>מגבלות:</b> 4KB לרשומה, 10,000 רשומות לאתר, 20 כתיבות בדקה לכל מבקר.</li>
<li>בעמוד הניהול, בכפתור "נתונים" ליד כל אתר, אפשר לראות ולמחוק כל רשומה, לאפס מונים ולמחוק אוספים שלמים.</li>
<li>מחיקת אתר מוחקת גם את כל הנתונים שלו.</li>
</ul>
`);
