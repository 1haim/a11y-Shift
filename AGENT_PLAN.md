# A11y Shift — Agent Plan (Current State)

> **UPDATED**: This document reflects the fully implemented plugin as of Phase E.
> The original 10-component spec has been superseded. Read this in full before making any changes.

---

## What's Built

A Figma plugin for WCAG 2.2 AA + ARIA APG accessibility auditing with self-healing autofix.

### File structure
```
a11y-shift/
  manifest.json          # id (publish), documentAccess: dynamic-page, OpenAI only
  dist/code.js           # main thread — all rule engine + AI logic
  ui.html                # UI iframe — postMessage only, no figma.* / no fetch
  fonts/                 # CircularXX (UI)
.cursor/rules/
  figma-a11y-developer.mdc   # Cursor agent rules (alwaysApply: true)
```

  ---

## Architecture

Two-thread Figma plugin:
- **Main thread** (`dist/code.js`): classification, rule checks, autofix, OpenAI calls
- **UI iframe** (`ui.html`): renders results, dispatches actions to main thread

Communication: `figma.ui.postMessage()` ↔ `parent.postMessage({ pluginMessage })`

Main thread: `figma.ui.onmessage = async (msg) => { ... }` — all node lookups via
`await getNodeById(id)` (`getNodeByIdAsync` wrapper). **Never** `figma.getNodeById`.

---

## Published vs Development (critical)

| | Development | Published |
|---|-------------|-----------|
| Run from | `Plugins → Development → Import manifest` | Community/org install; manifest `id` must match |
| Code updates | Re-import / reload plugin after file changes | New version via Figma publish flow |
| `getNodeById` sync | Do not rely on it — breaks when published | **Use async only** or plugin crashes on analyze |
| Network | Only `api.openai.com` in manifest | Same; `figma.com/api/*` is **not** available |
| Figma AI | No REST for plugins | Clipboard prompt + designer pastes in Figma AI |

**Pre-publish checks:** `grep figma\.getNodeById\( dist/code.js` → 0; `grep figma.com/api` → 0;
`node --check dist/code.js`; test analyze on accordion frame (`clickables`).

---

## Component Classification Pipeline

```
getSemanticRoot(node)
  → await gatherContext(root)     // MUST await — includes await deepChildScan
  → detectComponent(ctx, node)    // spec scores use ctx.hasChevrons, etc.
  → await auditNode(...) when spec matched
  → if LOW / no spec → classifyWithAI (gpt-4o-mini)
  → if unknown → classifyWithVision (gpt-4o)
  → await runSpecsForType → await auditNode + enrichIssues
```

### Deep context (depth 3) — async chain

- `deepChildScan(node, 3, depth)` — **async**, `for` loop + `await` per child (never `forEach` + async)
- `mergeDeepScanResults` merges child scans; chevrons via layer name + `subtreeHasChevronName`
- `gatherContext` → `const deep = await deepChildScan(node, 3, 0)` then spreads into ctx
- Temporary debug: `[classify] <name> hasChevrons: … allChildNames: …` when name contains `clickable` or childCount ≥ 3

If `hasChevrons` is `undefined` in logs → a caller forgot `await gatherContext` (regression).

### Accordion classification (strict)

- **main branch**: +8 when ≥2 compound rows OR (`hasChevrons` + ≥2 `repeatingPatterns`), vertical layout
- **ux branch**: cumulative accordion score (≥7 to compete) — see `scoreAccordionSignals` on that branch
- **Layout gate**: `HORIZONTAL` / `GRID` / `WRAP` → accordion blocked
- **Tablist counter**: avg direct child height &gt; 48px → tablist −4 (accordion-like stacks)
- **No generic `"item"`** pattern; multi-select copy cancels accordion
- **Checkbox group boost**: repeating + select-all copy → +4 on checkbox spec

### Type competition
All specs scored; highest wins. Margin &lt; 3 vs runner-up → Vision tiebreak (`vision-tiebreak` path).

