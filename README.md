# A11y Shift

פלאגין Figma לביקורת נגישות (WCAG 2.2 AA + ARIA APG) עם תיקון אוטומטי, AI טקסטואלי ו-Vision AI.

מאגר: [github.com/1haim/a11y-Shift](https://github.com/1haim/a11y-Shift)

---

## מה הפלאגין עושה

- **מזהה** סוג קומפוננטה (כפתור, שדה טקסט, רדיו, דיאלוג, טאבים, סליידר, דירוג כוכבים, מתג, אקורדיון ועוד)
- **מריץ ~48 בדיקות** לפי מטריצת spec ייעודית לכל סוג
- **מציג** בעיות עם כותרת + הסבר (`[?]`) ורפרנס WCAG
- **מתקן** בעיות inline (annotation, ויזואלי, או AI) — Cmd+Z מבטל
- **שומר** היסטוריית סריקות ו-ARIA ב-Dev Mode (`setSharedPluginData`)

---

## דרישות

| דרישה | חובה? | הערות |
|--------|--------|--------|
| Figma Desktop | כן | Design Mode + Dev Mode |
| מפתח פלאגין | לפיתוח | Plugins → Development → Import plugin from manifest… |
| מפתח OpenAI | אופציונלי | ל-AI classification, תיקוני טקסט, Vision fallback |
| חיבור אינטרנט | עם API key | `manifest.json` מאשר רק `api.openai.com` |

---

## הפעלה ב-Figma

### משתמש / מעצב

1. שכפלו את המאגר או הורידו את הקבצים.
2. ב-Figma: **Plugins → Development → Import plugin from manifest…**
3. בחרו את `manifest.json` מתיקיית הפרויקט.
4. הפעילו: **Plugins → Development → A11y Shift** (או חפשו "A11y Shift" ב-Quick Actions).

> אחרי שינוי קוד: **Plugins → Development → A11y Shift** (לחיצה חוזרת) או Reload מהתפריט Development — Figma לא טוען JS מחדש אוטומטית.

### הגדרות (טאב Settings)

1. **OpenAI API Key** — `sk-…` (נשמר ב-`figma.clientStorage`, לא ב-repo).
2. **Confidence threshold** — רגישות ל-classification.
3. **AI model** — ברירת מחדל `gpt-4o-mini` לטקסט; Vision משתמש ב-`gpt-4o`.
4. **Run fix coverage report** — דוח כמה מבדיקות המטריצה מחוברות ל-autofix (48/48 אחרי העדכון האחרון).

---

## איך משתמשים

### ניתוח קומפוננטה בודדת (Analyze)

1. בחרו **Frame / Component / Instance** אחד (לא שכבת TEXT בודדת).
2. טאב **Analyze** → **Start Analysis**.
3. קראו את התוצאה:
   - **Role** — סוג שזוהה + badge (Spec engine / Text AI / Vision AI)
   - **Issues** — חומרה, WCAG, כפתור **Auto-fix** או **Mark as acknowledged**
   - **How I decided** — אותות classification + audit log
4. לכל issue:
   - **Auto-fix** — annotation / תיקון ויזואלי / AI (עם consent בפעם הראשונה)
   - **Mark as acknowledged** — לבעיות שדורשות החלטת מעצב (למשל contrast ידני)
   - **`[?]`** — הסבר למה זה חשוב
5. **Apply Fixes…** — החלת suggestions (rename / plugin data) אחרי שאין blockers HIGH.

### סריקת Frame שלם (Components)

1. בחרו Frame או Group.
2. טאב **Components** → **Scan Selected Frame**.
3. רשימת קומפוננטות עם סיכום issues; לחיצה פותחת ניתוח מלא.

### Dev Mode

- הפלאגין רשום גם ל-`dev` ב-`manifest.json`.
- ARIA נכתב ל-**shared plugin data** (`namespace: a11y`) — נגיש דרך REST API ופלאגינים אחרים.
- אין "Apply Fixes" הרסני — קריאה + העתקת attributes.

---

## איך לבדוק (QA)

### לפני בדיקה

- Reload פלאגין אחרי כל שינוי ב-`dist/code.js` / `ui.html`.
- DevTools ל-UI: קליק ימני על פאנל הפלאגין → **Inspect** (לא קונסול הקanvas של Figma).

### בדיקות מהירות

| # | בחר | צפוי |
|---|-----|------|
| 1 | כפתור icon-only | `ICON_BUTTON_NO_LABEL` → Auto-fix |
| 2 | שדה ללא label | `NO_INPUT_LABEL` |
| 3 | טקסט contrast נמוך | `CONTRAST_TEXT_FAIL` → שינוי fill |
| 4 | Radio group | `RADIO_NO_LABEL` → AI consent → labels |
| 5 | Star rating | `STAR_MISSING_ARIA_LABEL` per star |
| 6 | Toggle disabled רק בצבע | `COLOR_ONLY_DISABLED` → הודעה + acknowledge |
| 7 | Frame עם 3+ קומפוננטות | Scan Frame → רשימה + export |

### דוח כיסוי autofix

ב-Settings: **Run fix coverage report**, או ב-DevTools של UI:

```js
reportFixCoverage()
```

צפוי: **48 checks, 48 with autofix, 0 missing**.

### Regression חשוב

- Cmd+Z אחרי autofix — undo אחד לכל fix
- `refreshSummaryBanner` מתעדכן אחרי fix
- Instance בתוך COMPONENT_SET — לא לקרוא `componentPropertyDefinitions` על ה-child

מטריצת בדיקות מלאה: [`AGENT_PLAN.md`](AGENT_PLAN.md) (Manual Testing Plan).

---

## איך מוסיפים / מרחיבים קומפוננטות (למפתח)

### מבנה הפרויקט

```
a11y-shift/
├── manifest.json          # הגדרות Figma + networkAccess
├── dist/code.js           # Main thread — כל הלוגיקה
├── ui.html                # UI iframe — DOM + postMessage
├── AGENT_PLAN.md          # מצב נוכחי + מטריצת QA (מקור אמת למפתח)
└── .cursor/rules/
    └── figma-a11y-developer.mdc   # כללי Cursor Agent
```

### זרימת classification

```
selection → getSemanticRoot()
         → gatherContext() + deepChildScan(depth 3)
         → detectComponent (spec engine)
         → אם אין spec / confidence נמוך → classifyWithAI (gpt-4o-mini)
         → אם unknown → classifyWithVision (gpt-4o)
         → runMatrixChecks(typeKey) → issues + auditLog
```

### הוספת סוג קומפוננטה חדש

1. **`COMPONENT_SPECS`** — signals ל-scoring (שמות ילדים, layout, chevrons…).
2. **`COMPONENT_SPEC_MATRIX`** — רשימת check IDs (6–8 בדיקות).
3. **`SPEC_CHECKERS`** — פונקציה לכל check ID; מחזירה `[]` או `makeIssue(...)`.
4. **`normalizeMatrixTypeKey`** — מיפוי role string → מפתח matrix.
5. **`AUTO_FIX_HANDLERS`** — handler לפי **issue code** (לא check ID).
6. **`MATRIX_CHECK_FIX_BRIDGE`** — מיפוי check ID → issue codes (לדוח coverage).
7. **`ISSUE_EXPLANATIONS`** — כותרת + הסבר ל-UI.
8. בדיקה: `reportFixCoverage()` + ריצה ידנית ב-Figma.

### הוספת autofix

| סוג | איפה |
|-----|------|
| Annotation (ARIA ב-Dev Mode) | `ANNOTATION_FIX_MAP` + `makeAnnotationFixHandler` |
| ויזואלי (fills, variants, layers) | פונקציה ב-`AUTO_FIX_HANDLERS` |
| AI טקסט | `callAILabel` + `fixKind: "ai_content"` ב-`ISSUE_FIX_META` |
| הודעה בלבד | `fixKind: "message_only"` — UI מציג acknowledge |

כל handler:

- **לא** קורא `figma.commitUndo()` — זה ב-`autoFixIssue()` פעם אחת
- **כן** שולח `figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" })` אחרי שינוי

### שכבות threads — אסור לשבור

| פעולה | Thread |
|--------|--------|
| Plugin API, fetch, clientStorage | `dist/code.js` (main) |
| DOM, sessionStorage (AI consent) | `ui.html` |
| תקשורת | `postMessage` בלבד — אובייקטים plain JSON |

---

## הערות למפתח שעובד על הפרויקט

1. **קרא קודם** [`AGENT_PLAN.md`](AGENT_PLAN.md) ו-[`.cursor/rules/figma-a11y-developer.mdc`](.cursor/rules/figma-a11y-developer.mdc) — שם הארכיטקטורה המלאה.
2. **Issue codes ≠ check IDs** — handlers רשומים על `ROLE_BUTTON_MISSING`, לא על `ROLE_BUTTON_ANNOTATED`.
3. **`resolveSuggestions()`** — חובה לפני mutate על node IDs מה-AI.
4. **COMPONENT_SET** — קרא variants מה-parent, לא מה-instance child.
5. **ביצועים** — `findAllWithCriteria` + הגבלת depth; לא `findAll` על כל המסמך בלי scope.
6. **אל תדחוף secrets** — API keys רק ב-clientStorage; `.env` ב-`.gitignore`.
7. **Build** — אין bundler; עריכה ישירה ב-`dist/code.js` + `ui.html`. שמרו sync בין השניים.
8. **Debug coverage** — `figma._a11yDebug.reportFixCoverage()` ב-main sandbox; `reportFixCoverage()` ב-UI iframe.

### WCAG thresholds (מוטמע)

| בדיקה | סף |
|--------|-----|
| Text contrast | 4.5:1 (רגיל), 3:1 (large/bold) |
| Non-text UI | 3:1 |
| Touch target | 44×44 (מומלץ), 24×24 עם spacing |

---

## API Key & עלויות

- מפתח נשמר: `figma.clientStorage` key `openai-api-key`.
- Text classification: ~gpt-4o-mini, batch titles — קריאה אחת לניתוח.
- Vision fallback: gpt-4o, PNG 0.5×, `detail: low` — רק כש-text AI לא מזהה.
- Scan Frame: titles סטטיים בלבד (ללא N קריאות AI).

---

## רישיון

לא הוגדר עדיין — הוסיפו LICENSE לפי הצורך.

---

## קישורים

- [מאגר GitHub](https://github.com/1haim/a11y-Shift)
- [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Figma Plugin API](https://www.figma.com/plugin-docs/)
