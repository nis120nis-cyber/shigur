# שיגור 🚀

מעלים קבצים, מקבלים אתר אמיתי עם קישור ציבורי.

- מעלים קובץ HTML, קובץ ZIP של אתר שלם או תיקייה שלמה
- בוחרים כתובת, למשל `/s/my-site/`
- כל אחד יכול לפתוח את הקישור, גם בלי חשבון
- אפשר לעדכן אתר קיים (אותה כתובת) או למחוק אותו
- רק מי שיודע את הסיסמה יכול להעלות

רץ על Cloudflare Workers + KV, בחינם.

## העלאה לאוויר (פעם אחת, בערך 5 דקות)

1. נכנסים ל-[dash.cloudflare.com](https://dash.cloudflare.com) ונרשמים בחינם.
2. **Workers & Pages** ← **Create** ← **Import a repository** ← מחברים את GitHub ובוחרים את הריפו `shigur` ← **Deploy**.
   מקום האחסון (KV) נוצר אוטומטית.
3. בתוך ה-Worker: **Settings** ← **Variables and Secrets** ← **Add**:
   - Type: **Secret**
   - Name: `UPLOAD_KEY`
   - Value: הסיסמה שתרצו להעלאה
   ← **Deploy**
4. פותחים את הכתובת `https://shigur.<השם-שלכם>.workers.dev`, נכנסים עם הסיסמה ומשגרים.

מעכשיו כל `git push` לריפו מעדכן את האתר אוטומטית.

### דומיין משלכם (לא חובה)
ב-Worker: **Settings** ← **Domains & Routes** ← **Add** ← **Custom domain**.

## מגבלות
- עד 50MB ועד 500 קבצים לאתר, ועד 24MB לקובץ בודד
- בתוכנית החינמית של Cloudflare: עד 1,000 שמירות קבצים ביום (כל קובץ באתר נחשב שמירה אחת) ו-100,000 צפיות בקבצים ביום

## פיתוח מקומי
```
npm install
echo 'UPLOAD_KEY="test"' > .dev.vars
npm run dev
```