### Spatial proximity (critical)
`findSpatiallyNearbyText(node, radiusPx=200)` uses `absoluteBoundingBox`.
Checks above, left, and inside. **No early `break`** — counts ALL matching keywords.

### Key signals for classification
- `childNames`: array of child node names (catches star ratings, radio items)
- `actionTextKeywords`: ["submit","send","save","continue","confirm"] → +3 signal for button
- `siblingPatterns`: checks children (not siblings!) for repeated structures

### COMPONENT_SET guard
`componentPropertyDefinitions` throws when called on a COMPONENT inside a COMPONENT_SET.
Always check: `if (node.parent?.type === "COMPONENT_SET") readFrom = node.parent`

---

## Semantic Slug Resolution

`resolveSuggestions(suggestions, rootNode)` maps AI-returned node references to real Figma IDs:

| Input | Resolves to |
|-------|-------------|
| `__ROOT__` | `rootNode.id` |
| `__STAR_CHILDREN__` | children with "star" in name |
| `"rating-star"` (semantic slug) | subtree search by name match |
| `"123:456"` (real ID) | direct |

Resolve to real IDs, then **`await getNodeById(id)`** — never sync `figma.getNodeById`.

---

## Self-Healing (AUTO_FIX_HANDLERS)

Philosophy: **never fail silently — always attempt a fix first**.

