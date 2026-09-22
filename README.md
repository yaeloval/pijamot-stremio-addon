# הפיג'מות – Stremio + Dailymotion

תוסף Stremio קטן שמוסיף מקור צפייה לפרקי **הפיג'מות** (`IMDb: tt0928368`) מתוך הפלייליסטים הציבוריים של `ThePijamasArchive` ב-Dailymotion.

## מה הוא עושה

- תומך בעונות 1–9.
- קורא אוטומטית את הפלייליסטים של Dailymotion.
- מזהה עונה ופרק מתוך הכותרת של הסרטון, כך שחוסרים בפלייליסט לא מזיזים את המספור.
- מחזיר מקור בשם `Dailymotion` שמנגן את הפרק ישירות בתוך Stremio.
- לא מעתיק או מאחסן וידאו; הסרטונים נטענים ישירות מהשרתים של Dailymotion.
- פרקים שחסרים בארכיון של Dailymotion (למשל עונה 1 פרקים 2 ו-8) לא יציגו מקור.

## איך זה עובד

Dailymotion חוסם בקשות שלא מגיעות מדפדפן ל-manifest הראשי של ה-HLS, והטוקן שלו קשור לכתובת ה-IP שביקשה אותו. לכן השרת משתמש ב-[yt-dlp](https://github.com/yt-dlp/yt-dlp) כדי לקבל את רשימת האיכויות של הפרק, בונה מהן playlist ראשי בכתובת `/master/<videoId>.m3u8`, ו-Stremio טוען ממנו את הווידאו ישירות מהשרתים של Dailymotion. שום וידאו לא עובר דרך השרת.

לפעמים (בעיקר כשהשרת רץ בענן) Dailymotion מחזיר רק את האיכויות הנמוכות, 288p ו-480p. במקרה כזה השרת מנסה פעם אחת נוספת.

## הפלייליסטים

- עונה 1 — `x8kmxm`
- עונה 2 — `x8kmxy`
- עונה 3 — `x8kmy6`
- עונה 4 — `x8kmy8`
- עונה 5 — `x8kmya`
- עונה 6 — `x8kmye`
- עונה 7 — `x8nroo`
- עונה 8 — `x8nroq`
- עונה 9 — `x8nrow`

## הרצה במחשב

צריך Python 3.12.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PUBLIC_BASE_URL=http://127.0.0.1:7000 .venv/bin/uvicorn app.main:app --port 7000
```

`PUBLIC_BASE_URL` היא הכתובת שבה Stremio ניגש לשרת. אחרי ההרצה, ה-manifest נמצא כאן:

```text
http://127.0.0.1:7000/manifest.json
```

ב-Stremio אפשר לפתוח את עמוד ה-Add-ons ולהוסיף את כתובת ה-manifest.

לבדיקות:

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

אפשר גם להריץ עם Docker:

```bash
docker build -t pijamot .
docker run --rm -p 7000:80 -e PUBLIC_BASE_URL=http://127.0.0.1:7000 pijamot
```

## שימוש בטלפון / טלוויזיה

`127.0.0.1` עובד רק על המכשיר שמריץ את השרת. כדי להשתמש בתוסף מכל המכשירים, צריך לפרוס אותו לשרת ציבורי עם HTTPS. הפרויקט כולל `Dockerfile` ו-`render.yaml` לפריסה ב-Render, והוא רץ גם בכל שרת שמריץ Docker.

- ב-Render הכתובת הציבורית נלקחת אוטומטית מ-`RENDER_EXTERNAL_URL`.
- בשרת אחר צריך להגדיר `PUBLIC_BASE_URL` לכתובת ה-HTTPS הציבורית.

לאחר הפריסה מתקינים ב-Stremio את:

```text
https://YOUR-DOMAIN/manifest.json
```

## מזהה הסדרה

Stremio/Cinemeta מזהים את הסדרה באמצעות:

```text
tt0928368
```

למשל, עונה 2 פרק 7 מתקבלת בבקשת stream עם מזהה בסגנון:

```text
tt0928368:2:7
```
