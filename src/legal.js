const page = (title, body) => `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — שיגור</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#eef1f6;max-width:720px;margin:0 auto;padding:36px 20px 60px;line-height:1.75}h1{font-size:32px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 6px}a{color:#7cff6b}.muted{color:#8c95a6;font-size:14px}</style></head>
<body><h1>${title}</h1><div class="muted">עודכן: 15 בנובמבר 2026</div>${body}<p style="margin-top:40px"><a href="/">← חזרה לשיגור</a></p></body></html>`;

export const PRIVACY = page("מדיניות פרטיות", `
<h2>מה אנחנו אוספים</h2>
<p>כשמתחברים עם גוגל אנחנו מקבלים מגוגל רק את השם, כתובת האימייל ומזהה החשבון. לא אנשי קשר, לא קבצים ולא שום מידע נוסף.</p>
<h2>למה</h2>
<p>כדי לזהות אתכם, לשייך אליכם את האתרים שהעליתם ולמנוע ניצול לרעה של השירות.</p>
<h2>הקבצים שאתם מעלים</h2>
<p>הקבצים נשמרים כדי להציג את האתר שלכם, והם גלויים לכל מי שמקבל את הקישור. אל תעלו מידע פרטי או רגיש.</p>
<h2>מידע שמבקרים שולחים לאתרים</h2>
<p>אתרים בשיגור יכולים לשמור מידע שמבקרים שולחים, כמו תגובות, שיאים או פניות מטפסים. המידע נשמר אצלנו ונגיש לבעל האתר. בעל האתר אחראי למידע שהוא אוסף. כתובת IP משמשת רק להגבלת קצב ולא נשמרת.</p>
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
<p>עד 10 אתרים לחשבון, עד 50MB לאתר.</p>
<h2>אחריות</h2>
<p>אתם אחראים לתוכן שאתם מעלים.</p>`);

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const code = s => `<pre dir="ltr"><code>${esc(s.trim())}</code></pre>`;

export const DOCS = page("מסד נתונים לאתר שלך", `
<style>pre{background:#161a22;border:1px solid #262c38;border-radius:12px;padding:14px;overflow-x:auto;font-size:13px;line-height:1.6;text-align:left}code{font-family:ui-monospace,monospace;color:#cfe8ff}</style>
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