```js
const AUTO_FIX_HANDLERS = {
  NO_GROUP_LABEL:     fixNoGroupLabel,
  NO_INPUT_LABEL:     fixNoInputLabel,
  MISSING_ALT:        fixMissingAlt,
  LOW_CONTRAST:       fixLowContrast,
  SMALL_TOUCH_TARGET: fixSmallTouchTarget,
  NO_FOCUS_RING:      fixNoFocusRing,
  MISSING_ROLE:       fixMissingRole,
  NO_ERROR_MESSAGE:   fixNoErrorMessage,
}

Uses `figma.commitUndo()` for one-step undo
After every successful autofix: call `refreshSummaryBanner()` (blocker banner must update)
Fix modal offers 3 options: Autofix / Copy fixed clone / Skip
"Copy fixed clone": `node.clone()`, placed 120px right, wrapped in green-stroke frame

---

Background Color Compositing

`getEffectiveBackground(node)`:
Climbs ancestor tree until it finds an opaque fill
Used for contrast checks against transparent/composited backgrounds

`getNodeComposedFill(node)`:
Composites all fills bottom-to-top with src-over blending
Applies `node.opacity` to final result

---

Storage

| Purpose | API |
|---------|-----|
| API key | `figma.clientStorage.setAsync("openai-key", key)` |
| Component index | `figma.clientStorage.setAsync("component-index", data)` |
| ARIA annotations | `node.setPluginData("aria-role", value)` |
| Cross-plugin ARIA | `node.setSharedPluginData("a11y", "aria-label", value)` |

---

UI Features (all implemented)

Scan results panel: issues grouped by component with severity badges
Two-layer messaging: contextual title + ISSUE_EXPLANATIONS (in code.js) + [?] button
Log panel: timestamped console output visible to designer
Designer checkmarks: mark issues as reviewed/accepted
Fix modal: 3-option fix flow (autofix / clone / skip)
Preview panel: renders affected node in context
Component history dashboard: persistent scan history via clientStorage
Viewport navigation: `figma.viewport.scrollAndZoomIntoView([node])` on issue click
Semantic naming suggestions: AI-generated accessible name proposals

---

Two-Layer Messaging (implemented)

Every issue in **Analyze Selection** and **Scan Frame** gets:
- **Layer 1** — `displayTitle`: AI batch titles when API key present (single selection only); else `ISSUE_EXPLANATIONS[code].staticTitle`
- **Layer 2** — `explanation`: static map in `dist/code.js` (23 codes + aliases); UI `[?]` opens slide-in panel
- Batch scan uses static layer 1 only (`apiKey: null`) to avoid N OpenAI calls

---

Vision AI Fallback (implemented)

When text `classifyWithAI` returns `unknown` or no matching spec:
1. `exportAsync` PNG at 0.5 scale → `figma.base64Encode`
2. GPT-4o vision (`detail: "low"`)
3. `findSpecByRoleHint` → `runSpecsForType` → full `auditNode` + `enrichIssuesWithTitlesAndExplanations`
4. `detectionPath: "vision-ai"` shown in UI

---

WCAG 2.2 AA Rules Enforced

| Rule | Threshold |
|------|-----------|
| Text contrast | 4.5:1 (normal), 3:1 (large/bold) |
| Non-text contrast | 3:1 |
| Touch target size | 44×44px minimum, 24×24px with spacing |
| Focus visible | Ring must meet 3:1 contrast against adjacent colors |
| Label presence | All inputs, buttons, icons must have accessible name |
| Error identification | Errors must be text-described, not color-only |

---

ARIA APG Patterns per Component Type

| Component | Pattern |
|-----------|---------|
| button | `role="button"`, keyboard: Enter/Space |
| textField | `role="textbox"`, associated `<label>` |
| checkbox | `role="checkbox"`, `aria-checked` |
| radio-group | `role="radiogroup"` + `role="radio"` children |
| select/dropdown | `role="combobox"` or `role="listbox"` |
| modal | `role="dialog"`, `aria-modal="true"`, focus trap |
| tabs | `role="tablist"` + `role="tab"` + `role="tabpanel"` |
| slider | `role="slider"`, `aria-valuenow/min/max` |
| star-rating | `role="group"` + radio pattern or `role="img"` with label |
| toggle | `role="switch"`, `aria-checked` |
| accordion | heading > button, `aria-expanded`, `role="region"` panels |

### Spec matrix (audit engine)

`COMPONENT_SPEC_MATRIX` — 11 types, 6–8 explicit check IDs each (not a single role check).
`SPEC_CHECKERS[checkId]` — one function per ID; returns `[]` or issues.
`runMatrixChecks` / `auditNode` / `runSpecsForType` — run **every** check in the matrix for that type.

`HAS_HEADING` (4-tier): (1) aria-label/labelledby annotation, (2) TEXT ≥16px & ≥600 weight
in subtree depth ≤3, (3) spatial text ≤40px above, (4) node name title/header/heading/label.

---

## What NOT to Change

- `resolveSuggestions()` — all four resolution paths are needed
- `await getNodeById` / `getNodeByIdAsync` — never reintroduce sync `figma.getNodeById`
- `await gatherContext` → `await deepChildScan` — never `forEach(async …)` or missing await
- `refreshSummaryBanner()` after autofix — stale blocker banner if removed
- `node.parent?.type === "COMPONENT_SET"` guard — runtime throw if removed
- Do **not** add `fetch` to `figma.com` — Figma AI stays clipboard-only (no REST)

---

Manual Testing Plan

Run in Figma with plugin reloaded (`Plugins → Development → A11y Shift`). Requires OpenAI key for AI/vision paths.

| # | Component | Test selection | Spec engine | Text AI | Vision AI | Two-layer `[?]` | Autofix |
|---|-----------|----------------|-------------|---------|-----------|-----------------|---------|
| 1 | button | Icon-only + labeled variants | ✓ | — | — | ✓ | touch, focus |
| 2 | textField | Input w/o label, error variant | ✓ | — | — | ✓ | NO_INPUT_LABEL |
| 3 | checkbox | Single + group | ✓ | — | — | ✓ | — |
| 4 | radio-group | 3 options + legend | ✓ | — | — | ✓ | NO_GROUP_LABEL |
| 5 | star-rating | 5 stars, no group label | ✓ | ASK if ambiguous | — | ✓ | labels |
| 6 | combobox / select | Custom dropdown | ✓ | — | — | ✓ | — |
| 7 | modal / dialog | No close / no heading | ✓ | — | — | ✓ | close, heading |
| 8 | accordion | Wrong heading order | ✓ | — | — | ✓ | heading |
| 9 | chip / badge | Removable chip, × no label | ✓ | — | — | ✓ | — |
| 10 | toggle / switch | Unnamed switch frame | MED/LOW | ✓ if unnamed | ✓ if still unknown | ✓ | — |

**Vision-specific:** Select a frame with no semantic layer names (e.g. "Frame 47" with star vectors). Expect `AI_LOADING` → vision phase → `Vision AI (GPT-4o)` badge → issues from star-rating or radio spec.

**Batch scan:** Select a frame with 3+ components → Scan Frame → expand row issues in export JSON; each issue should have `displayTitle` + `explanation` in plugin payload (export may omit `explanation` for size — verify in Analyze after click).

**Regression:** HIGH spec match must skip AI; `refreshSummaryBanner` after autofix; COMPONENT_SET parent guard on instances.

---

Original 10-Component Spec (reference only — all implemented)

button, textField, checkbox, radio-group, select/dropdown, modal, tabs, slider, star-rating, toggle
```


