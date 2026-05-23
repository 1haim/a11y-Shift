# A11y Shift

A Figma plugin for WCAG 2.2 AA + ARIA APG accessibility auditing with inline autofix, text AI, and Vision AI fallback.

Repository: [github.com/1haim/a11y-Shift](https://github.com/1haim/a11y-Shift)

---

## What it does

- **Detects** component type (button, text field, radio group, dialog, tabs, slider, star rating, toggle, accordion, and more)
- **Runs ~48 checks** via a per-type spec matrix
- **Surfaces** issues with contextual titles, explanations (`[?]`), and WCAG references
- **Fixes** issues inline (annotation, visual, or AI) — one Cmd+Z undoes each fix
- **Persists** scan history and Dev Mode ARIA via `setSharedPluginData`

---

## Requirements

| Requirement | Required? | Notes |
|-------------|-----------|-------|
| Figma Desktop | Yes | Design Mode + Dev Mode |
| Plugin development | For local dev | Plugins → Development → Import plugin from manifest… |
| OpenAI API key | Optional | AI classification, text autofix, Vision fallback |
| Internet | With API key | `manifest.json` allows only `api.openai.com` |

---

## Running in Figma

### Designers

1. Clone this repo or download the files.
2. In Figma: **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` from the project root.
4. Run: **Plugins → Development → A11y Shift** (or search “A11y Shift” in Quick Actions).

> After code changes: re-run the plugin from **Plugins → Development** or use Reload — Figma does not hot-reload plugin JS.

### Settings tab

1. **OpenAI API Key** — `sk-…` (stored in `figma.clientStorage`, never committed).
2. **Confidence threshold** — classification sensitivity.
3. **AI model** — default `gpt-4o-mini` for text; Vision uses `gpt-4o`.
4. **Run fix coverage report** — shows how many matrix checks have autofix handlers (48/48 after latest update).

---

## How to use

### Analyze a single component (Analyze tab)

1. Select one **Frame / Component / Instance** (not a lone TEXT layer).
2. **Analyze** tab → **Start Analysis**.
3. Review results:
   - **Role** — detected type + badge (Spec engine / Text AI / Vision AI)
   - **Issues** — severity, WCAG, **Auto-fix** or **Mark as acknowledged**
   - **How I decided** — classification signals + audit log
4. Per issue:
   - **Auto-fix** — annotation / visual fix / AI (consent dialog on first AI fix)
   - **Mark as acknowledged** — for designer-only decisions (e.g. manual contrast review)
   - **`[?]`** — why this matters
5. **Apply Fixes…** — apply rename / plugin-data suggestions once HIGH blockers are resolved.

### Scan an entire frame (Components tab)

1. Select a Frame or Group.
2. **Components** tab → **Scan Selected Frame**.
3. Browse components and open full analysis per row.

### Dev Mode

- Plugin is registered for `dev` in `manifest.json`.
- ARIA is written to **shared plugin data** (`namespace: a11y`) — readable via REST API and other plugins.
- Read-only context: no destructive Apply Fixes; copy ARIA attributes for handoff.

---

## How to test (QA)

### Before testing

- Reload the plugin after any change to `dist/code.js` or `ui.html`.
- UI DevTools: right-click the plugin panel → **Inspect** (not the Figma canvas console).

### Quick checks

| # | Select | Expected |
|---|--------|----------|
| 1 | Icon-only button | `ICON_BUTTON_NO_LABEL` → Auto-fix |
| 2 | Input without label | `NO_INPUT_LABEL` |
| 3 | Low text contrast | `CONTRAST_TEXT_FAIL` → fill adjusted |
| 4 | Radio group | `RADIO_NO_LABEL` → AI consent → labels |
| 5 | Star rating | `STAR_MISSING_ARIA_LABEL` per star |
| 6 | Toggle disabled by color only | `COLOR_ONLY_DISABLED` → message + acknowledge |
| 7 | Frame with 3+ components | Scan Frame → list + export |

### Autofix coverage report

In **Settings**: **Run fix coverage report**, or in the plugin UI DevTools:

```js
reportFixCoverage()
```

Expected: **48 checks, 48 with autofix, 0 missing**.

### Important regressions

- Cmd+Z after autofix — single undo group per fix
- Summary banner updates after each fix (`refreshSummaryBanner`)
- Instance inside COMPONENT_SET — never call `componentPropertyDefinitions` on the child

Full test matrix: [`AGENT_PLAN.md`](AGENT_PLAN.md) (Manual Testing Plan).

---

## Adding / extending components (developers)

### Project layout

```
a11y-shift/
├── manifest.json          # Figma config + networkAccess
├── dist/code.js           # Main thread — all logic
├── ui.html                # UI iframe — DOM + postMessage
├── AGENT_PLAN.md          # Current architecture + QA matrix
└── .cursor/rules/
    └── figma-a11y-developer.mdc   # Cursor agent rules
```

### Classification pipeline

```
selection → getSemanticRoot()
         → gatherContext() + deepChildScan(depth 3)
         → detectComponent (spec engine)
         → if no spec / low confidence → classifyWithAI (gpt-4o-mini)
         → if unknown → classifyWithVision (gpt-4o)
         → runMatrixChecks(typeKey) → issues + auditLog
```

### Adding a new component type

1. **`COMPONENT_SPECS`** — scoring signals (child names, layout, chevrons…).
2. **`COMPONENT_SPEC_MATRIX`** — list of check IDs (6–8 per type).
3. **`SPEC_CHECKERS`** — one function per check ID; returns `[]` or `makeIssue(...)`.
4. **`normalizeMatrixTypeKey`** — maps role string → matrix key.
5. **`AUTO_FIX_HANDLERS`** — handlers keyed by **issue code** (not check ID).
6. **`MATRIX_CHECK_FIX_BRIDGE`** — check ID → issue codes (for coverage report).
7. **`ISSUE_EXPLANATIONS`** — static title + explanation for the UI.
8. Verify: `reportFixCoverage()` + manual run in Figma.

### Adding autofix handlers

| Type | Where |
|------|-------|
| Annotation (Dev Mode ARIA) | `ANNOTATION_FIX_MAP` + `makeAnnotationFixHandler` |
| Visual (fills, variants, layers) | function in `AUTO_FIX_HANDLERS` |
| AI text | `callAILabel` + `fixKind: "ai_content"` in `ISSUE_FIX_META` |
| Designer message only | `fixKind: "message_only"` — UI shows acknowledge |

Every handler:

- Must **not** call `figma.commitUndo()` — wrapped once in `autoFixIssue()`
- **Must** post `figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" })` after mutations

### Two threads — do not break

| Operation | Thread |
|-----------|--------|
| Plugin API, fetch, clientStorage | `dist/code.js` (main) |
| DOM, sessionStorage (AI consent) | `ui.html` |
| Communication | `postMessage` only — plain JSON objects |

---

## Notes for contributors

1. Read [`AGENT_PLAN.md`](AGENT_PLAN.md) and [`.cursor/rules/figma-a11y-developer.mdc`](.cursor/rules/figma-a11y-developer.mdc) first.
2. **Issue codes ≠ check IDs** — handlers register on `ROLE_BUTTON_MISSING`, not `ROLE_BUTTON_ANNOTATED`.
3. **`resolveSuggestions()`** — required before mutating AI-returned node IDs.
4. **COMPONENT_SET** — read variant definitions from the parent, not the instance child.
5. **Performance** — prefer `findAllWithCriteria` with depth limits; avoid unscoped `findAll` on large files.
6. **Secrets** — API keys only in `clientStorage`; `.env` is gitignored.
7. **No bundler** — edit `dist/code.js` and `ui.html` directly; keep them in sync.
8. **Debug** — `figma._a11yDebug.reportFixCoverage()` in main sandbox; `reportFixCoverage()` in UI iframe DevTools.

### WCAG thresholds (built-in)

| Check | Threshold |
|-------|-----------|
| Text contrast | 4.5:1 (normal), 3:1 (large/bold) |
| Non-text UI | 3:1 |
| Touch target | 44×44 recommended; 24×24 with spacing |

---

## API key & cost

- Key stored at: `figma.clientStorage` → `openai-api-key`.
- Text classification: gpt-4o-mini; batched titles — one call per analysis.
- Vision fallback: gpt-4o, PNG at 0.5× scale, `detail: low` — only when text AI returns unknown.
- Scan Frame: static titles only (no N API calls per component).

---

## License

Not specified yet — add a LICENSE file as needed.

---

## Links

- [GitHub repository](https://github.com/1haim/a11y-Shift)
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Figma Plugin API](https://www.figma.com/plugin-docs/)