## Completed Work Log

_Cursor agent appends here after each task. Format: ✅ Task — what/why/gotcha_

<!-- entries below -->

- ✅ Two-layer messaging — completed ISSUE_EXPLANATIONS for all audit codes; wired `enrichIssuesWithTitlesAndExplanations` into `SCAN_FRAME` (static titles in batch).
  - Gotcha: explanations live in `dist/code.js`, not `ui.html`; batch scan skips AI titles to limit API cost.

- ✅ Vision AI pipeline — `classifyWithVision` + `findSpecByRoleHint` + `runSpecsForType`; text-unknown → vision → re-audit; UI shows `vision-ai` detection path.
  - Gotcha: vision uses GPT-4o only (cost); preview PNG stays at 2× scale separately from vision export (0.5×).

- ✅ Manual testing plan — matrix added above for all 10 component types + vision/batch/regression checks.

- ✅ Deep scan + spec matrix — `deepChildScan` depth 3; `COMPONENT_SPEC_MATRIX` for 11 types;
  `runSpecsForType` runs full matrix; accordion chevron/repeating-row signals; `HAS_HEADING` 4-tier.
  - Gotcha: batch scan still skips AI titles; status/chip uses legacy `spec.audits` path only.

- ✅ Fix coverage (Parts A–D) — 48/48 matrix checks bridged to autofix handlers; generic `ANNOTATION_FIX_MAP`, `checkNonTextContrast` (3:1), AI consent dialog, acknowledge flow.
  - Verify: reload plugin → Settings → Run fix coverage report → expect 48 with autofix, 0 missing.
  - Test: `ROLE_BUTTON_MISSING` → Auto-fix → shared `aria-role=button`; `RADIO_NO_LABEL` → AI consent → labels; no-handler issues → Mark as acknowledged only.

  layout gate (VERTICAL only), removed generic `item` scoring, checkbox-group counter-signals,
  ranked spec competition, Vision tiebreak when margin &lt; 3.
  - Gotcha: `NONE` layout uses stacked bounding-box heuristic for vertical check.

- ✅ Visibility filter + contrast autofix — `isNodeVisible()` on deep scan, matrix checks, audits;
  `fixLowContrast` (HSL L binary search); Figma AI prompts include node ID, colors, ratio, action.
  - Gotcha: `refreshSummaryBanner()` runs in UI via `REFRESH_SUMMARY_BANNER` postMessage after contrast fix.

- ✅ Production publish fixes — `getNodeByIdAsync` throughout; manifest `id` + `documentAccess: dynamic-page`;
  login password UI; no Figma REST calls.
  - Gotcha: published build throws on sync `getNodeById`; dev import can hide the bug until publish.

- ✅ Classification async regression — `deepChildScan` / `gatherContext` fully async (`for` + `await`);
  accordion vs tablist signals (chevrons, repeating patterns, row-height tablist penalty).
  - Gotcha: `forEach(async () => …)` does not await — breaks `hasChevrons` and accordion detection.