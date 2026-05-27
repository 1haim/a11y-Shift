"use strict";

// Network: only OpenAI (manifest networkAccess). Do NOT call Figma REST (e.g.
// /api/custom_tools/owned_by_user) — not part of Plugin API and will 403/404.
// TODO: Figma AI is not exposed to plugins via REST; keep copy-to-clipboard flow only.

// Published plugins must use getNodeByIdAsync — sync getNodeById throws at runtime.
async function getNodeById(id) {
  if (!id) return null;
  return await figma.getNodeByIdAsync(id);
}

// documentAccess: dynamic-page — sync mainComponent throws; always use async.
async function getMainComponent(node) {
  if (!node || node.type !== "INSTANCE") return null;
  try {
    return await node.getMainComponentAsync();
  } catch (_e) {
    return null;
  }
}

// Layers the plugin created (wrappers, tags, generated labels) — never audit or traverse.
function isA11yGeneratedLayer(node) {
  if (!node || !node.name) return false;
  return node.name.indexOf("_a11y_") === 0;
}

function notifyScanSkipped(node) {
  figma.ui.postMessage({
    type: "SCAN_SKIPPED",
    reason: "This layer was created by A11y Shift. Select the original component.",
    nodeName: node ? node.name : "",
  });
}

function emptyAuditResult() {
  return { issues: [], auditLog: [] };
}

// ─── Visibility (skip hidden layers + hidden ancestors) ───────────────────────

function isNodeVisible(node) {
  if (!node) return false;
  if (isA11yGeneratedLayer(node)) return false;
  if (node.visible === false) return false;
  if (node.opacity !== undefined && node.opacity !== null && node.opacity <= 0) return false;
  let current = node.parent;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.visible === false) return false;
    if (current.opacity !== undefined && current.opacity !== null && current.opacity <= 0) return false;
    current = current.parent;
  }
  return true;
}

// ─── Spatial context: read labels near the node on canvas ─────────────────────

// allTextNodes is an optional pre-collected list (for batch operations).
// When omitted the function collects text from the page — fine for single-node analysis,
// but O(n×m) for batch. Always pass allTextNodes in batch contexts.
function findSpatiallyNearbyText(node, radiusPx, allTextNodes) {
  radiusPx = radiusPx || 200;
  const box = node.absoluteBoundingBox;
  if (!box) return [];

  const allText = allTextNodes || figma.currentPage.findAllWithCriteria({ types: ["TEXT"] });

  return allText
    .filter((t) => {
      if (!isNodeVisible(t)) return false;
      const tb = t.absoluteBoundingBox;
      if (!tb) return false;

      const inXBand = tb.x >= box.x - 60 && tb.x <= box.x + box.width + 60;
      const inYBand = tb.y >= box.y - 60 && tb.y <= box.y + box.height + 60;

      const above = tb.y + tb.height <= box.y + 10 && tb.y + tb.height >= box.y - radiusPx;
      const left  = tb.x + tb.width  <= box.x + 10 && tb.x + tb.width  >= box.x - radiusPx;
      const inside =
        tb.x >= box.x && tb.y >= box.y &&
        tb.x + tb.width <= box.x + box.width &&
        tb.y + tb.height <= box.y + box.height;

      return inside || (above && inXBand) || (left && inYBand);
    })
    .map((t) => t.characters.trim())
    .filter(Boolean);
}

// ─── Semantic root: traverse UP to find the full component group ──────────────

function getSemanticRoot(node) {
  let cursor = node;

  while (cursor.parent && cursor.parent.type !== "PAGE") {
    const parent = cursor.parent;
    if (!("children" in parent)) break;
    if (isA11yGeneratedLayer(parent)) break;

    const siblings = parent.children;
    const allSameType = siblings.length >= 2 && siblings.every((s) => s.type === cursor.type);
    const pLower = parent.name.toLowerCase();
    const parentLooksLikeGroup =
      pLower.includes("group") || pLower.includes("radio") ||
      pLower.includes("star") || pLower.includes("rating") ||
      pLower.includes("check") || pLower.includes("tab") ||
      pLower.includes("toggle") || pLower.includes("segment");

    if (allSameType || parentLooksLikeGroup) {
      cursor = parent;
    } else {
      break;
    }
  }

  return cursor;
}

// ─── Deep child scan (depth 3) ────────────────────────────────────────────────

const CHEVRON_NAME_RE = /chevron|arrow|expand|collapse|caret|dropdown-icon|▼|▾|▸|dropdown/i;
const HEADING_NAME_RE = /title|header|heading|label|section/i;

function childStructureSignature(node, depthLeft) {
  if (!node || depthLeft < 0) return "";
  const tag = node.type + ":" + (node.name || "").toLowerCase().split(/[\s/_-]+/)[0];
  if (!("children" in node) || depthLeft === 0 || !node.children.length) return tag;
  const parts = [];
  const limit = Math.min(node.children.length, 12);
  for (let i = 0; i < limit; i++) parts.push(childStructureSignature(node.children[i], depthLeft - 1));
  return tag + "[" + parts.join("|") + "]";
}

function detectRepeatingPatterns(root, maxDepth) {
  const patterns = [];
  if (!root || !("children" in root) || root.children.length < 2) return patterns;
  const sigCounts = {};
  const limit = Math.min(root.children.length, 30);
  for (let i = 0; i < limit; i++) {
    const sig = childStructureSignature(root.children[i], Math.min(2, maxDepth));
    if (!sig) continue;
    sigCounts[sig] = (sigCounts[sig] || 0) + 1;
  }
  for (const sig in sigCounts) {
    if (sigCounts[sig] >= 2) patterns.push(sig);
  }
  return patterns;
}

function readTextStyle(textNode) {
  let fontSize = 12;
  let fontWeight = 400;
  if (textNode.fontSize !== figma.mixed && typeof textNode.fontSize === "number") {
    fontSize = textNode.fontSize;
  }
  if (textNode.fontWeight !== figma.mixed && typeof textNode.fontWeight === "number") {
    fontWeight = textNode.fontWeight;
  } else if (textNode.fontName !== figma.mixed && textNode.fontName && textNode.fontName.style) {
    const st = String(textNode.fontName.style).toLowerCase();
    if (st.includes("bold") || st.includes("semibold") || st.includes("medium")) fontWeight = 600;
  }
  return { fontSize: fontSize, fontWeight: fontWeight };
}

function isHeadingStyledText(textNode) {
  const st = readTextStyle(textNode);
  return st.fontSize >= 16 && st.fontWeight >= 600;
}

function emptyDeepScan() {
  return {
    allChildNames: [],
    allChildTypes: [],
    repeatingPatterns: [],
    textHierarchy: [],
    hasChevrons: false,
    leafTextNodes: [],
  };
}

function isChevronLayerName(name) {
  return CHEVRON_NAME_RE.test(name || "");
}

function mergeDeepScanResults(target, sub) {
  if (!sub) return;
  let ti;
  for (ti = 0; ti < sub.allChildNames.length; ti++) target.allChildNames.push(sub.allChildNames[ti]);
  for (ti = 0; ti < sub.allChildTypes.length; ti++) target.allChildTypes.push(sub.allChildTypes[ti]);
  for (ti = 0; ti < sub.textHierarchy.length; ti++) target.textHierarchy.push(sub.textHierarchy[ti]);
  for (ti = 0; ti < sub.leafTextNodes.length; ti++) {
    if (target.leafTextNodes.indexOf(sub.leafTextNodes[ti]) < 0) target.leafTextNodes.push(sub.leafTextNodes[ti]);
  }
  if (sub.hasChevrons) target.hasChevrons = true;
}

// Walk subtree up to maxDepth; collect names, types, text hierarchy, chevrons.
// Must use for-loop + await (never forEach with async callback).
async function deepChildScan(node, maxDepth, depth) {
  maxDepth = maxDepth !== undefined ? maxDepth : 3;
  depth = depth !== undefined ? depth : 0;
  if (!node || depth >= maxDepth) return emptyDeepScan();

  try {
    const result = emptyDeepScan();

    if (node.type === "TEXT") {
      const chars = (node.characters || "").trim();
      if (chars) {
        result.leafTextNodes.push(chars);
        const st = readTextStyle(node);
        result.textHierarchy.push({
          text: chars,
          fontSize: st.fontSize,
          fontWeight: st.fontWeight,
          depth: depth,
          name: node.name,
        });
      }
      return result;
    }

    if (!("children" in node) || !node.children.length) {
      if (depth === 0) {
        result.repeatingPatterns = detectRepeatingPatterns(node, maxDepth);
      }
      return result;
    }

    const limit = Math.min(node.children.length, depth === 0 ? 40 : 80);
    for (let i = 0; i < limit; i++) {
      const child = node.children[i];
      if (!isNodeVisible(child) || isA11yGeneratedLayer(child)) continue;

      const nm = child.name || "";
      result.allChildNames.push(nm);
      result.allChildTypes.push(child.type);
      if (isChevronLayerName(nm) || subtreeHasChevronName(child, 3)) {
        result.hasChevrons = true;
      }

      const sub = await deepChildScan(child, maxDepth, depth + 1);
      mergeDeepScanResults(result, sub);
    }

    if (depth === 0) {
      result.repeatingPatterns = detectRepeatingPatterns(node, maxDepth);
    }

    return result;
  } catch (e) {
    console.warn("[deepChildScan] failed:", e && e.message ? e.message : String(e));
    return emptyDeepScan();
  }
}

function subtreeHasText(n, maxDepth) {
  if (!n || maxDepth < 0 || !isNodeVisible(n)) return false;
  if (n.type === "TEXT" && (n.characters || "").trim()) return true;
  if (!("children" in n)) return false;
  const lim = Math.min(n.children.length, 24);
  for (let i = 0; i < lim; i++) {
    if (subtreeHasText(n.children[i], maxDepth - 1)) return true;
  }
  return false;
}

function subtreeHasChevronName(n, maxDepth) {
  if (!n || maxDepth < 0 || !isNodeVisible(n)) return false;
  if (CHEVRON_NAME_RE.test(n.name || "")) return true;
  if (!("children" in n)) return false;
  const lim = Math.min(n.children.length, 24);
  for (let i = 0; i < lim; i++) {
    if (subtreeHasChevronName(n.children[i], maxDepth - 1)) return true;
  }
  return false;
}

// Chevron on a direct row child is often nested (depth 2), not on the row layer name.
function childSubtreeHasChevron(child, maxDepth) {
  maxDepth = maxDepth !== undefined ? maxDepth : 2;
  if (!child || !isNodeVisible(child)) return false;
  if (CHEVRON_NAME_RE.test(child.name || "")) return true;
  if (!("children" in child)) return false;
  function walk(n, depth) {
    if (!n || depth > maxDepth || !isNodeVisible(n)) return false;
    if (CHEVRON_NAME_RE.test(n.name || "")) return true;
    if (!("children" in n)) return false;
    const lim = Math.min(n.children.length, 24);
    for (let i = 0; i < lim; i++) {
      if (walk(n.children[i], depth + 1)) return true;
    }
    return false;
  }
  const lim = Math.min(child.children.length, 24);
  for (let i = 0; i < lim; i++) {
    if (walk(child.children[i], 1)) return true;
  }
  return false;
}

function hasTextDescendant(child, maxDepth) {
  return subtreeHasText(child, maxDepth !== undefined ? maxDepth : 2);
}

function getRootLayoutMode(node) {
  if (node && node.layoutMode && node.layoutMode !== "NONE") return node.layoutMode;
  if (node && "children" in node) {
    const lim = Math.min(node.children.length, 24);
    for (let i = 0; i < lim; i++) {
      const c = node.children[i];
      if (c.layoutMode && c.layoutMode !== "NONE") return c.layoutMode;
    }
  }
  return "NONE";
}

function isRootLayoutWrap(node) {
  return !!(node && node.layoutWrap === "WRAP");
}

function directChildrenLookVertical(node) {
  if (!node || !("children" in node) || node.children.length < 2) return false;
  const boxes = [];
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const b = node.children[i].absoluteBoundingBox;
    if (b) boxes.push(b);
  }
  if (boxes.length < 2) return false;
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].y <= boxes[i - 1].y + boxes[i - 1].height * 0.4) return false;
  }
  return true;
}

function getAccordionRowsWithChevron(node) {
  if (!node || !("children" in node)) return [];
  const rows = [];
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const child = node.children[i];
    if (!isNodeVisible(child)) continue;
    if (hasTextDescendant(child, 2) && childSubtreeHasChevron(child, 2)) rows.push(child);
  }
  return rows;
}

function countCoLocatedAccordionRows(node) {
  return getAccordionRowsWithChevron(node).length;
}

function averageDirectChildWidth(node) {
  if (!node || !("children" in node)) return 0;
  let sum = 0;
  let n = 0;
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const c = node.children[i];
    if (!isNodeVisible(c)) continue;
    const box = c.absoluteBoundingBox;
    if (box && box.width > 0) { sum += box.width; n++; }
  }
  return n > 0 ? sum / n : 0;
}

function averageDirectChildHeight(node) {
  if (!node || !("children" in node)) return 0;
  let sum = 0;
  let n = 0;
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const c = node.children[i];
    if (!isNodeVisible(c)) continue;
    const box = c.absoluteBoundingBox;
    if (box && box.height > 0) { sum += box.height; n++; }
  }
  return n > 0 ? sum / n : 0;
}

function countPillChildren(node) {
  if (!node || !("children" in node)) return 0;
  let pills = 0;
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const c = node.children[i];
    const box = c.absoluteBoundingBox;
    if (!box || box.width >= 200) continue;
    let radius = 0;
    if (c.cornerRadius !== undefined && c.cornerRadius !== figma.mixed) {
      radius = typeof c.cornerRadius === "number" ? c.cornerRadius : 0;
    }
    if (radius >= 8 || radius >= Math.min(box.width, box.height) * 0.2) pills++;
  }
  return pills;
}

function countSmallRepeatingChildren(node) {
  if (!node || !("children" in node) || node.children.length < 2) return 0;
  let small = 0;
  const lim = Math.min(node.children.length, 30);
  for (let i = 0; i < lim; i++) {
    const box = node.children[i].absoluteBoundingBox;
    if (box && box.height < 44 && box.width < 200) small++;
  }
  return small >= 2 ? small : 0;
}

// Generic "item" is not a discriminating signal — skip it everywhere.
function layerNameMatchesPattern(layerName, pat) {
  const nl = (layerName || "").toLowerCase();
  if (!pat || pat === "item") return false;
  if (pat.indexOf("-") >= 0 || pat.indexOf("_") >= 0 || pat.length > 6) return nl.indexOf(pat) >= 0;
  return new RegExp("(^|[\\s/_-])" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([\\s/_-]|$)").test(nl);
}

function buildAccordionContextFields(node) {
  const rootLayoutMode = getRootLayoutMode(node);
  const rootLayoutWrap = isRootLayoutWrap(node);
  const coLocatedRows = countCoLocatedAccordionRows(node);
  const layoutBlocked = rootLayoutMode === "HORIZONTAL" || rootLayoutMode === "GRID" || rootLayoutWrap;
  const verticalOk =
    rootLayoutMode === "VERTICAL" ||
    (rootLayoutMode === "NONE" && directChildrenLookVertical(node));
  return {
    rootLayoutMode: rootLayoutMode,
    rootLayoutWrap: rootLayoutWrap,
    accordionCoLocatedRows: coLocatedRows,
    accordionLayoutBlocked: layoutBlocked,
    accordionVerticalOk: verticalOk && !layoutBlocked,
    pillChildCount: countPillChildren(node),
    smallRepeatingRowCount: countSmallRepeatingChildren(node),
  };
}

function nearbyHasMultiSelectCopy(ctx) {
  const blob = (ctx.nearbyText || []).concat(ctx.innerText || []).join(" ").toLowerCase();
  return (
    blob.indexOf("select all that apply") >= 0 ||
    blob.indexOf("select all") >= 0 ||
    (blob.indexOf("choose") >= 0 && blob.indexOf("choose one") < 0)
  );
}

// ─── Context gathering ────────────────────────────────────────────────────────

// allTextNodes: optional pre-collected page-level text nodes (for batch perf)
async function gatherContext(node, allTextNodes) {
  const parent = node.parent || null;
  const grandparent = parent ? parent.parent : null;

  const parentName = parent ? parent.name : "";
  const grandparentName = grandparent ? grandparent.name : "";

  const siblings =
    parent && "children" in parent
      ? parent.children.map((c) => ({ name: c.name, type: c.type }))
      : [];

  const innerText =
    "findAllWithCriteria" in node
      ? node.findAllWithCriteria({ types: ["TEXT"] })
          .filter(function(t) { return isNodeVisible(t); })
          .map((t) => t.characters.trim())
      : [];

  const nearbyText = findSpatiallyNearbyText(node, 250, allTextNodes);

  const childNames = "children" in node
    ? node.children
        .filter(function(c) { return isNodeVisible(c); })
        .map((c) => ({ name: c.name, type: c.type }))
    : [];

  const childCount = childNames.length;

  const allChildrenSameType = childCount >= 2 &&
    childNames.every((c) => c.type === childNames[0].type);

  // Longest common prefix across all child names (case-insensitive)
  let childNamePrefix = "";
  if (childCount >= 2) {
    const first = childNames[0].name.toLowerCase();
    let prefix = first;
    for (let i = 1; i < childNames.length; i++) {
      const n = childNames[i].name.toLowerCase();
      let j = 0;
      while (j < prefix.length && j < n.length && prefix[j] === n[j]) j++;
      prefix = prefix.slice(0, j);
      if (!prefix) break;
    }
    // Strip trailing separator characters to get a clean prefix token
    childNamePrefix = prefix.replace(/[-_\s/]+$/, "");
  }

  let variantProps = {};
  let componentProps = {};
  if (node.type === "INSTANCE") {
    variantProps = node.variantProperties || {};
    var main = await getMainComponent(node);
    if (main) {
      var instDefs = (main.parent && main.parent.type === "COMPONENT_SET")
        ? main.parent.componentPropertyDefinitions
        : main.componentPropertyDefinitions;
      for (const [k, v] of Object.entries(instDefs || {})) {
        componentProps[k] = String(v.defaultValue || "");
      }
    }
  }
  if (node.type === "COMPONENT") {
    var isVariant = node.parent && node.parent.type === "COMPONENT_SET";
    var compDefs = isVariant
      ? node.parent.componentPropertyDefinitions
      : node.componentPropertyDefinitions;
    for (const [k, v] of Object.entries(compDefs || {})) {
      componentProps[k] = String(v.defaultValue || "");
    }
  }

  const deep = await deepChildScan(node, 3, 0);

  const nodeNameLower = (node.name || "").toLowerCase();
  if (nodeNameLower.indexOf("clickable") >= 0 || childCount >= 3) {
    console.log(
      "[classify]", node.name,
      "hasChevrons:", deep.hasChevrons,
      "allChildNames:", (deep.allChildNames || []).slice(0, 8)
    );
  }

  const innerMerged = innerText.slice();
  for (let li = 0; li < deep.leafTextNodes.length; li++) {
    if (innerMerged.indexOf(deep.leafTextNodes[li]) < 0) innerMerged.push(deep.leafTextNodes[li]);
  }

  const layoutFields = buildAccordionContextFields(node);
  const multiSelectCopy = nearbyHasMultiSelectCopy({
    nearbyText: nearbyText,
    innerText: innerMerged,
  });
  const stateVariantMap = await findStateVariantsAsync(node);
  const componentSet = await componentSetForNodeAsync(node);

  return {
    parentName,
    grandparentName,
    siblings,
    siblingCount: siblings.length,
    childNames,
    childCount,
    allChildrenSameType,
    childNamePrefix,
    nearbyText,
    innerText: innerMerged,
    nodeName: node.name,
    nodeType: node.type,
    variantProps,
    componentProps,
    allChildNames: deep.allChildNames,
    allChildTypes: deep.allChildTypes,
    repeatingPatterns: deep.repeatingPatterns,
    textHierarchy: deep.textHierarchy,
    hasChevrons: deep.hasChevrons,
    leafTextNodes: deep.leafTextNodes,
    rootLayoutMode: layoutFields.rootLayoutMode,
    rootLayoutWrap: layoutFields.rootLayoutWrap,
    accordionCoLocatedRows: layoutFields.accordionCoLocatedRows,
    accordionLayoutBlocked: layoutFields.accordionLayoutBlocked,
    accordionVerticalOk: layoutFields.accordionVerticalOk,
    pillChildCount: layoutFields.pillChildCount,
    smallRepeatingRowCount: layoutFields.smallRepeatingRowCount,
    accordionMultiSelectCopy: multiSelectCopy,
    stateVariantMap: stateVariantMap,
    componentSet: componentSet,
  };
}

// ─── Issue model ──────────────────────────────────────────────────────────────
// severity: "HIGH" = blocker | "MED" = warning | "LOW" = best-practice

function makeIssue(severity, code, wcagRef, message, nodeId, suggestedFix) {
  // autoFixable / displayTitle / explanation are filled in at the API boundary
  // (see ANALYZE_SELECTION) because AUTO_FIX_HANDLERS + ISSUE_EXPLANATIONS are
  // declared later in the file (would TDZ otherwise).
  return {
    severity: severity,
    code: code,
    wcagRef: wcagRef,
    message: message,
    nodeId: nodeId,
    suggestedFix: suggestedFix || null,
  };
}

// ─── WCAG math helpers ────────────────────────────────────────────────────────

function relativeLuminance(r, g, b) {
  const rs = r / 255, gs = g / 255, bs = b / 255;
  const rL = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
  const gL = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
  const bL = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);
  return 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
}

function contrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLargeText(textNode) {
  const size   = textNode.fontSize   || 0;
  const weight = textNode.fontWeight || 400;
  return size >= 18 || (size >= 14 && weight >= 700);
}

function rgbToHex255(r, g, b) {
  function h(n) {
    const x = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return x.length === 1 ? "0" + x : x;
  }
  return "#" + h(r) + h(g) + h(b);
}

function rgbToHsl255(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb255(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = function(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function contrastRatioForRgb255(rgb, bg) {
  const tl = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const bl = relativeLuminance(bg.r, bg.g, bg.b);
  return contrastRatio(tl, bl);
}

function getTextContrastMetrics(textNode) {
  if (!textNode || textNode.type !== "TEXT") return null;
  const rawFill = getNodeComposedFill(textNode);
  if (!rawFill || rawFill.a < 0.01) return null;
  const bg = getEffectiveBackground(textNode);
  const bgR01 = bg.r / 255;
  const bgG01 = bg.g / 255;
  const bgB01 = bg.b / 255;
  let pr, pg, pb;
  if (rawFill.a >= 0.995) {
    pr = rawFill.r; pg = rawFill.g; pb = rawFill.b;
  } else {
    const a = rawFill.a;
    const inv = 1 - a;
    pr = rawFill.r * a + bgR01 * inv;
    pg = rawFill.g * a + bgG01 * inv;
    pb = rawFill.b * a + bgB01 * inv;
  }
  const perceived = {
    r: Math.round(pr * 255),
    g: Math.round(pg * 255),
    b: Math.round(pb * 255),
  };
  const ratio = contrastRatioForRgb255(perceived, bg);
  const large = isLargeText(textNode);
  const required = large ? 3.0 : 4.5;
  return { perceived: perceived, bg: bg, ratio: ratio, required: required, large: large };
}

// Binary search H/S; adjust L only until contrastRatio >= targetRatio (minimal delta from startL).
function findLightnessForContrast(h, s, bg, targetRatio, startL) {
  function meets(L) {
    return contrastRatioForRgb255(hslToRgb255(h, s, L), bg) >= targetRatio;
  }
  if (meets(startL)) return startL;

  let best = null;
  let bestDelta = Infinity;

  function searchRange(lo, hi) {
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (meets(mid)) {
        const d = Math.abs(mid - startL);
        if (d < bestDelta) { bestDelta = d; best = mid; }
        if (mid < startL) lo = mid; else hi = mid;
      } else {
        if (mid < startL) hi = mid; else lo = mid;
      }
    }
  }

  searchRange(0, startL);
  searchRange(startL, 100);

  if (best === null) {
    for (let L = 0; L <= 100; L += 0.5) {
      if (meets(L)) {
        const d = Math.abs(L - startL);
        if (d < bestDelta) { bestDelta = d; best = L; }
      }
    }
  }
  return best;
}

// Shared wrapper — binary search HSL lightness for target contrast ratio.
function findAccessibleColor(h, s, bgRgb255, targetRatio, startL) {
  return findLightnessForContrast(h, s, bgRgb255, targetRatio, startL);
}

// Composites all visible fills on a node bottom-to-top using "src over dst",
// then multiplies the accumulated alpha by node.opacity.
// Returns { r, g, b, a } all normalized 0–1, or null when the node is effectively transparent.
function getNodeComposedFill(node) {
  if (!node) return null;
  const fills = node.fills;
  if (!fills || fills === figma.mixed || !fills.length) return null;

  let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;

  for (let i = 0; i < fills.length; i++) {
    const fill = fills[i];
    if (fill.visible === false) continue;

    let fr, fg, fb, fa;
    if (fill.type === "SOLID") {
      const c = fill.color;
      fr = c.r; fg = c.g; fb = c.b;
      fa = (c.a !== undefined ? c.a : 1);
    } else if (fill.type === "GRADIENT_LINEAR" || fill.type === "GRADIENT_RADIAL" || fill.type === "GRADIENT_ANGULAR") {
      const stops = fill.gradientStops;
      if (!stops || !stops.length) continue;
      const s = stops[0].color;
      fr = s.r; fg = s.g; fb = s.b;
      fa = (s.a !== undefined ? s.a : 1);
    } else {
      continue; // IMAGE, VIDEO — skip
    }

    // fill.opacity is a separate multiplier on top of color alpha
    const fillOpacity = (fill.opacity !== undefined ? fill.opacity : 1);
    fa = fa * fillOpacity;
    if (fa < 0.001) continue;

    // "src over dst" compositing (fills are ordered bottom → top in the array)
    const inv = 1 - fa;
    rAcc = fr * fa + rAcc * inv;
    gAcc = fg * fa + gAcc * inv;
    bAcc = fb * fa + bAcc * inv;
    aAcc = fa + aAcc * inv;
  }

  if (aAcc < 0.01) return null;

  // node.opacity scales the whole node's visual contribution
  const nodeOpacity = (node.opacity !== undefined && node.opacity !== null) ? node.opacity : 1;
  return { r: rAcc, g: gAcc, b: bAcc, a: aAcc * nodeOpacity };
}

// Thin wrapper that converts getNodeComposedFill to 0–255 integers for callers
// that don't need alpha (legacy interface). Returns null when transparent.
function getEffectiveFill(node) {
  const fill = getNodeComposedFill(node);
  if (!fill) return null;
  return { r: Math.round(fill.r * 255), g: Math.round(fill.g * 255), b: Math.round(fill.b * 255) };
}

// Returns the PERCEIVED background color (0–255) behind `node`, accounting for
// semi-transparent fills at every level of the ancestor chain.
//
// Strategy:
//   • For TEXT nodes      → the background starts at the text's parent.
//   • For all other nodes → the node's own fill is its background floor, so we
//                           include the node itself as the innermost layer.
//   • We collect the full chain from the page root down to that innermost layer,
//     then composite each layer's fill (via getNodeComposedFill) from bottom to top.
//   • Canvas default is opaque white (Figma page background).
function compositeBackgroundChain(chain) {
  let bgR = 1, bgG = 1, bgB = 1;
  for (let i = 0; i < chain.length; i++) {
    const fill = getNodeComposedFill(chain[i]);
    if (!fill || fill.a < 0.005) continue;
    const a   = fill.a;
    const inv = 1 - a;
    if (a >= 0.995) {
      bgR = fill.r; bgG = fill.g; bgB = fill.b;
    } else {
      bgR = fill.r * a + bgR * inv;
      bgG = fill.g * a + bgG * inv;
      bgB = fill.b * a + bgB * inv;
    }
  }
  return { r: Math.round(bgR * 255), g: Math.round(bgG * 255), b: Math.round(bgB * 255) };
}

function collectVisibleAncestorChain(startNode) {
  const chain = [];
  let cursor = startNode;
  while (cursor && cursor.type !== "PAGE" && cursor.type !== "DOCUMENT") {
    if (isNodeVisible(cursor)) chain.unshift(cursor);
    cursor = cursor.parent;
  }
  return chain;
}

// Background visible *behind* a shape/icon — never includes the node itself (avoids #fff on #fff).
function getBackgroundBehindNode(node) {
  if (!node || !node.parent) return { r: 255, g: 255, b: 255 };
  return compositeBackgroundChain(collectVisibleAncestorChain(node.parent));
}

function getEffectiveBackground(node) {
  const innermost = (node && node.type !== "TEXT") ? node : (node ? node.parent : null);
  if (!innermost) return { r: 255, g: 255, b: 255 };
  return compositeBackgroundChain(collectVisibleAncestorChain(innermost));
}

// ─── State variant map ────────────────────────────────────────────────────────
// Returns { stateName: ComponentNode } for the COMPONENT_SET containing node.

async function findStateVariantsAsync(node) {
  const variantMap = {};
  let set = null;

  if (node.type === "COMPONENT_SET") {
    set = node;
  } else if (node.type === "COMPONENT") {
    if (node.parent && node.parent.type === "COMPONENT_SET") set = node.parent;
  } else if (node.type === "INSTANCE") {
    const mc = await getMainComponent(node);
    if (mc && mc.parent && mc.parent.type === "COMPONENT_SET") set = mc.parent;
  }

  if (!set || !("children" in set)) return variantMap;

  const STATE_PROP_KEYS    = ["State", "state", "Status", "status"];
  const STATE_NAME_PATTERNS = ["default", "hover", "focus", "active", "disabled", "loading",
                                "pressed", "checked", "unchecked", "expanded", "collapsed"];

  for (let i = 0; i < set.children.length; i++) {
    const child = set.children[i];
    if (child.type !== "COMPONENT") continue;
    let foundState = null;

    // Prefer explicit variant properties
    if (child.variantProperties) {
      for (let k = 0; k < STATE_PROP_KEYS.length; k++) {
        const val = child.variantProperties[STATE_PROP_KEYS[k]];
        if (val) { foundState = val.toLowerCase(); break; }
      }
    }

    // Fallback: infer from component name tokens
    if (!foundState) {
      const nameLower = child.name.toLowerCase();
      for (let k = 0; k < STATE_NAME_PATTERNS.length; k++) {
        if (nameLower.includes(STATE_NAME_PATTERNS[k])) {
          foundState = STATE_NAME_PATTERNS[k];
          break;
        }
      }
    }

    if (foundState && !variantMap[foundState]) {
      variantMap[foundState] = child;
    }
  }

  return variantMap;
}

function findStateVariants(node, ctx) {
  if (ctx && ctx.stateVariantMap) return ctx.stateVariantMap;
  const variantMap = {};
  let set = null;
  if (node.type === "COMPONENT_SET") {
    set = node;
  } else if (node.type === "COMPONENT") {
    if (node.parent && node.parent.type === "COMPONENT_SET") set = node.parent;
  }
  if (!set || !("children" in set)) return variantMap;
  const STATE_PROP_KEYS = ["State", "state", "Status", "status"];
  const STATE_NAME_PATTERNS = ["default", "hover", "focus", "active", "disabled", "loading",
    "pressed", "checked", "unchecked", "expanded", "collapsed"];
  for (let i = 0; i < set.children.length; i++) {
    const child = set.children[i];
    if (child.type !== "COMPONENT") continue;
    let foundState = null;
    if (child.variantProperties) {
      for (let k = 0; k < STATE_PROP_KEYS.length; k++) {
        const val = child.variantProperties[STATE_PROP_KEYS[k]];
        if (val) { foundState = val.toLowerCase(); break; }
      }
    }
    if (!foundState) {
      const nameLower = child.name.toLowerCase();
      for (let k = 0; k < STATE_NAME_PATTERNS.length; k++) {
        if (nameLower.includes(STATE_NAME_PATTERNS[k])) {
          foundState = STATE_NAME_PATTERNS[k];
          break;
        }
      }
    }
    if (foundState && !variantMap[foundState]) variantMap[foundState] = child;
  }
  return variantMap;
}

// ─── Phase B helpers: naming, suggestion generation, ASK questions ────────────

function slugify(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Convert "my component name" → "MyComponentName" (PascalCase)
function toPascalCase(str) {
  return (str || "")
    .replace(/[_\-]+/g, " ")
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
    .join("")
    .slice(0, 40) || "Component";
}

// Default visible headings when autofix creates label text (by matrix type key).
var DEFAULT_HEADING_BY_TYPE = {
  button:      "Action button",
  textField:   "Input field",
  checkbox:    "Checkbox option",
  "radio-group": "Choose one option",
  "star-rating": "Rate this item",
  select:      "Select an option",
  modal:       "Dialog",
  tabs:        "Navigation tabs",
  slider:      "Adjust value",
  toggle:      "Toggle setting",
  accordion:   "Expandable section",
};

function getDefaultHeadingText(roleOrTypeKey) {
  const key = normalizeMatrixTypeKey(roleOrTypeKey || "");
  if (key && DEFAULT_HEADING_BY_TYPE[key]) return DEFAULT_HEADING_BY_TYPE[key];
  return "Select an option";
}

function pascalTypePart(typeKey) {
  const map = {
    button: "Button",
    textField: "TextField",
    checkbox: "Checkbox",
    "radio-group": "RadioGroup",
    "star-rating": "StarRating",
    select: "Select",
    modal: "Modal",
    tabs: "Tabs",
    slider: "Slider",
    toggle: "Toggle",
    accordion: "Accordion",
  };
  return map[typeKey] || toPascalCase(typeKey || "Component");
}

// Primary + secondary types → "RadioGroup-StarRating" (hyphen, no duplicates, max 2 parts).
function generateSemanticName(node, types) {
  const seen = {};
  const parts = [];
  const list = types || [];
  for (let i = 0; i < list.length && parts.length < 2; i++) {
    const tk = normalizeMatrixTypeKey(list[i]);
    if (!tk || seen[tk]) continue;
    seen[tk] = true;
    parts.push(pascalTypePart(tk));
  }
  if (parts.length === 0) return toPascalCase((node && node.name) || "Component");
  if (parts.length === 1) return parts[0];
  return parts[0] + "-" + parts[1];
}

function resolveSemanticLayerName(spec, identifier, competitorRole) {
  const primary = normalizeMatrixTypeKey(spec.role);
  const types = [];
  if (primary) types.push(primary);
  if (spec.isStarRating && primary !== "star-rating") types.push("star-rating");
  if (competitorRole) {
    const comp = normalizeMatrixTypeKey(competitorRole);
    if (comp && comp !== primary) types.push(comp);
  }
  if (types.length >= 2) return generateSemanticName(null, types);
  const typePart = pascalTypePart(primary || spec.role);
  const namePart = toPascalCase(identifier);
  if (!namePart || namePart === typePart) return typePart;
  return typePart + "-" + namePart;
}

// Build semantic layer name (PascalCase, NO ARIA in name). ARIA lives in pluginData only.
function buildLayerName(spec, identifier, competitorRole) {
  return resolveSemanticLayerName(spec, identifier, competitorRole);
}

function deriveIdentifier(spec, ctx) {
  if (spec.role === "button") {
    return slugify(ctx.innerText[0] || ctx.nodeName) || "action";
  }
  if (spec.isStarRating) return "star-rating";
  if (spec.role === "dialog") {
    // prefer heading text inside the dialog
    var headingText = ctx.innerText.find(function(t) { return t.length > 3 && t.length < 60; });
    return slugify(headingText || ctx.nodeName) || "dialog";
  }
  if (spec.role === "status") {
    return slugify(ctx.innerText[0] || ctx.nodeName) || "badge";
  }
  // For all others: prefer external (nearby but not inner) label text
  var innerSet = {};
  for (var i = 0; i < ctx.innerText.length; i++) innerSet[ctx.innerText[i]] = true;
  var ext = ctx.nearbyText.filter(function(t) { return !innerSet[t]; });
  if (ext.length > 0) return slugify(ext[0]) || slugify(spec.role);
  return slugify(ctx.nodeName) || slugify(spec.role) || "component";
}

function deriveAriaLabel(spec, ctx) {
  if (spec.role === "button") {
    // Use single inner text if there is exactly one meaningful text
    var text = ctx.innerText.find(function(t) { return t.trim().length > 0; });
    return text || null;
  }
  if (spec.role === "dialog") {
    var heading = ctx.innerText.find(function(t) { return t.length > 3 && t.length < 80; });
    return heading || null;
  }
  if (spec.role === "status") {
    return ctx.innerText[0] || null;
  }
  // External label (nearby text NOT inside the node bounding box)
  var innerSet = {};
  for (var i = 0; i < ctx.innerText.length; i++) innerSet[ctx.innerText[i]] = true;
  var ext = ctx.nearbyText.filter(function(t) { return !innerSet[t]; });
  return ext.length > 0 ? ext[0] : null;
}

function generateAskQuestions(spec) {
  if (spec.role === "button") {
    return [{
      id: "button-type",
      question: "Is this an action button or a navigation link?",
      options: ["Action button (role=button)", "Navigation link (role=link)"],
    }];
  }
  if (spec.isStarRating) {
    return [{
      id: "confirm-star-rating",
      question: "Confirm: these are selectable stars that form a rating widget?",
      options: ["Yes \u2014 star rating (role=radiogroup)", "No \u2014 decorative icons"],
    }];
  }
  if (spec.role === "radio-group") {
    return [{
      id: "radio-purpose",
      question: "What is the purpose of this selection group?",
      options: ["Single selection (radio group)", "Star rating", "Multiple selection (checkbox group)"],
    }];
  }
  if (spec.role === "textField") {
    return [{
      id: "field-type",
      question: "What type of input is this?",
      options: ["Text / email / tel / password", "Search field", "Textarea (multi-line)"],
    }];
  }
  if (spec.role === "checkbox") {
    return [{
      id: "checkbox-context",
      question: "How is this checkbox used?",
      options: ["Standalone (e.g. agree to terms)", "Part of a checkbox group (multi-select)"],
    }];
  }
  if (spec.role === "accordion") {
    return [{
      id: "accordion-multi",
      question: "Can multiple accordion panels be open at the same time?",
      options: ["Yes — allow multiple open", "No — only one open at a time"],
    }];
  }
  if (spec.role === "combobox") {
    return [{
      id: "combobox-type",
      question: "Does this dropdown allow free text input?",
      options: ["Select only (no typing)", "Combobox (typing + list)", "Autocomplete"],
    }];
  }
  if (spec.role === "dialog") {
    return [{
      id: "dialog-type",
      question: "Is this dialog for a destructive/irreversible action?",
      options: ["Standard dialog (role=dialog)", "Alert dialog for destructive action (role=alertdialog)"],
    }];
  }
  if (spec.role === "status") {
    return [{
      id: "badge-type",
      question: "What type of badge/chip is this?",
      options: ["Status indicator (role=status)", "Count badge (role=img, needs aria-label)", "Removable chip (role=group + remove button)"],
    }];
  }
  return undefined;
}

// ─── ARIA schema generation — technology-agnostic JSON for Dev Mode ──────────
// Returns a plain JSON object (as a string) with all ARIA attributes, states,
// WCAG criteria, and APG references. Developers apply this to any framework
// (React, Vue, Angular, plain HTML) — no HTML assumptions here.

function generateAriaSchema(spec, ariaLabel, identifier, ctx) {
  var label  = ariaLabel || identifier || spec.role;
  var schema = {};

  if (spec.role === "button") {
    schema = {
      "role": "button",
      "aria-label": label || null,
      "aria-pressed": null,
      "aria-disabled": false,
      "states": {
        "loading":  { "aria-busy": true,  "aria-label": "Loading…"      },
        "disabled": { "aria-disabled": true                               },
        "pressed":  { "aria-pressed": true                                },
      },
      "note": "Icon-only button: aria-label is required. Text button: aria-label may be omitted if text matches accessible name (WCAG 2.5.3).",
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/button/",
    };
  } else if (spec.isStarRating) {
    schema = {
      "role": "radiogroup",
      "aria-label": label,
      "options": [
        { "role": "radio", "aria-label": "1 star",  "value": 1 },
        { "role": "radio", "aria-label": "2 stars", "value": 2 },
        { "role": "radio", "aria-label": "3 stars", "value": 3 },
        { "role": "radio", "aria-label": "4 stars", "value": 4 },
        { "role": "radio", "aria-label": "5 stars", "value": 5 },
      ],
      "note": "Use fieldset + legend in HTML. Each star is a radio input with aria-label='N stars'.",
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
    };
  } else if (spec.role === "radio-group") {
    schema = {
      "role": "radiogroup",
      "aria-labelledby": "[group-label-id]",
      "options": {
        "role": "radio",
        "aria-checked": false,
      },
      "keyboard": "Arrow keys move between options. Space selects.",
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
    };
    if (label) schema["aria-label"] = label;
  } else if (spec.role === "textField") {
    schema = {
      "role":             "textbox",
      "aria-label":       label || "[external label text]",
      "aria-required":    true,
      "aria-invalid":     false,
      "aria-describedby": "[field-id]-error",
      "autocomplete":     "off",
      "states": {
        "error":    { "aria-invalid": true  },
        "disabled": { "aria-disabled": true },
      },
      "error-region": {
        "role":      "alert",
        "aria-live": "polite",
        "hidden":    true,
      },
      "note": "Label element is required — placeholder is NOT a label substitute (WCAG 3.3.2).",
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/",
    };
  } else if (spec.role === "checkbox") {
    schema = {
      "role":          "checkbox",
      "aria-checked":  false,
      "aria-label":    label || "[label text]",
      "states": {
        "checked":       { "aria-checked": true    },
        "indeterminate": { "aria-checked": "mixed" },
        "disabled":      { "aria-disabled": true   },
      },
      "group": {
        "role":             "group",
        "aria-labelledby":  "[group-label-id]",
      },
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/",
    };
  } else if (spec.role === "accordion") {
    schema = {
      "structure": "heading > button[aria-expanded][aria-controls] + div[role=region][aria-labelledby]",
      "trigger": {
        "role":          "button",
        "aria-expanded": false,
        "aria-controls": "[panel-id]",
      },
      "panel": {
        "role":            "region",
        "aria-labelledby": "[trigger-id]",
      },
      "chevron-icon": { "aria-hidden": true },
      "wcag": ["2.4.6", "4.1.2"],
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/",
    };
  } else if (spec.role === "combobox") {
    schema = {
      "role":             "combobox",
      "aria-expanded":    false,
      "aria-haspopup":    "listbox",
      "aria-labelledby":  "[label-id]",
      "aria-controls":    "[listbox-id]",
      "aria-autocomplete":"list",
      "listbox": {
        "role": "listbox",
      },
      "option": {
        "role":          "option",
        "aria-selected": false,
      },
      "chevron": { "aria-hidden": true },
      "states": {
        "open":     { "aria-expanded": true  },
        "disabled": { "aria-disabled": true  },
      },
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/",
    };
    if (label) schema["aria-label"] = label;
  } else if (spec.role === "dialog") {
    schema = {
      "role":              "dialog",
      "aria-modal":        true,
      "aria-labelledby":   "[heading-id-inside-dialog]",
      "aria-describedby":  "[description-id-inside-dialog]",
      "close-button": {
        "role":       "button",
        "aria-label": "Close dialog",
      },
      "backdrop":  { "aria-hidden": true },
      "alertdialog-note": "If this confirms a destructive action, use role=alertdialog instead.",
      "focus-management": "On open: focus first focusable element. On close: return focus to trigger.",
      "states": {
        "loading": { "aria-busy": true },
      },
      "wcag": spec.wcagRefs,
      "apg":  "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
    };
    if (label) schema["aria-label"] = label;
  } else if (spec.role === "status") {
    schema = {
      "variants": {
        "status-badge":   { "role": "status",  "note": "For live-region text like 'New' or 'Beta'" },
        "count-badge":    { "role": "img",     "aria-label": label + " notifications", "note": "Use role=img when the number is the content" },
        "removable-chip": {
          "role":        "group",
          "aria-label":  label,
          "remove-button": { "role": "button", "aria-label": "Remove " + label },
        },
      },
      "note": "Choose the variant that matches your usage. Status badge is a live region — use sparingly.",
      "wcag": spec.wcagRefs,
    };
  } else {
    schema = {
      "role":       spec.ariaRole,
      "aria-label": label,
      "wcag":       spec.wcagRefs,
    };
  }

  return JSON.stringify(schema, null, 2);
}

// ─── Framework code generator ─────────────────────────────────────────────────
// Translates ARIA schema JSON into framework-specific snippets (HTML / React / Vue).
// Technology-specific only as a developer aid — ARIA semantics stay canonical JSON.

function generateFrameworkCode(ariaSchemaStr, framework) {
  var schema;
  try { schema = JSON.parse(ariaSchemaStr); } catch (e) { return "// Invalid ARIA schema"; }

  const role  = schema.role  || schema["aria-role"] || "div";
  const label = schema["aria-label"] || schema.label || "";
  const attrs = [];

  // Collect all aria-* and role entries
  const SKIP = { role: true, wcag: true, apg: true, note: true, notes: true, states: true,
                 variants: true, options: true, items: true, label: true };
  for (var k in schema) {
    if (!schema.hasOwnProperty(k)) continue;
    if (SKIP[k]) continue;
    if (k === "aria-label" || k.startsWith("aria-")) {
      attrs.push({ name: k, value: String(schema[k]) });
    }
  }
  // Flatten states into sample
  if (schema.states) {
    for (var s in schema.states) {
      if (!schema.states.hasOwnProperty(s)) continue;
      var sv = schema.states[s];
      for (var sk in sv) {
        if (sv.hasOwnProperty(sk) && sk.startsWith("aria-")) {
          attrs.push({ name: sk, value: String(sv[sk]) + "  /* " + s + " state */" });
        }
      }
    }
  }

  if (framework === "html") {
    var htmlAttrs = attrs.map(function(a) { return '  ' + a.name + '="' + a.value + '"'; }).join('\n');
    var tag = role === "button" ? "button" : (role === "link" ? "a" : "div");
    if (role === "textbox" || role === "combobox") tag = "input";
    return (
      '<' + tag + '\n' +
      '  role="' + role + '"\n' +
      (label ? '  aria-label="' + label + '"\n' : '') +
      (htmlAttrs ? htmlAttrs + '\n' : '') +
      '>\n  <!-- content -->\n</' + tag + '>'
    );
  }

  if (framework === "react") {
    var jsxAttrs = attrs.map(function(a) {
      var name = a.name.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase(); });
      var val   = a.value.includes("/*") ? "{/* " + a.value.replace(/\/\*|\*\//g, "") + " */}" :
                  '"{' + a.value + '}"';
      return '  ' + name + '=' + '"' + a.value.replace(/\s*\/\*.*\*\//g, "") + '"';
    }).join('\n');
    var jsxTag = role === "button" ? "button" : (role === "link" ? "a" : "div");
    if (role === "textbox" || role === "combobox") jsxTag = "input";
    return (
      '<' + jsxTag + '\n' +
      '  role="' + role + '"\n' +
      (label ? '  aria-label="' + label + '"\n' : '') +
      (jsxAttrs ? jsxAttrs + '\n' : '') +
      '>\n  {/* content */}\n</' + jsxTag + '>'
    );
  }

  if (framework === "vue") {
    var vueAttrs = attrs.map(function(a) {
      return '  :' + a.name + '=\'"' + a.value.replace(/\s*\/\*.*\*\//g, "") + '"\'';
    }).join('\n');
    var vueTag = role === "button" ? "button" : (role === "link" ? "a" : "div");
    if (role === "textbox" || role === "combobox") vueTag = "input";
    return (
      '<' + vueTag + '\n' +
      '  role="' + role + '"\n' +
      (label ? '  :aria-label=\'"' + label + '"\'\n' : '') +
      (vueAttrs ? vueAttrs + '\n' : '') +
      '>\n  <!-- content -->\n</' + vueTag + '>'
    );
  }

  return "// Unknown framework: " + framework;
}

// generateSuggestions — builds rename + setPluginData suggestions for spec-matched components.
// Called from the handler after auditNode so issues can be stored alongside.

function generateSuggestions(node, spec, ctx, issues) {
  const suggestions = [];
  const identifier = deriveIdentifier(spec, ctx);
  const ariaLabel  = deriveAriaLabel(spec, ctx);

  // ── 1. Rename root: ComponentType_SemanticName (PascalCase, no ARIA in the name).
  // ARIA attributes live only in pluginData — not polluting the layer name.
  const newName = buildLayerName(spec, identifier, ctx.competitorRole || null);
  suggestions.push({
    type: "rename", nodeId: "__ROOT__", value: newName, label: "Rename layer (semantic PascalCase)",
  });

  // ── 2. Plugin data keys on root node
  const dataEntries = [
    { key: "a11y.v1.componentType", value: spec.role,              label: "Tag component type" },
    { key: "a11y.v1.ariaRole",      value: spec.ariaRole,          label: "Set ARIA role" },
    { key: "a11y.v1.wcagRef",       value: spec.wcagRefs.join(","), label: "Tag WCAG references" },
  ];

  const statesVal = spec.requiredStates.join(",");
  if (statesVal) {
    dataEntries.push({ key: "a11y.v1.states", value: statesVal, label: "Document required states" });
  }
  if (ariaLabel) {
    dataEntries.push({ key: "a11y.v1.ariaLabel", value: ariaLabel, label: "Set aria-label" });
  }
  if (issues && issues.length > 0) {
    const issuesSummary = JSON.stringify(issues.map(function(iss) {
      return { severity: iss.severity, code: iss.code, wcagRef: iss.wcagRef };
    }));
    dataEntries.push({ key: "a11y.v1.issues", value: issuesSummary, label: "Store audit issues" });
  }

  for (let i = 0; i < dataEntries.length; i++) {
    suggestions.push({
      type: "setPluginData",
      nodeId: "__ROOT__",
      key: dataEntries[i].key,
      value: dataEntries[i].value,
      label: dataEntries[i].label,
    });
  }

  // ── 3. ARIA schema — technology-agnostic JSON stored for Dev Mode inspector
  var ariaSchema = generateAriaSchema(spec, ariaLabel, identifier, ctx);
  suggestions.push({
    type: "setPluginData",
    nodeId: "__ROOT__",
    key: "a11y.v1.ariaSchema",
    value: ariaSchema,
    label: "Store ARIA schema (JSON)",
  });

  // ── 4. Star rating: rename each star child + aria-label
  if (spec.isStarRating && "children" in node) {
    var stars = node.children.filter(function(c) {
      var n = c.name.toLowerCase();
      return n.includes("star") || n.includes("rating") || n.includes("vector") || c.type === "VECTOR";
    });
    for (var si = 0; si < stars.length; si++) {
      var num = si + 1;
      var starLabel = num === 1 ? "1 star" : num + " stars";
      suggestions.push({
        type: "rename",
        nodeId: stars[si].id,
        value: "radio / star-" + num + " [aria-label=\"" + starLabel + "\"]",
        label: "Rename star " + num + " to ARIA convention",
      });
      suggestions.push({
        type: "setPluginData",
        nodeId: stars[si].id,
        key: "a11y.v1.ariaLabel",
        value: starLabel,
        label: "aria-label on star " + num,
      });
    }
  }

  return suggestions;
}

// ─── Component specs ──────────────────────────────────────────────────────────

const COMPONENT_SPECS = [
  {
    role: "button",
    ariaRole: "button",
    detect: {
      nameKeywords:       ["button", "btn", "cta"],
      variantKeywords:    ["button"],
      siblingPatterns:    [],
      nearbyTextKeywords: [],
      childPatterns:      [],
      childNamePrefix:    [],
      homogeneousChildren: false,
      actionTextKeywords: [
        "submit", "send", "save", "cancel", "confirm", "delete",
        "sign up", "log in", "sign in", "log out", "register",
        "continue", "next", "apply", "close", "done", "ok",
        "get started", "subscribe", "download", "upload", "share",
        "add", "create", "remove", "edit", "update", "search",
      ],
    },
    requiredStates: ["default", "hover", "focus", "disabled"],
    optionalStates: ["loading", "active"],
    isStarRating: false,
    audits: ["stateCoverage", "touchTarget", "focusRing", "textContrast", "iconOnlyLabel", "colorOnlyDisabled"],
    wcagRefs: ["1.4.3", "2.4.7", "2.5.3", "2.5.5"],
  },
  {
    role: "radio-group (star-rating)",
    ariaRole: "radiogroup",
    detect: {
      nameKeywords:       ["star", "rating"],
      variantKeywords:    [],
      siblingPatterns:    ["star", "rating"],
      nearbyTextKeywords: ["rate", "rating", "stars", "poor", "excellent", "overall", "experience"],
      childPatterns:      ["star", "rating"],
      childNamePrefix:    ["star", "rating"],
      homogeneousChildren: true,
    },
    requiredStates: [],
    optionalStates: [],
    isStarRating: true,
    audits: ["touchTarget", "hasGroupLabel", "eachRadioHasLabel", "starRatingAriaLabels"],
    wcagRefs: ["3.3.2", "4.1.2"],
  },
  {
    role: "radio-group",
    ariaRole: "radiogroup",
    detect: {
      nameKeywords:       ["radio"],
      variantKeywords:    [],
      siblingPatterns:    ["radio"],
      nearbyTextKeywords: ["select one", "choose one", "pick one"],
      childPatterns:      ["radio"],
      childNamePrefix:    ["radio"],
      homogeneousChildren: false,
    },
    requiredStates: [],
    optionalStates: [],
    isStarRating: false,
    audits: ["touchTarget", "hasGroupLabel", "eachRadioHasLabel"],
    wcagRefs: ["3.3.2", "4.1.2"],
  },
  // ── Phase C specs ────────────────────────────────────────────────────────────
  {
    role: "textField",
    ariaRole: "textbox",
    detect: {
      nameKeywords:        ["input", "textfield", "text-field", "text field", "search", "field"],
      variantKeywords:     ["input", "field"],
      siblingPatterns:     [],
      nearbyTextKeywords:  ["email", "password", "search", "name", "required"],
      childPatterns:       ["label", "field", "input", "placeholder", "error", "hint"],
      childNamePrefix:     ["label", "field", "input"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["empty", "filled", "focus", "error", "disabled"],
    optionalStates: ["read-only"],
    isStarRating: false,
    audits: ["stateCoverage", "touchTarget", "focusRing", "textContrast", "hasInputLabel", "hasErrorState"],
    wcagRefs: ["1.3.1", "1.3.5", "3.3.1", "3.3.2"],
  },
  {
    role: "checkbox",
    ariaRole: "checkbox",
    detect: {
      nameKeywords:        ["checkbox", "check-box", "check box"],
      variantKeywords:     ["checkbox"],
      siblingPatterns:     [],
      nearbyTextKeywords:  ["agree", "accept", "check all", "select all", "select all that apply"],
      childPatterns:       ["checkbox", "check", "indicator", "checkmark"],
      childNamePrefix:     ["checkbox", "check"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["unchecked", "checked", "focus", "disabled"],
    optionalStates: ["indeterminate"],
    isStarRating: false,
    audits: ["stateCoverage", "touchTarget", "focusRing", "textContrast", "hasInputLabel", "hasIndeterminate"],
    wcagRefs: ["1.3.1", "3.3.2", "4.1.2"],
  },
  {
    role: "accordion",
    ariaRole: "none",
    detect: {
      nameKeywords:        ["accordion", "faq", "expand", "collapse"],
      variantKeywords:     [],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["accordion-item", "accordion-header", "accordion-panel", "panel", "header", "question"],
      childNamePrefix:     ["accordion", "faq"],
      homogeneousChildren: true,
      actionTextKeywords:  [],
    },
    requiredStates: ["collapsed", "expanded"],
    optionalStates: [],
    isStarRating: false,
    audits: ["touchTarget", "focusRing", "textContrast", "hasHeadingStructure"],
    wcagRefs: ["2.4.6", "4.1.2"],
  },
  {
    role: "combobox",
    ariaRole: "combobox",
    detect: {
      nameKeywords:        ["select", "dropdown", "combobox", "combo"],
      variantKeywords:     ["select", "dropdown", "combobox"],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["option", "item", "listbox", "trigger", "chevron", "arrow"],
      childNamePrefix:     ["option", "item"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["closed", "open", "focused", "disabled"],
    optionalStates: [],
    isStarRating: false,
    audits: ["stateCoverage", "touchTarget", "focusRing", "textContrast", "hasInputLabel", "hasChevronIndicator"],
    wcagRefs: ["1.3.5", "3.3.2", "4.1.2"],
  },
  {
    role: "dialog",
    ariaRole: "dialog",
    detect: {
      nameKeywords:        ["modal", "dialog", "overlay", "drawer", "popup"],
      variantKeywords:     [],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["heading", "title", "close", "header", "footer", "backdrop"],
      childNamePrefix:     ["dialog", "modal"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["open", "closed"],
    optionalStates: ["loading"],
    isStarRating: false,
    audits: ["touchTarget", "textContrast", "hasDialogHeading", "hasCloseButton"],
    wcagRefs: ["2.1.2", "2.4.3", "2.4.6", "4.1.2"],
  },
  {
    role: "status",
    ariaRole: "status",
    detect: {
      nameKeywords:        ["badge", "chip", "tag"],
      variantKeywords:     ["badge", "chip", "tag"],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["remove", "close", "dismiss", "label"],
      childNamePrefix:     ["chip", "badge", "tag"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: [],
    optionalStates: [],
    isStarRating: false,
    audits: ["touchTarget", "textContrast", "removableChipCheck"],
    wcagRefs: ["1.3.3", "1.4.3", "4.1.2"],
  },
  {
    role: "tablist",
    ariaRole: "tablist",
    detect: {
      nameKeywords:        ["tab", "tablist", "tab-bar", "tabs"],
      variantKeywords:     ["tab"],
      siblingPatterns:     ["tab"],
      nearbyTextKeywords:  [],
      childPatterns:       ["tab", "panel", "tabpanel"],
      childNamePrefix:     ["tab"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["default", "selected"],
    optionalStates: [],
    isStarRating: false,
    audits: [],
    wcagRefs: ["4.1.2", "2.4.7"],
  },
  {
    role: "slider",
    ariaRole: "slider",
    detect: {
      nameKeywords:        ["slider", "range", "scrubber"],
      variantKeywords:     ["slider", "range"],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["thumb", "track", "handle", "fill"],
      childNamePrefix:     ["thumb", "track"],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["default", "focus", "disabled"],
    optionalStates: [],
    isStarRating: false,
    audits: [],
    wcagRefs: ["4.1.2", "2.5.5"],
  },
  {
    role: "toggle",
    ariaRole: "switch",
    detect: {
      nameKeywords:        ["toggle", "switch"],
      variantKeywords:     ["on", "off", "checked"],
      siblingPatterns:     [],
      nearbyTextKeywords:  [],
      childPatterns:       ["thumb", "track", "knob"],
      childNamePrefix:     [],
      homogeneousChildren: false,
      actionTextKeywords:  [],
    },
    requiredStates: ["unchecked", "checked", "focus", "disabled"],
    optionalStates: [],
    isStarRating: false,
    audits: [],
    wcagRefs: ["4.1.2", "2.5.5"],
  },
];

// ─── Score a spec against context ────────────────────────────────────────────
// Scoring weights:
//   name keyword match   → 3 pts (single keyword guarantees HIGH threshold)
//   parent name match    → 1 pt
//   sibling pattern ≥2   → 2 pts
//   variant keyword      → 1 pt
//   nearby text keyword  → 1 pt

function scoreAccordionSignals(ctx, node) {
  const reasons = [];

  if (ctx.accordionLayoutBlocked) {
    return { bonus: 0, reasons: ["accordion blocked: " + ctx.rootLayoutMode + (ctx.rootLayoutWrap ? " WRAP" : "")] };
  }
  if (ctx.accordionMultiSelectCopy) {
    return { bonus: 0, reasons: ["accordion cancelled: multi-select / checkbox-group copy"] };
  }

  const avgW = averageDirectChildWidth(node);
  if (avgW > 0 && avgW < 200) {
    return { bonus: 0, reasons: ["accordion blocked: avg child width " + Math.round(avgW) + "px < 200px"] };
  }

  if (!ctx.accordionVerticalOk) {
    return { bonus: 0, reasons: ["accordion blocked: layout not vertical stack"] };
  }

  const rowsWithChevron = getAccordionRowsWithChevron(node);
  console.log("[accordion] rowsWithChevron:", rowsWithChevron.length,
    "names:", rowsWithChevron.map(function(r) { return r.name; }));

  if (rowsWithChevron.length >= 2) {
    return {
      bonus: 8,
      reasons: [rowsWithChevron.length + " compound rows (text+chevron in subtree, vertical)"],
    };
  }

  if (
    ctx.hasChevrons &&
    ctx.repeatingPatterns &&
    ctx.repeatingPatterns.length >= 2
  ) {
    return {
      bonus: 8,
      reasons: ["chevron + " + ctx.repeatingPatterns.length + " repeating patterns (vertical)"],
    };
  }

  return { bonus: 0, reasons: ["no compound accordion match (chevron alone is insufficient)"] };
}

function scoreSpec(spec, ctx, node) {
  let count = 0;
  const reasons = [];
  const nameLower    = ctx.nodeName.toLowerCase();
  const parentLower  = ctx.parentName.toLowerCase();
  const variantStr   = Object.values(ctx.variantProps).join(" ").toLowerCase();
  const nearbyAll    = ctx.nearbyText.concat(ctx.innerText).join(" ").toLowerCase();
  const detect       = spec.detect;

  if (detect.nameKeywords) {
    for (let i = 0; i < detect.nameKeywords.length; i++) {
      if (nameLower.includes(detect.nameKeywords[i])) {
        count += 3;
        reasons.push("name '" + detect.nameKeywords[i] + "'");
        break;
      }
    }
    for (let i = 0; i < detect.nameKeywords.length; i++) {
      if (parentLower.includes(detect.nameKeywords[i])) {
        count += 1;
        reasons.push("parent '" + detect.nameKeywords[i] + "'");
        break;
      }
    }
  }

  if (detect.siblingPatterns && ctx.siblings.length >= 2) {
    for (let i = 0; i < detect.siblingPatterns.length; i++) {
      const pat = detect.siblingPatterns[i];
      let hits = 0;
      for (let j = 0; j < ctx.siblings.length; j++) {
        if (ctx.siblings[j].name.toLowerCase().includes(pat)) hits++;
      }
      if (hits >= 2) {
        count += 2;
        reasons.push(hits + " siblings match '" + pat + "'");
        break;
      }
    }
  }

  if (detect.variantKeywords) {
    for (let i = 0; i < detect.variantKeywords.length; i++) {
      if (variantStr.includes(detect.variantKeywords[i])) {
        count += 1;
        reasons.push("variant '" + detect.variantKeywords[i] + "'");
        break;
      }
    }
  }

  // Nearby/inner text keywords: 1 pt each, count ALL matches (cap 3)
  if (detect.nearbyTextKeywords) {
    let nearbyCount = 0;
    for (let i = 0; i < detect.nearbyTextKeywords.length; i++) {
      if (nearbyAll.includes(detect.nearbyTextKeywords[i])) {
        nearbyCount++;
        reasons.push("text '" + detect.nearbyTextKeywords[i] + "'");
        if (nearbyCount >= 3) break;
      }
    }
    count += nearbyCount;
  }

  // Children patterns: 2 pts — depth-1 children + deep scan (depth 3)
  if (detect.childPatterns) {
    const nameList = [];
    if (ctx.childNames) {
      for (let ci = 0; ci < ctx.childNames.length; ci++) nameList.push(ctx.childNames[ci].name);
    }
    if (ctx.allChildNames) {
      for (let ai = 0; ai < ctx.allChildNames.length; ai++) nameList.push(ctx.allChildNames[ai]);
    }
    if (nameList.length >= 2) {
      for (let i = 0; i < detect.childPatterns.length; i++) {
        const pat = detect.childPatterns[i];
        if (pat === "item") continue;
        let hits = 0;
        for (let j = 0; j < nameList.length; j++) {
          if (layerNameMatchesPattern(nameList[j], pat)) hits++;
        }
        if (hits >= 2) {
          count += 2;
          reasons.push(hits + " layers match '" + pat + "' (deep scan)");
          break;
        }
      }
    }
  }

  // Accordion: compound co-located rows only (+8 or 0)
  if (spec.role === "accordion" && node) {
    const acc = scoreAccordionSignals(ctx, node);
    count += acc.bonus;
    for (let ri = 0; ri < acc.reasons.length; ri++) reasons.push(acc.reasons[ri]);
  }

  // Tablist: tall stacked rows are usually accordion, not horizontal tabs
  if (spec.role === "tablist" && node) {
    const avgRowH = averageDirectChildHeight(node);
    if (avgRowH > 48) {
      count = Math.max(0, count - 4);
      reasons.push("tablist penalty: avg row height " + Math.round(avgRowH) + "px > 48");
    }
  }

  // Checkbox group: repeating rows + multi-select instructional copy
  if (spec.role === "checkbox") {
    if (
      (nearbyAll.indexOf("select all that apply") >= 0 || nearbyAll.indexOf("select all") >= 0) &&
      ctx.repeatingPatterns && ctx.repeatingPatterns.length >= 1
    ) {
      count += 4;
      reasons.push("multi-select checkbox group (repeating items + select-all copy)");
    }
  }

  // Homogeneous children: 1 pt when 3+ children share the same node type
  if (detect.homogeneousChildren && ctx.childCount >= 3) {
    if (ctx.allChildrenSameType) {
      count += 1;
      const t = ctx.childNames.length > 0 ? ctx.childNames[0].type : "node";
      reasons.push(ctx.childCount + " homogeneous " + t + " children");
    }
  }

  // Shared child-name prefix: 1 pt when 3+ children share a prefix that matches spec keywords
  // e.g. children "tab-home", "tab-settings", "tab-profile" → prefix "tab"
  // Covers tab-bar, button-group, breadcrumb, star-rating built from named copies
  if (detect.childNamePrefix && ctx.childCount >= 3 && ctx.childNamePrefix) {
    for (let i = 0; i < detect.childNamePrefix.length; i++) {
      if (ctx.childNamePrefix.includes(detect.childNamePrefix[i])) {
        count += 2;
        reasons.push("child prefix \"" + ctx.childNamePrefix + "\" matches \"" + detect.childNamePrefix[i] + "\"");
        break;
      }
    }
  }

  // Action text: single short inner text containing an action verb = 3 pts (button)
  if (detect.actionTextKeywords && ctx.innerText.length === 1) {
    const singleText = ctx.innerText[0].toLowerCase();
    if (singleText.length <= 40) {
      for (let i = 0; i < detect.actionTextKeywords.length; i++) {
        if (singleText.includes(detect.actionTextKeywords[i])) {
          count += 3;
          reasons.push("action text '" + ctx.innerText[0] + "'");
          break;
        }
      }
    }
  }

  return { count: count, reasons: reasons };
}

// ─── Rule engine (fallback for non-spec components) ───────────────────────────

function runRuleEngine(ctx) {
  const allText = [
    ...ctx.nearbyText,
    ...ctx.innerText,
    ctx.parentName,
    ctx.grandparentName,
    ctx.nodeName,
  ].join(" ").toLowerCase();

  const name       = ctx.nodeName.toLowerCase();
  const parentName = ctx.parentName.toLowerCase();
  const variants   = Object.values(ctx.variantProps).join(" ").toLowerCase();

  // ── BUTTON ──
  if (name.includes("button") || name.includes("btn") || name.includes("cta") || variants.includes("button")) {
    return {
      role: "button", confidence: "HIGH",
      reasoning: "Name contains button/btn/cta keyword.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "button / " + name, label: "Rename to ARIA layer convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "button",            label: "Tag as button" },
      ],
    };
  }

  // ── RADIO GROUP / STAR RATING ──
  const radioSignals = [
    name.includes("radio"),
    parentName.includes("radio"),
    allText.includes("select one"),
    allText.includes("choose one"),
    allText.includes("pick one"),
    ctx.siblingCount >= 2 && ctx.siblings.every((s) => s.name.toLowerCase().includes("radio")),
    name.includes("star") || name.includes("rating"),
    parentName.includes("star") || parentName.includes("rating"),
    ctx.siblings.length >= 3 && ctx.siblings.every((s) => s.name.toLowerCase().includes("star")),
  ];
  const radioScore = radioSignals.filter(Boolean).length;

  if (radioScore >= 2) {
    const isStar =
      name.includes("star") || name.includes("rating") ||
      parentName.includes("star") || parentName.includes("rating") ||
      (ctx.siblings.length > 0 && ctx.siblings.every((s) => s.name.toLowerCase().includes("star")));

    const confidence = radioScore >= 3 ? "HIGH" : "MED";
    return {
      role: isStar ? "radio-group (star-rating)" : "radio-group",
      confidence,
      reasoning: radioScore + " radio signals detected." + (isStar ? " Star pattern confirms rating component." : ""),
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__",          value: isStar ? "rating-selection" : "radio-group / selection", label: "Rename root" },
        { type: "setPluginData", nodeId: "__ROOT__",          value: isStar ? "radio-group (star-rating)" : "radio-group",    label: "Tag component type" },
        { type: "rename",        nodeId: "__STAR_CHILDREN__", value: "rating-star", label: "Rename each star child → rating-star" },
      ],
      askQuestions: confidence === "MED" ? [
        { id: "radio-purpose", question: "Can this selection group be used for rating?", options: ["yes", "no", "it selects an option (not a rating)"] }
      ] : undefined,
    };
  }

  // ── CHECKBOX ──
  if (name.includes("checkbox") || name.includes("check box") || allText.includes("agree") || allText.includes("check all") || variants.includes("checkbox")) {
    return {
      role: "checkbox", confidence: "HIGH",
      reasoning: "Checkbox keyword or agree/check-all label detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "checkbox / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "checkbox",            label: "Tag as checkbox" },
      ],
    };
  }

  // ── SWITCH ──
  if (name.includes("switch") || name.includes("toggle") || (variants.includes("on") && variants.includes("off"))) {
    return {
      role: "switch", confidence: "HIGH",
      reasoning: "Switch/toggle keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "switch / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "switch",            label: "Tag as switch" },
      ],
    };
  }

  // ── ACCORDION ──
  if (name.includes("accordion") || name.includes("expand") || name.includes("collapse")) {
    return {
      role: "accordion", confidence: "HIGH",
      reasoning: "Accordion/expand/collapse keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "accordion / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "accordion",            label: "Tag as accordion" },
      ],
    };
  }

  // ── TABS ──
  if (name.includes("tab") || (ctx.siblingCount >= 2 && ctx.siblings.every((s) => s.name.toLowerCase().includes("tab")))) {
    return {
      role: "tablist", confidence: "HIGH",
      reasoning: "Tab keyword or sibling tabs detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "tablist / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "tablist",            label: "Tag as tablist" },
      ],
    };
  }

  // ── TEXT INPUT ──
  if (name.includes("input") || name.includes("text field") || name.includes("textfield") || name.includes("search") || variants.includes("input")) {
    return {
      role: "textField", confidence: "HIGH",
      reasoning: "Input/textfield keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "input / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "textField",        label: "Tag as textField" },
      ],
    };
  }

  // ── SLIDER ──
  if (name.includes("slider") || name.includes("range")) {
    return {
      role: "slider", confidence: "HIGH",
      reasoning: "Slider/range keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "slider / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "slider",            label: "Tag as slider" },
      ],
    };
  }

  // ── COMBOBOX / SELECT ──
  if (name.includes("select") || name.includes("dropdown") || name.includes("combobox") || name.includes("combo")) {
    return {
      role: "combobox", confidence: "HIGH",
      reasoning: "Select/dropdown/combobox keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "combobox / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "combobox",            label: "Tag as combobox" },
      ],
    };
  }

  // ── MODAL / DIALOG ──
  if (name.includes("modal") || name.includes("dialog") || name.includes("overlay")) {
    return {
      role: "dialog", confidence: "HIGH",
      reasoning: "Modal/dialog/overlay keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "dialog / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "dialog",            label: "Tag as dialog" },
      ],
    };
  }

  // ── NAVIGATION ──
  if (name.includes("nav") || name.includes("navbar") || name.includes("breadcrumb")) {
    return {
      role: "navigation", confidence: "HIGH",
      reasoning: "Navigation keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "nav / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "navigation",     label: "Tag as navigation" },
      ],
    };
  }

  // ── CHIP / BADGE ──
  if (name.includes("chip") || name.includes("badge") || name.includes("tag")) {
    return {
      role: "status", confidence: "HIGH",
      reasoning: "Chip/badge/tag keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "badge / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "status",           label: "Tag as status" },
      ],
    };
  }

  // ── TOOLTIP ──
  if (name.includes("tooltip")) {
    return {
      role: "tooltip", confidence: "HIGH",
      reasoning: "Tooltip keyword detected.",
      suggestions: [
        { type: "rename",        nodeId: "__ROOT__", value: "tooltip / " + name, label: "Rename to ARIA convention" },
        { type: "setPluginData", nodeId: "__ROOT__", value: "tooltip",            label: "Tag as tooltip" },
      ],
    };
  }

  return {
    role: "unknown", confidence: "LOW",
    reasoning: "No deterministic match. Sending to AI for classification.",
    suggestions: [],
  };
}

// ─── Detect component: spec-based, falls back to rule engine ─────────────────
// Threshold: count >= 3 → HIGH, count 2 → MED (both use spec path).
// count < 2 → rule engine fallback (spec attached for audit if count === 1).

function detectComponent(ctx, node) {
  const ranked = [];

  for (let i = 0; i < COMPONENT_SPECS.length; i++) {
    const spec    = COMPONENT_SPECS[i];
    const signals = scoreSpec(spec, ctx, node);
    if (signals.count > 0) {
      ranked.push({ spec: spec, count: signals.count, reasons: signals.reasons });
    }
  }

  ranked.sort(function(a, b) { return b.count - a.count; });

  const best   = ranked.length > 0 ? ranked[0] : null;
  const second = ranked.length > 1 ? ranked[1] : null;
  const margin = best && second ? best.count - second.count : (best ? 99 : 0);
  const needsVisionTiebreak =
    !!(best && second && best.count >= 2 && second.count >= 2 && margin < 3);

  if (best && best.count >= 2) {
    const confidence = best.count >= 3 ? "HIGH" : "MED";
    const reasoning =
      best.reasons.join("; ") +
      (second ? " (won vs " + second.spec.role + " " + best.count + ":" + second.count + ")" : "");
    return {
      role:               best.spec.role,
      spec:               best.spec,
      confidence:         confidence,
      reasoning:          reasoning,
      suggestions:        [],
      askQuestions:       confidence === "MED" ? generateAskQuestions(best.spec) : undefined,
      issues:             [],
      signalDetails:      best.reasons,
      signalScore:        best.count,
      detectionPath:      "spec-engine",
      needsVisionTiebreak: needsVisionTiebreak,
      competitorRole:     second ? second.spec.role : null,
      rankedScores:       ranked.slice(0, 4).map(function(r) {
        return { role: r.spec.role, score: r.count };
      }),
    };
  }

  const ruleResult = runRuleEngine(ctx);
  const weakSpec   = best && best.count >= 1 ? best.spec : null;
  return Object.assign({
    spec:               weakSpec,
    signalDetails:      best ? best.reasons : [],
    signalScore:        best ? best.count : 0,
    detectionPath:      "rule-engine",
    needsVisionTiebreak: false,
    rankedScores:       ranked.slice(0, 4).map(function(r) {
      return { role: r.spec.role, score: r.count };
    }),
  }, ruleResult);
}

// ─── Audit functions ──────────────────────────────────────────────────────────

// STATE_ALIASES maps a canonical required-state name to every equivalent
// name designers use in the real world. Case-insensitive matching.
const STATE_ALIASES = {
  "default":     ["default", "rest", "normal", "base", "idle", "enabled"],
  "hover":       ["hover", "hovered", "mouseover", "mouse-over"],
  "focus":       ["focus", "focused", "focus-visible", "keyboard"],
  "active":      ["active", "pressed", "clicking", "down"],
  "disabled":    ["disabled", "inactive", "unavailable", "dimmed"],
  "loading":     ["loading", "busy", "spinner", "pending"],
  "error":       ["error", "invalid", "danger", "warning"],
  "filled":      ["filled", "active", "has-value", "typed", "input"],
  "empty":       ["empty", "placeholder", "blank", "unfilled"],
  "checked":     ["checked", "selected", "on", "true", "active"],
  "unchecked":   ["unchecked", "deselected", "off", "false"],
  "indeterminate":["indeterminate", "mixed", "partial"],
  "expanded":    ["expanded", "open", "opened", "shown"],
  "collapsed":   ["collapsed", "closed", "hidden"],
  "open":        ["open", "expanded", "shown", "opened"],
  "closed":      ["closed", "collapsed", "hidden"],
};

function stateIsPresent(required, foundStates) {
  const reqLower = required.toLowerCase();
  // Direct substring match first (fast path)
  if (foundStates.some(function(s) { return s.toLowerCase().includes(reqLower); })) return true;
  // Alias match
  const aliases = STATE_ALIASES[reqLower] || [];
  for (let a = 0; a < aliases.length; a++) {
    if (foundStates.some(function(s) { return s.toLowerCase().includes(aliases[a]); })) return true;
  }
  return false;
}

function auditStateCoverage(node, spec, ctx) {
  const issues   = [];
  const stateMap = findStateVariants(node, ctx);
  const found    = Object.keys(stateMap);

  for (let i = 0; i < spec.requiredStates.length; i++) {
    const required = spec.requiredStates[i];
    if (stateIsPresent(required, found)) continue;
    if (required === "focus" && componentHasFocusVariants(node, ctx)) continue;
    if ((required === "checked" || required === "unchecked") && componentHasCheckedOrStateVariants(node, ctx)) continue;
    if ((required === "open" || required === "closed" || required === "expanded") && componentHasExpandedVariants(node, ctx)) continue;

    const isCritical = required === "focus" || required === "default";
    const severity   = isCritical ? "HIGH" : "MED";
    const wcag       = required === "focus" ? "2.4.7" : "4.1.2";
    issues.push(makeIssue(severity,
      "MISSING_STATE_" + required.toUpperCase().replace(/[-\s]/g, "_"),
      wcag,
      "Missing '" + required + "' state variant — found: [" + (found.length ? found.join(", ") : "none") + "]",
      node.id));
  }
  return issues;
}

function auditTouchTarget(node, spec, ctx) {
  const issues = [];

  // Resolve the node to measure:
  // - COMPONENT_SET → measure its default variant (individual size, not the full set bounds)
  // - COMPONENT / INSTANCE / FRAME / GROUP → measure directly
  let target = node;
  if (node.type === "COMPONENT_SET" && node.children && node.children.length > 0) {
    const stateMap = findStateVariants(node, ctx);
    target = stateMap["default"] || stateMap["rest"] || node.children[0];
  }

  // absoluteBoundingBox is null for nodes inside collapsed components or not yet rendered
  const box = target.absoluteBoundingBox;
  if (!box) return issues;

  const w   = box.width;
  const h   = box.height;
  const min = Math.min(w, h);
  const wR  = Math.round(w);
  const hR  = Math.round(h);

  if (min < 24) {
    // WCAG 2.5.8 (AA, WCAG 2.2): absolute minimum 24×24px with no exceptions
    issues.push(makeIssue("HIGH", "TOUCH_TARGET_CRITICAL", "2.5.8",
      "Touch target " + wR + "\xD7" + hR + "px \u2014 below 24px absolute minimum (WCAG 2.5.8). Must resize.",
      target.id));
  } else if (min < 44) {
    // WCAG 2.5.5 (AAA) recommends 44×44. Between 24–44 is allowed if offset spacing compensates.
    const spacing = Math.ceil((44 - min) / 2);
    issues.push(makeIssue("MED", "TOUCH_TARGET_SMALL", "2.5.5",
      "Touch target " + wR + "\xD7" + hR + "px \u2014 below 44px recommended. " +
      "If keeping this size, add \u2265" + spacing + "px spacing on each side (WCAG 2.5.5).",
      target.id));
  }
  return issues;
}

function auditFocusRing(node, spec, ctx) {
  const issues    = [];
  const stateMap  = findStateVariants(node, ctx);
  const focusNode = stateMap["focus"];

  // No focus variant → handled by stateCoverage; don't double-report
  if (!focusNode) return issues;

  let hasIndicator = false;
  let ringColor    = null; // { r, g, b } if we can extract it

  // ── Check strokes on the focus variant node itself
  if (focusNode.strokes && focusNode.strokes.length > 0) {
    for (let i = 0; i < focusNode.strokes.length; i++) {
      const s = focusNode.strokes[i];
      if (s.visible === false) continue;
      hasIndicator = true;
      if (s.type === "SOLID" && s.color) {
        const c = s.color;
        ringColor = { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
      }
      break;
    }
  }

  // ── Check effects (drop-shadow / inner-shadow used as focus ring)
  if (!hasIndicator && focusNode.effects) {
    for (let i = 0; i < focusNode.effects.length; i++) {
      const e = focusNode.effects[i];
      if (e.visible === false) continue;
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        hasIndicator = true;
        if (e.color) {
          ringColor = { r: Math.round(e.color.r * 255), g: Math.round(e.color.g * 255), b: Math.round(e.color.b * 255) };
        }
        break;
      }
    }
  }

  // ── Check descendants (the ring may live on a child layer)
  if (!hasIndicator && "findAll" in focusNode) {
    const withIndicator = focusNode.findAll((n) =>
      (n.strokes && n.strokes.some((s) => s.visible !== false)) ||
      (n.effects && n.effects.some((e) => e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")))
    );
    if (withIndicator.length > 0) {
      hasIndicator = true;
      // Try to extract color from the first matching descendant
      const n = withIndicator[0];
      if (n.strokes && n.strokes.length > 0) {
        const s = n.strokes.find((s) => s.visible !== false && s.type === "SOLID");
        if (s && s.color) {
          const c = s.color;
          ringColor = { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
        }
      }
    }
  }

  if (!hasIndicator) {
    issues.push(makeIssue("HIGH", "MISSING_FOCUS_RING", "2.4.7",
      "Focus state variant has no visible stroke or shadow effect — focus ring is required (WCAG 2.4.7)",
      focusNode.id));
    return issues; // contrast is irrelevant if no ring exists
  }

  // ── WCAG 1.4.11: focus ring must have ≥ 3:1 contrast against adjacent background
  if (ringColor) {
    const bg       = getEffectiveBackground(focusNode);
    const ringLum  = relativeLuminance(ringColor.r, ringColor.g, ringColor.b);
    const bgLum    = relativeLuminance(bg.r, bg.g, bg.b);
    const ratio    = contrastRatio(ringLum, bgLum);
    if (ratio < 3.0) {
      issues.push(makeIssue("HIGH", "FOCUS_RING_CONTRAST_FAIL", "1.4.11",
        "Focus ring contrast " + ratio.toFixed(2) + ":1 — needs \u22653:1 against adjacent background (WCAG 1.4.11)",
        focusNode.id));
    }
  } else {
    // Ring exists but color is a gradient or inherited — cannot compute automatically
    issues.push(makeIssue("MANUAL", "FOCUS_RING_CONTRAST_UNKNOWN", "1.4.11",
      "Verify focus ring contrast \u22653:1 against adjacent background — could not compute automatically (WCAG 1.4.11)",
      focusNode.id));
  }

  return issues;
}

function auditTextContrast(node, spec, ctx) {
  const issues = [];

  // For COMPONENT_SET scan the default variant only — scanning all variants would
  // report the same text N times. We also scan "error" if it exists (text may differ).
  const nodesToScan = [];
  if (node.type === "COMPONENT_SET" && node.children && node.children.length > 0) {
    const stateMap = findStateVariants(node, ctx);
    const defaultNode = stateMap["default"] || stateMap["rest"] || node.children[0];
    nodesToScan.push(defaultNode);
    // Also scan error state — error messages are often low-contrast red text
    if (stateMap["error"] && stateMap["error"] !== defaultNode) nodesToScan.push(stateMap["error"]);
  } else {
    nodesToScan.push(node);
  }

  // seen: keyed by fill color + chars to avoid exact duplicate reports across states
  const seen = {};

  for (let ni = 0; ni < nodesToScan.length; ni++) {
    const checkNode = nodesToScan[ni];
    if (!checkNode || !("findAllWithCriteria" in checkNode)) continue;

    // findAllWithCriteria is faster than findAll for type-filtered searches (rule: performance first)
    const textNodes = checkNode.findAllWithCriteria({ types: ["TEXT"] });

    for (let i = 0; i < textNodes.length; i++) {
      const tn    = textNodes[i];
      if (!isNodeVisible(tn)) continue;
      const chars = (tn.characters || "").trim();
      if (!chars) continue;

      // Use getNodeComposedFill to get the text color WITH its alpha
      // (composites multiple stacked fills + fill.opacity + node.opacity).
      const rawFill = getNodeComposedFill(tn); // { r,g,b,a } 0-1
      if (!rawFill || rawFill.a < 0.01) continue;

      // Deduplicate by text content + fill color + alpha so that two layers
      // with the same characters but different fills are both checked.
      const seenKey = chars.slice(0, 40) + ":" +
        rawFill.r.toFixed(3) + "," + rawFill.g.toFixed(3) + "," +
        rawFill.b.toFixed(3) + "," + rawFill.a.toFixed(2);
      if (seen[seenKey]) continue;
      seen[seenKey] = true;

      // Resolve the perceived background (composites ancestor chain).
      const bg    = getEffectiveBackground(tn); // { r,g,b } 0-255
      const bgR01 = bg.r / 255;
      const bgG01 = bg.g / 255;
      const bgB01 = bg.b / 255;

      // If the text fill is semi-transparent, the perceived text color is the
      // alpha-blend of the fill over the background — NOT the raw fill color.
      let perceivedR, perceivedG, perceivedB;
      if (rawFill.a >= 0.995) {
        perceivedR = rawFill.r; perceivedG = rawFill.g; perceivedB = rawFill.b;
      } else {
        const a = rawFill.a, inv = 1 - a;
        perceivedR = rawFill.r * a + bgR01 * inv;
        perceivedG = rawFill.g * a + bgG01 * inv;
        perceivedB = rawFill.b * a + bgB01 * inv;
      }

      const textLum  = relativeLuminance(
        Math.round(perceivedR * 255),
        Math.round(perceivedG * 255),
        Math.round(perceivedB * 255));
      const bgLum    = relativeLuminance(bg.r, bg.g, bg.b);
      const ratio    = contrastRatio(textLum, bgLum);
      const large    = isLargeText(tn);
      const required = large ? 3.0 : 4.5;

      if (ratio < required) {
        const alphaNote = rawFill.a < 0.995 ? " (text has opacity " + (rawFill.a * 100).toFixed(0) + "%)" : "";
        issues.push(makeIssue("HIGH", "CONTRAST_TEXT_FAIL", "1.4.3",
          "\u201c" + chars.slice(0, 24) + "\u201d contrast " + ratio.toFixed(2) + ":1 \u2014 needs \u2265" + required + ":1 " +
          (large ? "(large text)" : "(normal text)") + alphaNote + " (WCAG 1.4.3)",
          tn.id));
      }
    }
  }
  return issues;
}

function auditIconOnlyLabel(node, spec) {
  const issues = [];
  if (spec.role !== "button") return issues;

  let hasText = false;
  if ("findAllWithCriteria" in node) {
    const textNodes = node.findAllWithCriteria({ types: ["TEXT"] });
    for (let i = 0; i < textNodes.length; i++) {
      if ((textNodes[i].characters || "").trim()) { hasText = true; break; }
    }
  }

  if (!hasText) {
    const existingLabel = node.getPluginData ? node.getPluginData("a11y.ariaLabel") : "";
    if (!existingLabel) {
      issues.push(makeIssue("HIGH", "ICON_BUTTON_NO_LABEL", "4.1.2",
        "Icon-only button has no visible text and no aria-label annotation",
        node.id));
    }
  }
  return issues;
}

function auditColorOnlyDisabled(node, spec, ctx) {
  const issues   = [];
  const stateMap = findStateVariants(node, ctx);
  const disabled = stateMap["disabled"];
  const defNode  = stateMap["default"];

  if (!disabled || !defNode) return issues;

  const defOpacity  = defNode.opacity  !== undefined ? defNode.opacity  : 1;
  const disOpacity  = disabled.opacity !== undefined ? disabled.opacity : 1;
  const opacityDiff = Math.abs(defOpacity - disOpacity) > 0.05;

  const defStrokes  = defNode.strokes  ? defNode.strokes.length  : 0;
  const disStrokes  = disabled.strokes ? disabled.strokes.length : 0;
  const strokesDiff = defStrokes !== disStrokes;

  if (!opacityDiff && !strokesDiff) {
    if (getSharedA11y(node, "state-indicator")) return issues;
    issues.push(makeIssue("MED", "COLOR_ONLY_DISABLED", "1.4.1",
      "Disabled state may differ from default only by color — verify a non-color indicator exists",
      disabled.id));
  }
  return issues;
}

function auditHasGroupLabel(node, spec, ctx) {
  const issues = [];
  // External labels = nearby text NOT also found as inner text
  const innerSet = {};
  for (let i = 0; i < ctx.innerText.length; i++) innerSet[ctx.innerText[i]] = true;
  const externalLabels = ctx.nearbyText.filter((t) => !innerSet[t]);

  if (externalLabels.length === 0) {
    issues.push(makeIssue("HIGH", "NO_GROUP_LABEL", "3.3.2",
      "No external label found near " + spec.role + " (group needs visible label via aria-labelledby)",
      node.id));
  }
  return issues;
}

function auditEachRadioHasLabel(node) {
  const issues = [];
  if (!("children" in node)) return issues;
  const children = node.children;
  if (children.length <= 1) return issues;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "TEXT") continue; // group-level text = the label itself

    let hasText = false;
    if ("findAllWithCriteria" in child) {
      const textNodes = child.findAllWithCriteria({ types: ["TEXT"] });
      for (let j = 0; j < textNodes.length; j++) {
        if ((textNodes[j].characters || "").trim()) { hasText = true; break; }
      }
    }

    const hasAriaLabel = child.getPluginData ? child.getPluginData("a11y.ariaLabel") : "";
    const sharedLabel = getSharedA11y(child, "ariaLabel");
    if (!hasText && !hasAriaLabel && !sharedLabel) {
      issues.push(makeIssue("HIGH", "RADIO_NO_LABEL", "4.1.2",
        "Radio item \"" + child.name + "\" has no visible label or aria-label annotation",
        child.id));
    }
  }
  return issues;
}

function auditStarRatingAriaLabels(node, spec) {
  const issues = [];
  if (!spec.isStarRating) return issues;
  if (!("children" in node)) return issues;

  const stars = node.children.filter((c) => {
    const n = c.name.toLowerCase();
    return n.includes("star") || n.includes("rating") || n.includes("vector") ||
           n.includes("icon") || c.type === "VECTOR";
  });
  if (stars.length === 0) return issues;

  for (let i = 0; i < stars.length; i++) {
    const child = stars[i];
    const label = child.getPluginData ? child.getPluginData("a11y.ariaLabel") : "";
    const sharedLabel = getSharedA11y(child, "ariaLabel");
    if (!label && !sharedLabel) {
      const expected = (i + 1) === 1 ? "1 star" : (i + 1) + " stars";
      issues.push(makeIssue("MED", "STAR_MISSING_ARIA_LABEL", "4.1.2",
        "\"" + child.name + "\" needs aria-label plugin data (e.g. \"" + expected + "\")",
        child.id));
    }
  }
  return issues;
}

// ─── Phase C audit functions ──────────────────────────────────────────────────

function auditHasInputLabel(node, spec, ctx) {
  var issues = [];
  // External label = text that is spatially near but NOT inside the node
  var innerSet = {};
  for (var i = 0; i < ctx.innerText.length; i++) innerSet[ctx.innerText[i]] = true;
  var externalLabels = ctx.nearbyText.filter(function(t) { return !innerSet[t]; });

  // Also check for a child layer whose name contains "label"
  var hasLabelChild = false;
  if ("children" in node) {
    for (var j = 0; j < node.children.length; j++) {
      if (node.children[j].name.toLowerCase().includes("label")) { hasLabelChild = true; break; }
    }
  }

  if (externalLabels.length === 0 && !hasLabelChild) {
    issues.push(makeIssue("HIGH", "NO_INPUT_LABEL", "3.3.2",
      "No label found for this input — placeholder text is NOT a sufficient label (WCAG 3.3.2)",
      node.id));
  }
  return issues;
}

function auditHasErrorState(node, spec, ctx) {
  var issues = [];
  var stateMap = findStateVariants(node, ctx);
  if (!stateMap["error"]) {
    issues.push(makeIssue("HIGH", "NO_ERROR_STATE", "3.3.1",
      "No 'error' state variant found — inputs must have a visible error state (WCAG 3.3.1)",
      node.id));
    return issues;
  }
  // Whether the error state is "color only" requires human visual review — it cannot be
  // determined reliably via the Plugin API (fill comparison misses opacity, blending, etc.)
  // Rule: when a check requires human judgment, report as MANUAL, never as a false HIGH.
  issues.push(makeIssue("MANUAL", "ERROR_COLOR_ONLY_VERIFY", "1.4.1",
    "Verify: error state must differ from default by more than color alone — add error icon or message text (WCAG 1.4.1, requires human review)",
    stateMap["error"].id));
  return issues;
}

function auditHasIndeterminate(node, spec, ctx) {
  var stateMap = findStateVariants(node, ctx);
  if (!stateMap["indeterminate"]) {
    return [makeIssue("LOW", "NO_INDETERMINATE_STATE", "4.1.2",
      "Consider adding an indeterminate state for tri-state checkboxes (e.g. select-all) (WCAG 4.1.2)",
      node.id)];
  }
  return [];
}

function isHeadingLayer(name) {
  var n = name.toLowerCase();
  return n.includes("heading") || n.includes("header") || /^h[1-6]$/.test(n) || /\bh[1-6]\b/.test(n);
}

function isButtonLayer(name) {
  var n = name.toLowerCase();
  return n.includes("button") || n.includes("btn") || n.includes("trigger") || n.includes("toggle");
}

function auditHasHeadingStructure(node) {
  var issues = [];
  if (!("children" in node)) return issues;

  for (var i = 0; i < node.children.length; i++) {
    var item = node.children[i];
    if (!("children" in item)) continue;

    // Per ARIA APG: the correct structure is heading > button (NOT button > heading).
    // Walk the item tree to find:
    //   (A) A heading layer that CONTAINS a button layer as descendant → correct
    //   (B) A button layer that CONTAINS a heading layer as descendant → WRONG (most common mistake)

    var correctStructureFound = false;
    var invertedStructureFound = false;

    // Search for heading layers in this item
    if ("findAll" in item) {
      var headingLayers = item.findAll(function(n) { return isHeadingLayer(n.name); });
      for (var h = 0; h < headingLayers.length; h++) {
        var headingNode = headingLayers[h];
        // Check if this heading has a button as a direct or near descendant
        if ("children" in headingNode) {
          var hasButtonChild = headingNode.children.some(function(c) { return isButtonLayer(c.name); });
          if (hasButtonChild) { correctStructureFound = true; break; }
          // Also check grandchildren (one level deeper)
          var hasButtonGrandchild = headingNode.children.some(function(c) {
            return "children" in c && c.children.some(function(gc) { return isButtonLayer(gc.name); });
          });
          if (hasButtonGrandchild) { correctStructureFound = true; break; }
        }
      }

      // Check for the INVERTED (wrong) pattern: a button containing a heading
      var buttonLayers = item.findAll(function(n) { return isButtonLayer(n.name); });
      for (var b = 0; b < buttonLayers.length; b++) {
        var btnNode = buttonLayers[b];
        if ("children" in btnNode) {
          var hasHeadingChild = btnNode.children.some(function(c) { return isHeadingLayer(c.name); });
          if (hasHeadingChild) { invertedStructureFound = true; break; }
        }
      }
    }

    if (invertedStructureFound) {
      issues.push(makeIssue("HIGH", "ACCORDION_BUTTON_CONTAINS_HEADING", "4.1.2",
        "Accordion item \"" + item.name + "\": heading is INSIDE the button — structure must be heading > button, not button > heading (WCAG 4.1.2, ARIA APG)",
        item.id));
    } else if (!correctStructureFound) {
      issues.push(makeIssue("HIGH", "ACCORDION_NO_HEADING", "4.1.2",
        "Accordion item \"" + item.name + "\" has no heading layer containing the toggle button — structure must be heading[aria-level] > button[aria-expanded] (WCAG 4.1.2)",
        item.id));
    }
  }
  return issues;
}

function auditHasDialogHeading(node) {
  if (!("findAll" in node)) return [];
  var headings = node.findAll(function(n) {
    var nl = n.name.toLowerCase();
    return nl.includes("heading") || nl.includes("title") || nl.includes("dialog-title");
  });
  if (headings.length === 0) {
    return [makeIssue("HIGH", "DIALOG_NO_HEADING", "2.4.6",
      "Dialog has no heading layer — dialog must have a visible heading referenced by aria-labelledby (WCAG 2.4.6)",
      node.id)];
  }
  return [];
}

function auditHasCloseButton(node) {
  if (!("findAll" in node)) return [];
  var closeButtons = node.findAll(function(n) {
    var nl = n.name.toLowerCase();
    return nl.includes("close") || nl.includes("dismiss") || nl.includes("cancel");
  });
  if (closeButtons.length === 0) {
    return [makeIssue("HIGH", "DIALOG_NO_CLOSE", "2.1.2",
      "Dialog has no close/dismiss button — users must be able to escape without a keyboard trap (WCAG 2.1.2)",
      node.id)];
  }
  return [];
}

function auditHasChevronIndicator(node) {
  if (!("findAll" in node)) return [];
  var chevrons = node.findAll(function(n) {
    var nl = n.name.toLowerCase();
    return nl.includes("chevron") || nl.includes("arrow") || nl.includes("caret") ||
           nl.includes("indicator") || nl.includes("dropdown-icon");
  });
  if (chevrons.length === 0) {
    return [makeIssue("MED", "COMBOBOX_NO_CHEVRON", "4.1.2",
      "No visible expand/collapse indicator (chevron/arrow) found in dropdown — users need to see it is expandable",
      node.id)];
  }
  return [];
}

function auditRemovableChipCheck(node) {
  var issues = [];
  var nLower = node.name.toLowerCase();
  var isRemovable = nLower.includes("removable") || nLower.includes("dismiss") || nLower.includes("filter");
  if (!isRemovable) return issues;
  if (!("findAll" in node)) return issues;
  var removeButtons = node.findAll(function(n) {
    var nl = n.name.toLowerCase();
    return nl.includes("remove") || nl.includes("close") || nl.includes("dismiss") || nl.includes("delete");
  });
  for (var i = 0; i < removeButtons.length; i++) {
    var btn = removeButtons[i];
    var existingLabel = btn.getPluginData ? btn.getPluginData("a11y.v1.ariaLabel") : "";
    var hasVisibleText = false;
    if ("findAllWithCriteria" in btn) {
      var texts = btn.findAllWithCriteria({ types: ["TEXT"] });
      hasVisibleText = texts.some(function(t) { return (t.characters || "").trim().length > 0; });
    }
    if (!existingLabel && !hasVisibleText) {
      issues.push(makeIssue("HIGH", "CHIP_REMOVE_NO_LABEL", "4.1.2",
        "Remove button in chip \"" + node.name + "\" has no aria-label — icon-only buttons must have labels (WCAG 4.1.2)",
        btn.id));
    }
  }
  return issues;
}

// ─── Spec matrix: explicit check list per component type (11 types) ───────────

function normalizeMatrixTypeKey(roleOrHint) {
  if (!roleOrHint) return "";
  const r = String(roleOrHint).toLowerCase();
  if (r.indexOf("star") >= 0 && r.indexOf("rating") >= 0) return "star-rating";
  if (r.indexOf("star-rating") >= 0 || r.indexOf("starrating") >= 0) return "star-rating";
  if (r.indexOf("radio-group") >= 0 || r.indexOf("radiogroup") >= 0 || r === "radio") return "radio-group";
  if (r.indexOf("textfield") >= 0 || r.indexOf("text-field") >= 0 || r.indexOf("textbox") >= 0 || r === "input") return "textField";
  if (r.indexOf("checkbox") >= 0) return "checkbox";
  if (r.indexOf("combobox") >= 0 || r.indexOf("dropdown") >= 0 || r === "select") return "select";
  if (r.indexOf("dialog") >= 0 || r.indexOf("modal") >= 0) return "modal";
  if (r.indexOf("tablist") >= 0 || r === "tabs" || r.indexOf("tab-bar") >= 0) return "tabs";
  if (r.indexOf("slider") >= 0 || r.indexOf("range") >= 0) return "slider";
  if (r.indexOf("switch") >= 0 || r === "toggle") return "toggle";
  if (r.indexOf("accordion") >= 0 || r.indexOf("faq") >= 0) return "accordion";
  if (r.indexOf("button") >= 0 || r === "cta") return "button";
  return "";
}

const COMPONENT_SPEC_MATRIX = {
  button: [
    "IS_FIGMA_COMPONENT",
    "HAS_ACCESSIBLE_NAME",
    "TOUCH_TARGET_44",
    "CONTRAST_TEXT",
    "FOCUS_RING_VISIBLE",
    "ROLE_BUTTON_ANNOTATED",
    "STATE_COVERAGE_CORE",
  ],
  textField: [
    "IS_FIGMA_COMPONENT",
    "HAS_LABEL",
    "PLACEHOLDER_NOT_ONLY_LABEL",
    "ERROR_TEXT_NOT_COLOR_ONLY",
    "REQUIRED_STATE_INDICATED",
    "FOCUS_RING_VISIBLE",
    "ROLE_TEXTBOX_ANNOTATED",
    "STATE_COVERAGE_INPUT",
  ],
  checkbox: [
    "IS_FIGMA_COMPONENT",
    "HAS_LABEL",
    "TOUCH_TARGET_24_WITH_SPACING",
    "ARIA_CHECKED_ANNOTATED",
    "GROUP_LABEL_IF_IN_GROUP",
    "FOCUS_RING_VISIBLE",
    "ROLE_CHECKBOX_ANNOTATED",
    "STATE_COVERAGE_CHECKBOX",
  ],
  "radio-group": [
    "IS_FIGMA_COMPONENT",
    "GROUP_HAS_LABEL",
    "EACH_RADIO_HAS_LABEL",
    "ARIA_CHECKED_ANNOTATED",
    "ROLE_RADIOGROUP_ON_CONTAINER",
    "ROLE_RADIO_ON_ITEMS",
    "FOCUS_RING_VISIBLE",
    "TOUCH_TARGET_24_WITH_SPACING",
  ],
  select: [
    "IS_FIGMA_COMPONENT",
    "HAS_LABEL",
    "ROLE_COMBOBOX_OR_LISTBOX",
    "EXPANSION_STATE_ANNOTATED",
    "CHEVRON_OR_EXPAND_INDICATOR",
    "FOCUS_RING_VISIBLE",
    "CONTRAST_TEXT",
    "STATE_COVERAGE_SELECT",
  ],
  modal: [
    "IS_FIGMA_COMPONENT",
    "ROLE_DIALOG_ANNOTATED",
    "ARIA_MODAL_TRUE",
    "HAS_HEADING",
    "CLOSE_BUTTON_HAS_LABEL",
    "FOCUS_TRAP_DESCRIBED",
    "CONTRAST_TEXT",
    "TOUCH_TARGET_44",
  ],
  tabs: [
    "IS_FIGMA_COMPONENT",
    "ROLE_TABLIST_ON_CONTAINER",
    "ROLE_TAB_ON_ITEMS",
    "ARIA_SELECTED_ANNOTATED",
    "ROLE_TABPANEL_ON_PANEL",
    "FOCUS_RING_VISIBLE",
    "CONTRAST_TEXT",
    "TOUCH_TARGET_44",
  ],
  slider: [
    "IS_FIGMA_COMPONENT",
    "ROLE_SLIDER_ANNOTATED",
    "ARIA_VALUE_NOW_MIN_MAX",
    "HAS_LABEL",
    "TOUCH_TARGET_44",
    "VALUE_VISIBLE",
    "FOCUS_RING_VISIBLE",
    "STATE_COVERAGE_SLIDER",
  ],
  "star-rating": [
    "IS_FIGMA_COMPONENT",
    "GROUP_HAS_LABEL",
    "ROLE_GROUP_OR_IMG",
    "CURRENT_VALUE_COMMUNICATED",
    "EACH_STAR_DESCRIBED",
    "CONTRAST_NON_TEXT",
    "TOUCH_TARGET_24_WITH_SPACING",
  ],
  toggle: [
    "IS_FIGMA_COMPONENT",
    "ROLE_SWITCH_ANNOTATED",
    "ARIA_CHECKED_ANNOTATED",
    "HAS_LABEL",
    "TOUCH_TARGET_44",
    "FOCUS_RING_VISIBLE",
    "ON_OFF_STATE_NOT_COLOR_ONLY",
    "STATE_COVERAGE_TOGGLE",
  ],
  accordion: [
    "IS_FIGMA_COMPONENT",
    "HAS_HEADING",
    "ACCORDION_HEADERS_ARE_BUTTONS",
    "ARIA_EXPANDED_ANNOTATED",
    "PANEL_HAS_REGION_ROLE",
    "FOCUS_RING_VISIBLE",
    "CONTRAST_TEXT",
    "CHEVRON_OR_EXPAND_INDICATOR",
    "TOUCH_TARGET_44",
  ],
};

var SHARED_A11Y_KEY_MAP = {
  ariaRole:        "aria-role",
  ariaLabel:       "aria-label",
  ariaLabelledby:  "aria-labelledby",
  ariaLevel:       "aria-level",
  componentType:   "component-type",
  ariaChecked:     "aria-checked",
  ariaExpanded:    "aria-expanded",
  ariaModal:       "aria-modal",
  ariaSelected:    "aria-selected",
  ariaValuenow:    "aria-valuenow",
  ariaValuemin:    "aria-valuemin",
  ariaValuemax:    "aria-valuemax",
  wcagRef:         "wcag-ref",
  issues:          "issues",
  focusTrap:       "focus-trap",
  keyboardPattern: "keyboard-pattern",
};

function getSharedA11y(node, key) {
  if (!node || !node.getSharedPluginData) return "";
  try {
    const sk = SHARED_A11Y_KEY_MAP[key] || key;
    return node.getSharedPluginData("a11y", sk) || "";
  } catch (_e) { return ""; }
}

function getPluginA11y(node, key) {
  if (!node || !node.getPluginData) return "";
  const pd = node.getPluginData("a11y.v1." + key) || node.getPluginData("a11y." + key) || "";
  if (pd) return pd;
  return getSharedA11y(node, key);
}

function setSharedA11y(node, key, value) {
  if (!node || !node.setSharedPluginData) return;
  try { node.setSharedPluginData("a11y", key, value); } catch (_e) {}
}

var ANNOTATION_DEST_STORAGE_KEY = "annotation-destination";

async function getAnnotationDestination() {
  const v = await figma.clientStorage.getAsync(ANNOTATION_DEST_STORAGE_KEY);
  if (v === "devmode" || v === "both") return v;
  return "ask";
}

function collectA11yTagLines(node) {
  const lines = [];
  const seen = {};
  for (const pluginKey in SHARED_A11Y_KEY_MAP) {
    if (!SHARED_A11Y_KEY_MAP.hasOwnProperty(pluginKey)) continue;
    const sharedKey = SHARED_A11Y_KEY_MAP[pluginKey];
    const val = getSharedA11y(node, pluginKey);
    if (!val || seen[sharedKey]) continue;
    seen[sharedKey] = true;
    lines.push(sharedKey + ": " + String(val).slice(0, 80));
  }
  return lines;
}

async function findA11yTagFrame(node) {
  if (!node || !node.getPluginData) return null;
  const storedId = node.getPluginData("a11y-tag-frame-id");
  if (storedId) {
    const stored = await getNodeById(storedId);
    if (stored && stored.type === "FRAME" && !stored.removed) return stored;
  }
  const frameName = "_a11y_tag_" + node.id.replace(/:/g, "_");
  const parent = node.parent;
  if (parent && "children" in parent) {
    for (let i = 0; i < parent.children.length; i++) {
      const ch = parent.children[i];
      if (ch.type === "FRAME" && ch.name === frameName) return ch;
    }
  }
  return null;
}

async function getOrCreateA11yTagFrame(node) {
  if (!node || !isNodeVisible(node)) return null;
  let frame = await findA11yTagFrame(node);
  if (frame) return frame;

  frame = figma.createFrame();
  frame.name = "_a11y_tag_" + node.id.replace(/:/g, "_");
  frame.layoutMode = "VERTICAL";
  frame.itemSpacing = 2;
  frame.paddingTop = 6;
  frame.paddingBottom = 6;
  frame.paddingLeft = 8;
  frame.paddingRight = 8;
  frame.cornerRadius = 4;
  frame.fills = [{ type: "SOLID", color: { r: 0.118, g: 0.118, b: 0.118 } }];
  frame.locked = true;
  frame.setPluginData("a11y.generated", "true");
  frame.setPluginData("a11y.canvasTagFrame", "true");

  const box = node.absoluteBoundingBox;
  if (box) {
    frame.x = box.x + box.width + 12;
    frame.y = box.y;
  } else if ("x" in node) {
    frame.x = node.x + (node.width || 0) + 12;
    frame.y = node.y;
  }

  const parent = node.parent;
  if (parent && "appendChild" in parent) parent.appendChild(frame);
  else figma.currentPage.appendChild(frame);

  node.setPluginData("a11y-tag-frame-id", frame.id);
  return frame;
}

async function refreshCanvasA11yTagFrame(node) {
  const frame = await getOrCreateA11yTagFrame(node);
  if (!frame) return null;
  const lines = collectA11yTagLines(node);
  const textContent = lines.length ? lines.join("\n") : "a11y: (no properties yet)";

  let textNode = null;
  for (let i = 0; i < frame.children.length; i++) {
    if (frame.children[i].type === "TEXT") { textNode = frame.children[i]; break; }
  }

  const fontName = await loadInter("Regular");
  if (!textNode) {
    textNode = figma.createText();
    textNode.name = "a11y-tag / properties";
    textNode.setPluginData("a11y.generated", "true");
    textNode.setPluginData("a11y.canvasTag", "true");
    frame.appendChild(textNode);
  }
  if (fontName) textNode.fontName = fontName;
  textNode.fontSize = 11;
  textNode.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  textNode.characters = textContent;
  return frame;
}

async function writeA11yAnnotation(node, key, value, destination) {
  setSharedA11y(node, key, value);
  if (destination === "both") {
    await refreshCanvasA11yTagFrame(node);
  }
}

function persistCodegenHandoffFields(node, spec, issues) {
  if (!node) return;
  if (spec && spec.role) {
    setSharedA11y(node, "component-type", spec.role);
    try { node.setPluginData("a11y.v1.componentType", spec.role); } catch (_e) {}
  }
  if (spec && spec.ariaRole) {
    setSharedA11y(node, "aria-role", spec.ariaRole);
    try { node.setPluginData("a11y.v1.ariaRole", spec.ariaRole); } catch (_e) {}
  }
  if (spec && spec.wcagRefs && spec.wcagRefs.length) {
    const wcagStr = spec.wcagRefs.join(",");
    setSharedA11y(node, "wcag-ref", wcagStr);
    try { node.setPluginData("a11y.v1.wcagRef", wcagStr); } catch (_e) {}
  }
  if (issues && issues.length) {
    try {
      const json = JSON.stringify(packIssuesForStorage(issues));
      setSharedA11y(node, "issues", json);
      node.setPluginData("a11y.v1.issues", json);
    } catch (_e) {}
  }
}

function readCodegenA11y(node, sharedKey, pluginKey) {
  if (!node) return "";
  let v = "";
  try { v = node.getSharedPluginData("a11y", sharedKey) || ""; } catch (_e) {}
  if (v) return v;
  if (pluginKey) return getPluginA11y(node, pluginKey);
  return "";
}

function buildCodegenResults(node) {
  const results = [];
  if (!node || !node.getSharedPluginData) return results;

  const role       = readCodegenA11y(node, "aria-role", "ariaRole");
  const label      = readCodegenA11y(node, "aria-label", "ariaLabel");
  const labelledby = readCodegenA11y(node, "aria-labelledby", "ariaLabelledby");
  const expanded   = readCodegenA11y(node, "aria-expanded", "ariaExpanded");
  const checked    = readCodegenA11y(node, "aria-checked", "ariaChecked");
  const selected   = readCodegenA11y(node, "aria-selected", "ariaSelected");
  const modal      = readCodegenA11y(node, "aria-modal", "ariaModal");
  const valuenow   = readCodegenA11y(node, "aria-valuenow", "ariaValuenow");
  const valuemin   = readCodegenA11y(node, "aria-valuemin", "ariaValuemin");
  const valuemax   = readCodegenA11y(node, "aria-valuemax", "ariaValuemax");
  const focusTrap  = readCodegenA11y(node, "focus-trap", "focusTrap");
  const keyboard   = readCodegenA11y(node, "keyboard-pattern", "keyboardPattern");
  const compType   = readCodegenA11y(node, "component-type", "componentType");
  const wcagRef    = readCodegenA11y(node, "wcag-ref", "wcagRef");
  const issues     = readCodegenA11y(node, "issues", "issues");

  const hasAttrs = role || label || labelledby || expanded || checked || selected ||
    modal || valuenow || compType || keyboard || focusTrap;
  if (!hasAttrs && !wcagRef && !issues) return results;

  const attrs = [];
  if (role)       attrs.push('role="' + role + '"');
  if (label)      attrs.push('aria-label="' + label.replace(/"/g, "&quot;") + '"');
  if (labelledby) attrs.push('aria-labelledby="' + labelledby + '"');
  if (expanded)   attrs.push('aria-expanded="' + expanded + '"');
  if (checked)    attrs.push('aria-checked="' + checked + '"');
  if (selected)   attrs.push('aria-selected="' + selected + '"');
  if (modal)      attrs.push('aria-modal="' + modal + '"');
  if (valuenow)   attrs.push('aria-valuenow="' + valuenow + '"');
  if (valuemin)   attrs.push('aria-valuemin="' + valuemin + '"');
  if (valuemax)   attrs.push('aria-valuemax="' + valuemax + '"');

  const nodeName = (node.name || "component").replace(/-->/g, "");

  if (attrs.length) {
    const htmlAttrs = attrs.join("\n  ");
    results.push({
      language: "HTML",
      code: "<div\n  " + htmlAttrs + "\n>\n  <!-- " + nodeName + " -->\n</div>",
      title: "Accessible Markup",
    });

    const jsxAttrs = attrs.map(function(a) {
      const m = a.match(/^([\w-]+)="(.+)"$/);
      if (!m) return a;
      return m[1] + '={"' + m[2].replace(/&quot;/g, '"') + '"}';
    }).join("\n  ");
    results.push({
      language: "JAVASCRIPT",
      code: "<div\n  " + jsxAttrs + "\n>\n  {/* " + nodeName + " */}\n</div>",
      title: "React Props",
    });
  }

  if (compType && !role) {
    results.push({
      language: "PLAINTEXT",
      code: "Component type: " + compType,
      title: "Component Pattern",
    });
  }

  if (keyboard) {
    results.push({
      language: "PLAINTEXT",
      code: keyboard,
      title: "Keyboard Behavior",
    });
  }

  if (focusTrap === "true") {
    results.push({
      language: "PLAINTEXT",
      code: "Focus must be trapped within this component while open.\n" +
        "Implement using: focus-trap library, inert attribute on background, or manual tabindex management.\n" +
        "Escape key must close the component.",
      title: "Focus Management",
    });
  }

  if (wcagRef) {
    const refs = wcagRef.split(",").map(function(r) { return r.trim(); }).filter(Boolean);
    const wcagLines = refs.map(function(r) {
      return "WCAG " + r + ": https://www.w3.org/WAI/WCAG22/Understanding/";
    });
    results.push({
      language: "PLAINTEXT",
      code: wcagLines.join("\n"),
      title: "WCAG References",
    });
  }

  if (issues) {
    try {
      const parsed = JSON.parse(issues);
      if (parsed.length > 0) {
        const issueLines = parsed.map(function(i) {
          return "[" + (i.severity || "?") + "] " + (i.code || "?") + ": " + (i.message || i.displayTitle || i.code || "");
        }).join("\n");
        results.push({
          language: "PLAINTEXT",
          code: "\u26a0\ufe0f Unresolved accessibility issues:\n" + issueLines,
          title: "Open Issues",
        });
      }
    } catch (_e) {}
  }

  return results;
}

function refreshDevModeAnnotations(node) {
  if (!node) return;
  try {
    if (typeof node.annotations !== "undefined") {
      node.annotations = [];
    }
  } catch (_e) {}
  const lines = collectA11yTagLines(node);
  if (!lines.length) return;
  try {
    if (typeof node.annotations !== "undefined") {
      node.annotations = [{ label: lines.join("\n") }];
    }
  } catch (_e2) {}
}

function collectA11yHeadingSiblings(node) {
  const parent = node && node.parent;
  if (!parent || !("children" in parent)) return [];
  return parent.children.filter(function(n) {
    return n.type === "TEXT" &&
      n.name && n.name.indexOf("_a11y_heading") >= 0 &&
      Math.abs(n.y - node.y) < 40;
  });
}

async function copyA11yHeadingsToClone(originalNode, clone) {
  const headings = collectA11yHeadingSiblings(originalNode);
  const dx = clone.x - originalNode.x;
  const dy = clone.y - originalNode.y;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const dup = h.clone();
    dup.x = h.x + dx;
    dup.y = h.y + dy;
    if (clone.parent && "appendChild" in clone.parent) clone.parent.appendChild(dup);
    else if (originalNode.parent && "appendChild" in originalNode.parent) originalNode.parent.appendChild(dup);
  }
}

var FOCUS_STATE_ISSUE_CODES = {
  MISSING_FOCUS_RING: true,
  MISSING_STATE_FOCUS: true,
  FOCUS_RING_CONTRAST_FAIL: true,
};

function isFocusStateIssue(issue) {
  if (!issue) return false;
  if (FOCUS_STATE_ISSUE_CODES[issue.code]) return true;
  if (issue.code === "STATE_MISSING" && /focus/i.test(issue.message || "")) return true;
  return false;
}

async function getIssueTargetNode(issue, rootNode) {
  if (issue && issue.nodeId) {
    const n = await getNodeById(issue.nodeId);
    if (n) return n;
  }
  return rootNode || null;
}

function readDesignerPending(node) {
  if (!node || !node.getPluginData) return null;
  try {
    const raw = node.getPluginData("a11y-pending");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_e) { return null; }
}

function readWaitingForAi(node) {
  if (!node || !node.getPluginData) return null;
  try {
    const raw = node.getPluginData("a11y-waiting-ai");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_e) { return null; }
}

function countDesignerPendingIssues(issues) {
  if (!issues) return 0;
  let n = 0;
  for (let i = 0; i < issues.length; i++) {
    if (issues[i].fixed) continue;
    if (issues[i].designerPending || issues[i].waitingForAi) n++;
  }
  return n;
}

var TYPE_NAME_KEYWORDS = {
  button:     ["button", "btn"],
  textField:  ["input", "textfield", "text-field", "field"],
  checkbox:   ["checkbox", "check"],
  "radio-group": ["radio", "radiogroup"],
  select:     ["select", "dropdown", "combobox", "combo"],
  modal:      ["modal", "dialog"],
  tabs:       ["tab"],
  slider:     ["slider", "range"],
  "star-rating": ["star", "rating"],
  toggle:     ["toggle", "switch"],
  accordion:  ["accordion", "faq"],
};

var TYPE_NAME_ALIASES = {
  button:     ["button", "btn", "cta", "action"],
  textField:  ["input", "textfield", "text-field", "field", "entry", "textbox"],
  checkbox:   ["checkbox", "check", "tick"],
  "radio-group": ["radio", "radiogroup", "option", "choice", "color", "item", "chip"],
  select:     ["select", "dropdown", "combobox", "combo", "picker", "menu"],
  modal:      ["modal", "dialog", "popup", "overlay"],
  tabs:       ["tab", "tabs", "navigation"],
  slider:     ["slider", "range", "scrubber"],
  "star-rating": ["star", "rating", "rate"],
  toggle:     ["toggle", "switch", "onoff"],
  accordion:  ["accordion", "faq", "expand", "collapse"],
};

function componentNameMatchesType(componentName, typeKey) {
  const kws = TYPE_NAME_ALIASES[typeKey] || TYPE_NAME_KEYWORDS[typeKey] || [typeKey];
  const nl = (componentName || "").toLowerCase();
  for (let i = 0; i < kws.length; i++) {
    if (nl.indexOf(kws[i]) >= 0) return true;
  }
  return false;
}

async function componentSetForNodeAsync(node) {
  if (!node) return null;
  if (node.type === "COMPONENT_SET") return node;
  if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") return node.parent;
  if (node.type === "INSTANCE") {
    const master = await getMainComponent(node);
    if (master && master.parent && master.parent.type === "COMPONENT_SET") return master.parent;
  }
  return null;
}

function componentSetForNode(node, ctx) {
  if (ctx && ctx.componentSet) return ctx.componentSet;
  if (!node) return null;
  if (node.type === "COMPONENT_SET") return node;
  if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") return node.parent;
  return null;
}

function componentHasVariantStateAxes(node, axisKeywords, ctx) {
  const set = componentSetForNode(node, ctx);
  if (!set) return false;

  try {
    const defs = set.componentPropertyDefinitions || {};
    const keys = Object.keys(defs);
    for (let ki = 0; ki < keys.length; ki++) {
      const keyLower = keys[ki].toLowerCase();
      let axisMatch = false;
      for (let ai = 0; ai < axisKeywords.length; ai++) {
        if (keyLower.indexOf(axisKeywords[ai]) >= 0) { axisMatch = true; break; }
      }
      if (!axisMatch) continue;
      const def = defs[keys[ki]];
      if (def && def.type === "VARIANT" && def.variantOptions && def.variantOptions.length > 0) return true;
    }
  } catch (_e) {}

  if ("children" in set) {
    for (let ci = 0; ci < set.children.length; ci++) {
      const child = set.children[ci];
      if (child.type !== "COMPONENT") continue;
      const nl = child.name.toLowerCase();
      for (let vi = 0; vi < axisKeywords.length; vi++) {
        if (nl.indexOf(axisKeywords[vi]) >= 0) return true;
      }
      if (child.variantProperties) {
        const vKeys = Object.keys(child.variantProperties);
        for (let vk = 0; vk < vKeys.length; vk++) {
          const val = String(child.variantProperties[vKeys[vk]] || "").toLowerCase();
          for (let vi = 0; vi < axisKeywords.length; vi++) {
            if (val.indexOf(axisKeywords[vi]) >= 0) return true;
          }
        }
      }
    }
  }
  return false;
}

function componentHasCheckedOrStateVariants(node, ctx) {
  const sm = findStateVariants(node, ctx);
  if (sm["checked"] || sm["unchecked"] || sm["on"] || sm["off"] || sm["selected"] || sm["active"]) return true;
  return componentHasVariantStateAxes(node, ["check", "select", "state", "on", "off", "active", "selected"], ctx);
}

function componentHasFocusVariants(node, ctx) {
  const sm = findStateVariants(node, ctx);
  if (sm["focus"] || sm["focused"]) return true;
  return componentHasVariantStateAxes(node, ["focus", "focused", "keyboard"], ctx);
}

function componentHasExpandedVariants(node, ctx) {
  const sm = findStateVariants(node, ctx);
  if (sm["expanded"] || sm["collapsed"] || sm["open"] || sm["closed"]) return true;
  return componentHasVariantStateAxes(node, ["expand", "open", "collapsed"], ctx);
}

function appendNonComponentIssue(issues, node, spec, typeKey) {
  if (!node || !typeKey || !spec) return;
  if (node.type === "INSTANCE" || node.type === "COMPONENT") return;
  const label = spec.role || typeKey;
  issues.push(makeIssue("HIGH", "NON_COMPONENT_ELEMENT", "4.1.2",
    "This element looks like a " + label + " but is not a Figma component. " +
    "Screen readers and developers rely on component structure.",
    node.id));
}

function buildFocusStateComponentPrompt(node, rootNode) {
  const target = node || rootNode;
  const box = target.absoluteBoundingBox;
  const w = box ? Math.round(box.width) : Math.round(target.width || 44);
  const h = box ? Math.round(box.height) : Math.round(target.height || 44);
  let textContent = "";
  if ("findAllWithCriteria" in target) {
    const texts = target.findAllWithCriteria({ types: ["TEXT"] });
    for (let i = 0; i < texts.length && textContent.length < 120; i++) {
      const t = (texts[i].characters || "").trim();
      if (t) textContent = textContent ? textContent + " | " + t : t;
    }
  }
  const role = getPluginA11y(target, "ariaRole") || getSharedA11y(target, "ariaRole") || "button";
  return (
    "Create an accessible " + role + " component based on ARIA APG pattern.\n" +
    "Requirements:\n" +
    "Root: role=\"" + role + "\"\n" +
    "States required: default, hover, focus, disabled\n" +
    "Focus state: 2px solid outline, 2px offset, color must achieve 3:1 contrast against adjacent colors\n" +
    "Preserve this text content: \"" + (textContent || target.name) + "\"\n" +
    "Approximate size: " + w + "×" + h + "px\n" +
    "Place the new component 120px to the right of node [" + target.id + '] named "' + target.name + "\"\n" +
    "Do not modify the original node\n" +
    "Add ARIA annotations as Figma annotations on each layer"
  );
}

function buildComponentLinkAIPrompt(node, typeKey, role) {
  const target = node;
  const box = target.absoluteBoundingBox;
  const w = box ? Math.round(box.width) : Math.round(target.width || 44);
  const h = box ? Math.round(box.height) : Math.round(target.height || 44);
  let textContent = "";
  if ("findAllWithCriteria" in target) {
    const texts = target.findAllWithCriteria({ types: ["TEXT"] });
    for (let i = 0; i < texts.length; i++) {
      const t = (texts[i].characters || "").trim();
      if (t) { textContent = t; break; }
    }
  }
  const ariaRole = role || typeKey || "button";
  return (
    "Create an accessible " + ariaRole + " component based on ARIA APG pattern.\n" +
    "Requirements:\n" +
    "Root: role=\"" + ariaRole + "\"\n" +
    "States required: default, hover, focus, disabled\n" +
    "Focus state: 2px solid outline, 2px offset, color must achieve 3:1 contrast against adjacent colors\n" +
    "Preserve this text content: \"" + (textContent || target.name) + "\"\n" +
    "Approximate size: " + w + "×" + h + "px\n" +
    "Place the new component 120px to the right of node [" + target.id + '] named "' + target.name + "\"\n" +
    "Do not modify the original node\n" +
    "Add ARIA annotations as Figma annotations on each layer"
  );
}

async function copyTextOverridesToInstance(originalNode, instance) {
  if (!originalNode || !instance || !("findAllWithCriteria" in originalNode)) return;
  const originalTexts = originalNode.findAllWithCriteria({ types: ["TEXT"] });
  const instanceTexts = instance.findAllWithCriteria({ types: ["TEXT"] });
  const limit = Math.min(originalTexts.length, instanceTexts.length);
  for (let i = 0; i < limit; i++) {
    const src = originalTexts[i];
    const dst = instanceTexts[i];
    if (!src.characters) continue;
    try {
      if (dst.fontName !== figma.mixed) {
        await figma.loadFontAsync(dst.fontName);
        dst.characters = src.characters;
      }
    } catch (_e) {}
  }
}

async function linkNodeToComponentInstance(originalNode, componentNode) {
  const instance = componentNode.createInstance();
  await copyTextOverridesToInstance(originalNode, instance);
  instance.x = originalNode.x;
  instance.y = originalNode.y;
  const parent = originalNode.parent;
  if (parent && "insertChild" in parent && "children" in parent) {
    const idx = parent.children.indexOf(originalNode);
    parent.insertChild(idx >= 0 ? idx : parent.children.length, instance);
  } else {
    figma.currentPage.appendChild(instance);
  }
  originalNode.visible = false;
  return instance;
}

function countNodeChildren(node) {
  if (!node || !("children" in node)) return 0;
  return node.children.length;
}

async function findAccessibleComponentCandidates(typeKey, referenceNode) {
  const seen = {};
  const results = [];

  function addCandidate(comp, source, isPossibleMatch) {
    if (!comp || comp.type !== "COMPONENT" || seen[comp.id]) return;
    seen[comp.id] = true;
    results.push({
      component:       comp,
      source:          source,
      isPossibleMatch: !!isPossibleMatch,
    });
  }

  // Step A — instances on current page → mainComponent
  const page = figma.currentPage;
  if ("findAll" in page) {
    const instances = page.findAll(function(n) { return n.type === "INSTANCE"; });
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const master = await getMainComponent(inst);
      if (!master) continue;
      if (componentNameMatchesType(master.name, typeKey)) {
        addCandidate(master, "instance", false);
      }
    }
  }

  // Step B — name search (with aliases) across file
  const pages = figma.root.children;
  for (let p = 0; p < pages.length; p++) {
    const pg = pages[p];
    if (!("findAll" in pg)) continue;
    const found = pg.findAll(function(n) {
      return n.type === "COMPONENT" && componentNameMatchesType(n.name, typeKey);
    });
    for (let i = 0; i < found.length; i++) addCandidate(found[i], "name", false);
  }

  // Step C — structural similarity on COMPONENT_SET (child count ±2)
  if (referenceNode && results.length === 0) {
    const refCount = countNodeChildren(referenceNode);
    for (let p = 0; p < pages.length; p++) {
      const pg = pages[p];
      if (!("findAll" in pg)) continue;
      const sets = pg.findAll(function(n) { return n.type === "COMPONENT_SET"; });
      for (let si = 0; si < sets.length; si++) {
        const set = sets[si];
        const childCount = countNodeChildren(set);
        if (Math.abs(childCount - refCount) <= 2) {
          const defaultChild = set.children && set.children[0];
          if (defaultChild && defaultChild.type === "COMPONENT") {
            addCandidate(defaultChild, "structure", true);
          }
        }
      }
    }
  }

  return results;
}

async function exportNodeThumbnailBase64(node) {
  if (!node || !("exportAsync" in node)) return null;
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 0.25 },
    });
    return figma.base64Encode(bytes);
  } catch (_e) { return null; }
}

async function auditCandidateIssueCount(candidate, typeKey) {
  const spec = COMPONENT_SPECS.find(function(s) { return s.role === typeKey; }) ||
    COMPONENT_SPECS.find(function(s) { return normalizeMatrixTypeKey(s.role) === typeKey; });
  if (!spec) return 999;
  const ctx = await gatherContext(candidate);
  const result = await auditNode(candidate, spec, ctx);
  return result.issues ? result.issues.length : 0;
}

function hasAccessibleName(node, ctx) {
  const inner = (ctx.innerText || []).join(" ").trim();
  if (inner.length > 0) return true;
  const aria = getPluginA11y(node, "ariaLabel");
  if (aria.trim()) return true;
  try {
    if (node.getSharedPluginData("a11y", "ariaLabel")) return true;
  } catch (_e) {}
  const ext = ctx.nearbyText || [];
  return ext.length > 0;
}

function hasNearbyHeadingText(node, maxDistancePx) {
  const box = node.absoluteBoundingBox;
  if (!box) return false;
  const allText = figma.currentPage.findAllWithCriteria({ types: ["TEXT"] });
  for (let i = 0; i < allText.length; i++) {
    const t = allText[i];
    const tb = t.absoluteBoundingBox;
    if (!tb) continue;
    const gap = box.y - (tb.y + tb.height);
    const inX = tb.x + tb.width >= box.x - 40 && tb.x <= box.x + box.width + 40;
    if (gap >= 0 && gap <= maxDistancePx && inX && (t.characters || "").trim()) {
      if (isHeadingStyledText(t)) return true;
      if (HEADING_NAME_RE.test(t.name)) return true;
    }
  }
  return false;
}

// HAS_HEADING — 4-tier: annotation → styled text (depth 3) → nearby ≤40px → node name
function checkerHasHeading(node, ctx, typeKey) {
  const ariaLabel = getPluginA11y(node, "ariaLabel");
  const labelledBy = getPluginA11y(node, "ariaLabelledby");
  let sharedLabel = "";
  let sharedLabelledBy = "";
  try {
    sharedLabel = node.getSharedPluginData("a11y", "aria-label") || "";
    sharedLabelledBy = node.getSharedPluginData("a11y", "aria-labelledby") || "";
  } catch (_e) {}
  if (ariaLabel.trim() || labelledBy.trim() || sharedLabel.trim() || sharedLabelledBy.trim()) return [];

  if (ctx.textHierarchy) {
    for (let i = 0; i < ctx.textHierarchy.length; i++) {
      const t = ctx.textHierarchy[i];
      if (t.depth <= 3 && t.fontSize >= 16 && t.fontWeight >= 600) return [];
    }
  }
  if ("children" in node) {
    for (let c = 0; c < node.children.length; c++) {
      if (node.children[c].type === "TEXT" && isHeadingStyledText(node.children[c])) return [];
    }
  }
  if (hasNearbyHeadingText(node, 40)) return [];

  const nl = (ctx.nodeName || "").toLowerCase();
  if (HEADING_NAME_RE.test(nl)) return [];

  const isAccordion = typeKey === "accordion";
  return [makeIssue("HIGH", isAccordion ? "ACCORDION_NO_HEADING" : "DIALOG_NO_HEADING",
    isAccordion ? "4.1.2" : "2.4.6",
    isAccordion
      ? "No section heading found — use 16px+ semibold text, a label within 40px above, or aria-labelledby"
      : "No dialog heading found — use title text, label within 40px above, or aria-labelledby",
    node.id)];
}

function matrixIssuesFromAudit(fn, node, spec, ctx) {
  const specUse = spec || { role: "group", isStarRating: false, requiredStates: [] };
  const r = fn(node, specUse, ctx);
  return r && r.length ? r : [];
}

function checkerPlaceholderNotOnlyLabel(node, ctx) {
  const inner = ctx.innerText || [];
  const hasLabel = hasAccessibleName(node, ctx);
  const placeholderOnly = inner.length === 1 && inner[0].length > 0 && !hasLabel;
  if (!placeholderOnly) return [];
  const hasPh = (ctx.allChildNames || []).some(function(n) {
    return n.toLowerCase().indexOf("placeholder") >= 0;
  }) || (ctx.childNames || []).some(function(c) {
    return c.name.toLowerCase().indexOf("placeholder") >= 0;
  });
  if (!hasPh) return [];
  return [makeIssue("HIGH", "NO_INPUT_LABEL", "3.3.2",
    "Placeholder text must not be the only label — add a persistent visible label (WCAG 3.3.2)",
    node.id)];
}

function checkerRequiredStateIndicated(node, ctx) {
  const stateMap = findStateVariants(node, ctx);
  const req = stateMap["required"] || stateMap["error"];
  const textBlob = (ctx.innerText || []).join(" ").toLowerCase();
  if (req || textBlob.indexOf("required") >= 0 || textBlob.indexOf("*") >= 0) return [];
  return [makeIssue("MED", "REQUIRED_NOT_INDICATED", "3.3.2",
    "Required field should show a visual required indicator (not asterisk alone) and aria-required in dev handoff",
    node.id)];
}

function checkerRoleAnnotated(node, ctx, expectedRole, code) {
  const stored = getPluginA11y(node, "ariaRole") || getPluginA11y(node, "componentType");
  const sharedRole = getSharedA11y(node, "ariaRole");
  const roleBlob = (stored + " " + sharedRole).toLowerCase();
  if (roleBlob && roleBlob.indexOf(expectedRole.toLowerCase().slice(0, 4)) >= 0) return [];
  return [makeIssue("MED", code, "4.1.2",
    "Annotate role as \"" + expectedRole + "\" in plugin data for Dev Mode export",
    node.id)];
}

function checkerAccordionHeadersAreButtons(node, ctx) {
  const issues = [];
  if (!node || !("children" in node)) return issues;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!isNodeVisible(child) || child.type === "TEXT") continue;
    const role = getSharedA11y(child, "ariaRole");
    if (role === "button") continue;
    issues.push(makeIssue("HIGH", "ACCORDION_HEADER_NOT_BUTTON", "4.1.2",
      "Accordion row \"" + child.name + "\" must annotate aria-role=\"button\" on the trigger (Dev Mode handoff)",
      child.id));
  }
  return issues;
}

function checkerAriaExpandedAnnotated(node, ctx, typeKey) {
  if (typeKey === "accordion") {
    if (getSharedA11y(node, "ariaExpanded")) return [];
    return [makeIssue("MED", "ARIA_EXPANDED_MISSING", "4.1.2",
      "Document aria-expanded on accordion root in Dev Mode handoff (setSharedPluginData)",
      node.id)];
  }
  const stateMap = findStateVariants(node, ctx);
  const hasExp = stateMap["expanded"] || stateMap["collapsed"] || stateMap["open"] || stateMap["closed"];
  if (hasExp) return [];
  if (getSharedA11y(node, "ariaExpanded")) return [];
  if (typeKey === "select") {
    return [makeIssue("MED", "ARIA_EXPANDED_MISSING", "4.1.2",
      "Document aria-expanded on the combobox trigger for open/closed states",
      node.id)];
  }
  return [];
}

function checkerPanelHasRegionRole(node, ctx) {
  if (getSharedA11y(node, "ariaRole") === "region") return [];
  return [makeIssue("MED", "ACCORDION_PANEL_REGION", "4.1.2",
    "Document role=\"region\" on accordion panel in Dev Mode handoff (setSharedPluginData on root)",
    node.id)];
}

function checkerTabsStructure(node, ctx) {
  const issues = [];
  const names = (ctx.allChildNames || []).join(" ").toLowerCase();
  if (names.indexOf("tab") < 0) {
    issues.push(makeIssue("MED", "TABS_NO_TAB_ITEMS", "4.1.2",
      "Tab list should contain tab items (role=\"tab\") — none detected in layer names",
      node.id));
  }
  if (names.indexOf("panel") < 0 && names.indexOf("tabpanel") < 0) {
    issues.push(makeIssue("MED", "TABS_NO_TABPANEL", "4.1.2",
      "Tab pattern needs tabpanel layers for each tab content area",
      node.id));
  }
  return issues;
}

function checkerSliderValue(node, ctx) {
  const issues = [];
  const names = (ctx.allChildNames || []).join(" ").toLowerCase();
  const hasThumb = names.indexOf("thumb") >= 0 || names.indexOf("handle") >= 0;
  const hasTrack = names.indexOf("track") >= 0 || names.indexOf("fill") >= 0;
  if (!hasThumb || !hasTrack) {
    issues.push(makeIssue("MED", "SLIDER_PARTS_MISSING", "4.1.2",
      "Slider should expose track + thumb/handle layers for value communication",
      node.id));
  }
  const valText = (ctx.innerText || []).some(function(t) { return /\d/.test(t); });
  if (!valText && !getPluginA11y(node, "ariaLabel") && !getSharedA11y(node, "ariaValuenow")) {
    issues.push(makeIssue("MED", "SLIDER_VALUE_NOT_VISIBLE", "4.1.2",
      "Show current value visually or via aria-valuenow in annotations",
      node.id));
  }
  return issues;
}

function checkerStarCurrentValue(node, ctx) {
  const role = getPluginA11y(node, "ariaRole");
  if (role.indexOf("img") >= 0 || role.indexOf("group") >= 0) return [];
  if (getSharedA11y(node, "ariaValuenow")) return [];
  return [makeIssue("MED", "RATING_VALUE_NOT_COMMUNICATED", "4.1.2",
    "Star rating should communicate current value (aria-valuenow or group label with selected state)",
    node.id)];
}

// SPEC_CHECKERS: each returns [] (pass) or Issue[] (fail). Runs ALL matrix entries.
function getShapeContrastMetrics(shapeNode) {
  if (!shapeNode || shapeNode.type === "TEXT" || !isNodeVisible(shapeNode)) return null;
  const rawFill = getNodeComposedFill(shapeNode);
  let rawStroke = null;
  if ("strokes" in shapeNode && shapeNode.strokes && shapeNode.strokes !== figma.mixed) {
    for (let i = 0; i < shapeNode.strokes.length; i++) {
      const s = shapeNode.strokes[i];
      if (s.type === "SOLID" && s.visible !== false) {
        const c = s.color;
        rawStroke = {
          r: c.r, g: c.g, b: c.b,
          a: (c.a !== undefined ? c.a : 1) * (s.opacity !== undefined ? s.opacity : 1),
        };
        break;
      }
    }
  }
  const raw = rawFill || rawStroke;
  if (!raw || raw.a < 0.01) return null;
  const bg = getBackgroundBehindNode(shapeNode);
  const bgR01 = bg.r / 255;
  const bgG01 = bg.g / 255;
  const bgB01 = bg.b / 255;
  let pr, pg, pb;
  if (raw.a >= 0.995) {
    pr = raw.r; pg = raw.g; pb = raw.b;
  } else {
    const a = raw.a;
    const inv = 1 - a;
    pr = raw.r * a + bgR01 * inv;
    pg = raw.g * a + bgG01 * inv;
    pb = raw.b * a + bgB01 * inv;
  }
  const perceived = { r: Math.round(pr * 255), g: Math.round(pg * 255), b: Math.round(pb * 255) };
  if (perceived.r === bg.r && perceived.g === bg.g && perceived.b === bg.b) return null;
  const ratio = contrastRatioForRgb255(perceived, bg);
  if (ratio <= 1.0) return null;
  return {
    perceived: perceived,
    bg: bg,
    ratio: ratio,
    fgHex: rgbToHex255(perceived.r, perceived.g, perceived.b),
    bgHex: rgbToHex255(bg.r, bg.g, bg.b),
    paintKind: rawFill ? "fill" : "stroke",
  };
}

function checkNonTextContrast(node, ctx) {
  const issues = [];
  if (!node || !isNodeVisible(node)) return issues;
  const types = ["FRAME", "GROUP", "COMPONENT", "INSTANCE", "VECTOR", "BOOLEAN_OPERATION",
    "STAR", "LINE", "ELLIPSE", "POLYGON", "RECTANGLE"];
  let candidates = [node];
  if ("findAllWithCriteria" in node) {
    candidates = node.findAllWithCriteria({ types: types });
    if (candidates.indexOf(node) < 0) candidates.unshift(node);
  }
  const seen = {};
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i];
    if (!n || n.type === "TEXT" || !isNodeVisible(n) || seen[n.id]) continue;
    if ("children" in n && n.children && n.children.length > 0) continue;
    const metrics = getShapeContrastMetrics(n);
    if (!metrics || metrics.ratio >= 3.0) continue;
    seen[n.id] = true;
    issues.push(makeIssue("MED", "NON_TEXT_CONTRAST_FAIL", "1.4.11",
      "Non-text UI contrast " + metrics.ratio.toFixed(1) + ":1 below 3:1 (" +
      metrics.fgHex + " on " + metrics.bgHex + ")",
      n.id));
  }
  return issues;
}

const SPEC_CHECKERS = {
  IS_FIGMA_COMPONENT: function(node, ctx, typeKey, spec) {
    const issues = [];
    appendNonComponentIssue(issues, node, spec || { role: typeKey }, typeKey);
    return issues;
  },
  HAS_ACCESSIBLE_NAME: function(node, ctx) {
    if (hasAccessibleName(node, ctx)) return [];
    const iconIssues = matrixIssuesFromAudit(auditIconOnlyLabel, node, { role: "button", requiredStates: [] }, ctx);
    if (iconIssues.length) return iconIssues;
    return [makeIssue("HIGH", "ICON_BUTTON_NO_LABEL", "4.1.2", "No accessible name — add visible text or aria-label", node.id)];
  },
  TOUCH_TARGET_44: function(node, ctx) { return matrixIssuesFromAudit(auditTouchTarget, node, { role: "button", requiredStates: [] }, ctx); },
  TOUCH_TARGET_24_WITH_SPACING: function(node, ctx) { return matrixIssuesFromAudit(auditTouchTarget, node, { role: "group", requiredStates: [] }, ctx); },
  CONTRAST_TEXT: function(node, ctx) { return matrixIssuesFromAudit(auditTextContrast, node, { role: "button", requiredStates: [] }, ctx); },
  CONTRAST_NON_TEXT: function(node, ctx) { return checkNonTextContrast(node, ctx); },
  FOCUS_RING_VISIBLE: function(node, ctx) {
    if (componentHasFocusVariants(node, ctx)) return [];
    return matrixIssuesFromAudit(auditFocusRing, node, { role: "button", requiredStates: ["focus"] }, ctx);
  },
  ROLE_BUTTON_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "button", "ROLE_BUTTON_MISSING"); },
  HAS_LABEL: function(node, ctx) { return matrixIssuesFromAudit(auditHasInputLabel, node, { role: "textField", requiredStates: [] }, ctx); },
  PLACEHOLDER_NOT_ONLY_LABEL: function(node, ctx) { return checkerPlaceholderNotOnlyLabel(node, ctx); },
  ERROR_TEXT_NOT_COLOR_ONLY: function(node, ctx) { return matrixIssuesFromAudit(auditHasErrorState, node, { role: "textField", requiredStates: [] }, ctx); },
  REQUIRED_STATE_INDICATED: function(node, ctx) { return checkerRequiredStateIndicated(node, ctx); },
  ROLE_TEXTBOX_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "textbox", "ROLE_TEXTBOX_MISSING"); },
  STATE_COVERAGE_CORE: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "button", requiredStates: ["default", "hover", "focus", "disabled"] }, ctx);
  },
  STATE_COVERAGE_INPUT: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "textField", requiredStates: ["empty", "filled", "focus", "error", "disabled"] }, ctx);
  },
  STATE_COVERAGE_CHECKBOX: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "checkbox", requiredStates: ["unchecked", "checked", "focus", "disabled"] }, ctx);
  },
  STATE_COVERAGE_SELECT: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "combobox", requiredStates: ["closed", "open", "focused", "disabled"] }, ctx);
  },
  STATE_COVERAGE_SLIDER: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "slider", requiredStates: ["default", "focus", "disabled"] }, ctx);
  },
  STATE_COVERAGE_TOGGLE: function(node, ctx) {
    return matrixIssuesFromAudit(auditStateCoverage, node, { role: "switch", requiredStates: ["unchecked", "checked", "focus", "disabled"] }, ctx);
  },
  ARIA_CHECKED_ANNOTATED: function(node, ctx) {
    if (componentHasCheckedOrStateVariants(node)) return [];
    const sm = findStateVariants(node, ctx);
    if (sm["checked"] || sm["unchecked"] || sm["on"] || sm["off"]) return [];
    if (getSharedA11y(node, "ariaChecked")) return [];
    return [makeIssue("MED", "ARIA_CHECKED_MISSING", "4.1.2", "Document checked/unchecked (or on/off) states for assistive tech", node.id)];
  },
  GROUP_LABEL_IF_IN_GROUP: function(node, ctx) {
    if (ctx.siblingCount >= 2) return matrixIssuesFromAudit(auditHasGroupLabel, node, { role: "checkbox", requiredStates: [] }, ctx);
    return [];
  },
  ROLE_CHECKBOX_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "checkbox", "ROLE_CHECKBOX_MISSING"); },
  GROUP_HAS_LABEL: function(node, ctx) { return matrixIssuesFromAudit(auditHasGroupLabel, node, { role: "radio-group", requiredStates: [] }, ctx); },
  EACH_RADIO_HAS_LABEL: function(node, ctx) { return matrixIssuesFromAudit(auditEachRadioHasLabel, node, { role: "radio-group", requiredStates: [] }, ctx); },
  ROLE_RADIOGROUP_ON_CONTAINER: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "radiogroup", "ROLE_RADIOGROUP_MISSING"); },
  ROLE_RADIO_ON_ITEMS: function(node, ctx) { return matrixIssuesFromAudit(auditEachRadioHasLabel, node, { role: "radio-group", requiredStates: [] }, ctx); },
  ROLE_COMBOBOX_OR_LISTBOX: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "combobox", "ROLE_COMBOBOX_MISSING"); },
  EXPANSION_STATE_ANNOTATED: function(node, ctx, typeKey) {
    if (componentHasExpandedVariants(node, ctx)) return [];
    return checkerAriaExpandedAnnotated(node, ctx, typeKey || "select");
  },
  CHEVRON_OR_EXPAND_INDICATOR: function(node, ctx, typeKey) {
    if (typeKey === "accordion") {
      if (ctx.accordionCoLocatedRows >= 2) return [];
      return [makeIssue("MED", "COMBOBOX_NO_CHEVRON", "4.1.2",
        "Accordion rows need a chevron/expand icon co-located with each row label",
        node.id)];
    }
    if (ctx.hasChevrons) return [];
    return matrixIssuesFromAudit(auditHasChevronIndicator, node, { role: "combobox", requiredStates: [] }, ctx);
  },
  ROLE_DIALOG_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "dialog", "ROLE_DIALOG_MISSING"); },
  ARIA_MODAL_TRUE: function(node, ctx) {
    const ct = getPluginA11y(node, "componentType");
    if (ct.indexOf("dialog") >= 0 || ct.indexOf("modal") >= 0) return [];
    if (getSharedA11y(node, "ariaModal") === "true") return [];
    return [makeIssue("MED", "ARIA_MODAL_MISSING", "4.1.2", "Document aria-modal=\"true\" on dialog overlay in Dev Mode handoff", node.id)];
  },
  HAS_HEADING: function(node, ctx, typeKey) { return checkerHasHeading(node, ctx, typeKey || "modal"); },
  CLOSE_BUTTON_HAS_LABEL: function(node, ctx) { return matrixIssuesFromAudit(auditHasCloseButton, node, { role: "dialog", requiredStates: [] }, ctx); },
  FOCUS_TRAP_DESCRIBED: function(node, ctx) {
    if (getSharedA11y(node, "focus-trap") === "true") return [];
    return [makeIssue("MANUAL", "FOCUS_TRAP_VERIFY", "2.4.3",
      "Verify focus moves into dialog on open and returns to trigger on close (WCAG 2.4.3 — manual)",
      node.id)];
  },
  ROLE_TABLIST_ON_CONTAINER: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "tablist", "ROLE_TABLIST_MISSING"); },
  ROLE_TAB_ON_ITEMS: function(node, ctx) { return checkerTabsStructure(node, ctx); },
  ARIA_SELECTED_ANNOTATED: function(node, ctx) {
    if (componentHasVariantStateAxes(node, ["select", "selected", "active", "tab", "state"], ctx)) return [];
    const sm = findStateVariants(node, ctx);
    if (sm["selected"] || sm["active"] || sm["default"]) return [];
    if ("children" in node) {
      for (let i = 0; i < node.children.length; i++) {
        if (getSharedA11y(node.children[i], "ariaSelected")) return [];
      }
    }
    return [makeIssue("MED", "ARIA_SELECTED_MISSING", "4.1.2", "Tab list needs selected/default tab states documented", node.id)];
  },
  ROLE_TABPANEL_ON_PANEL: function(node, ctx) { return checkerTabsStructure(node, ctx); },
  ROLE_SLIDER_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "slider", "ROLE_SLIDER_MISSING"); },
  ARIA_VALUE_NOW_MIN_MAX: function(node, ctx) {
    if (getPluginA11y(node, "ariaLabel").indexOf("value") >= 0) return [];
    if (getSharedA11y(node, "ariaValuenow")) return [];
    return [makeIssue("MED", "SLIDER_ARIA_VALUE_MISSING", "4.1.2",
      "Document aria-valuenow, aria-valuemin, aria-valuemax in plugin data for the slider",
      node.id)];
  },
  VALUE_VISIBLE: function(node, ctx) { return checkerSliderValue(node, ctx); },
  GROUP_HAS_LABEL: function(node, ctx) { return matrixIssuesFromAudit(auditHasGroupLabel, node, { role: "radio-group (star-rating)", requiredStates: [] }, ctx); },
  ROLE_GROUP_OR_IMG: function(node, ctx) {
    const r = getPluginA11y(node, "ariaRole");
    const shared = getSharedA11y(node, "ariaRole");
    const blob = (r + " " + shared).toLowerCase();
    if (blob.indexOf("group") >= 0 || blob.indexOf("img") >= 0 || blob.indexOf("radiogroup") >= 0) return [];
    return [makeIssue("MED", "RATING_ROLE_MISSING", "4.1.2", "Use role=\"radiogroup\" or role=\"img\" with descriptive label for star rating", node.id)];
  },
  CURRENT_VALUE_COMMUNICATED: function(node, ctx) { return checkerStarCurrentValue(node, ctx); },
  EACH_STAR_DESCRIBED: function(node, ctx) {
    return matrixIssuesFromAudit(auditStarRatingAriaLabels, node, { role: "radio-group (star-rating)", isStarRating: true, requiredStates: [] }, ctx);
  },
  ROLE_SWITCH_ANNOTATED: function(node, ctx) { return checkerRoleAnnotated(node, ctx, "switch", "ROLE_SWITCH_MISSING"); },
  ON_OFF_STATE_NOT_COLOR_ONLY: function(node, ctx) {
    return matrixIssuesFromAudit(auditColorOnlyDisabled, node, { role: "switch", requiredStates: [] }, ctx);
  },
  ACCORDION_HEADERS_ARE_BUTTONS: function(node, ctx) { return checkerAccordionHeadersAreButtons(node, ctx); },
  ARIA_EXPANDED_ANNOTATED: function(node, ctx, typeKey) { return checkerAriaExpandedAnnotated(node, ctx, typeKey || "accordion"); },
  PANEL_HAS_REGION_ROLE: function(node, ctx) { return checkerPanelHasRegionRole(node, ctx); },
};

async function runMatrixChecks(node, ctx, typeKey, spec) {
  const checks = COMPONENT_SPEC_MATRIX[typeKey];
  const issues = [];
  const auditLog = [];
  if (isA11yGeneratedLayer(node)) {
    notifyScanSkipped(node);
    return emptyAuditResult();
  }
  if (!checks || !checks.length) return { issues: issues, auditLog: auditLog };
  if (!isNodeVisible(node)) return { issues: issues, auditLog: auditLog };

  for (let i = 0; i < checks.length; i++) {
    const checkId = checks[i];
    const fn = SPEC_CHECKERS[checkId];
    if (!fn) {
      auditLog.push({ name: checkId, status: "ERROR", count: 0, error: "No checker registered" });
      continue;
    }
    try {
      if (!isNodeVisible(node)) continue;
      const result = fn(node, ctx, typeKey, spec) || [];
      for (let j = 0; j < result.length; j++) issues.push(result[j]);
      let status = "PASS";
      if (result.some(function(x) { return x.severity === "HIGH"; })) status = "BLOCK";
      else if (result.some(function(x) { return x.severity === "MED" || x.severity === "MANUAL"; })) status = "WARN";
      auditLog.push({
        name: checkId,
        status: status,
        count: result.length,
        wcagRefs: result.map(function(x) { return x.wcagRef; }).filter(Boolean).join(", ") || null,
      });
    } catch (e) {
      auditLog.push({ name: checkId, status: "ERROR", count: 0, error: String(e) });
    }
  }

  await enrichIssueFixMeta(issues, node);
  return { issues: issues, auditLog: auditLog };
}

const AUDIT_FUNCTIONS = {
  stateCoverage:         auditStateCoverage,
  touchTarget:           auditTouchTarget,
  focusRing:             auditFocusRing,
  textContrast:          auditTextContrast,
  iconOnlyLabel:         auditIconOnlyLabel,
  colorOnlyDisabled:     auditColorOnlyDisabled,
  hasGroupLabel:         auditHasGroupLabel,
  eachRadioHasLabel:     auditEachRadioHasLabel,
  starRatingAriaLabels:  auditStarRatingAriaLabels,
  // Phase C
  hasInputLabel:         auditHasInputLabel,
  hasErrorState:         auditHasErrorState,
  hasIndeterminate:      auditHasIndeterminate,
  hasHeadingStructure:   auditHasHeadingStructure,
  hasDialogHeading:      auditHasDialogHeading,
  hasCloseButton:        auditHasCloseButton,
  hasChevronIndicator:   auditHasChevronIndicator,
  removableChipCheck:    auditRemovableChipCheck,
};

// ─── Audit dispatcher ─────────────────────────────────────────────────────────
// Returns { issues: Issue[], auditLog: AuditEntry[] }
// auditLog entries: { name, status: "PASS"|"WARN"|"BLOCK"|"ERROR", count, wcagRefs? }

async function auditNode(node, spec, ctx) {
  if (isA11yGeneratedLayer(node)) {
    notifyScanSkipped(node);
    return emptyAuditResult();
  }
  const typeKey = normalizeMatrixTypeKey(spec.role);
  if (typeKey && COMPONENT_SPEC_MATRIX[typeKey]) {
    const result = await runMatrixChecks(node, ctx, typeKey, spec);
    await enrichIssueFixMeta(result.issues, node);
    return result;
  }

  // Legacy path (e.g. status/chip) — spec.audits list
  const issues   = [];
  const auditLog = [];
  const audits   = spec.audits || [];

  for (let i = 0; i < audits.length; i++) {
    const auditName = audits[i];
    const fn        = AUDIT_FUNCTIONS[auditName];
    if (!fn) continue;
    try {
      const result      = fn(node, spec, ctx);
      const auditIssues = (result && result.length) ? result : [];
      for (let j = 0; j < auditIssues.length; j++) issues.push(auditIssues[j]);

      let status = "PASS";
      if (auditIssues.some(function(x) { return x.severity === "HIGH"; }))   status = "BLOCK";
      else if (auditIssues.some(function(x) { return x.severity === "MED" || x.severity === "MANUAL"; })) status = "WARN";

      const wcagRefs = auditIssues.length > 0
        ? auditIssues.map(function(x) { return x.wcagRef; }).filter(Boolean).join(", ")
        : null;

      auditLog.push({ name: auditName, status: status, count: auditIssues.length, wcagRefs: wcagRefs });
    } catch (e) {
      auditLog.push({ name: auditName, status: "ERROR", count: 0, error: String(e) });
    }
  }
  await enrichIssueFixMeta(issues, node);
  return { issues: issues, auditLog: auditLog };
}

// ─── Resolve semantic nodeIds → real Figma IDs ────────────────────────────────

async function resolveSuggestions(suggestions, rootNode) {
  const resolved = [];

  for (const sug of suggestions) {
    const id = sug.nodeId;

    if (/^\d+:\d+$/.test(id)) {
      const node = await getNodeById(id);
      if (node) resolved.push(Object.assign({}, sug, { resolvedIds: [id] }));
      continue;
    }

    if (
      id === "__ROOT__" ||
      id.toLowerCase().includes("group") ||
      id.toLowerCase().includes("selection") ||
      id.toLowerCase().includes("container")
    ) {
      resolved.push(Object.assign({}, sug, { resolvedIds: [rootNode.id] }));
      continue;
    }

    if (id === "__STAR_CHILDREN__" || id.toLowerCase().includes("star")) {
      if ("findAll" in rootNode) {
        const stars = rootNode.findAll((n) =>
          n.name.toLowerCase().includes("star") ||
          n.name.toLowerCase().includes("vector") ||
          n.name.toLowerCase().includes("icon")
        );
        if (stars.length > 0) {
          resolved.push(Object.assign({}, sug, { resolvedIds: stars.map((n) => n.id) }));
          continue;
        }
      }
      if ("children" in rootNode && rootNode.children.length > 0) {
        resolved.push(Object.assign({}, sug, { resolvedIds: rootNode.children.map((c) => c.id) }));
        continue;
      }
    }

    const keyLower = id.toLowerCase().replace(/-/g, " ").replace(/_/g, " ");
    if ("findAll" in rootNode) {
      const matches = rootNode.findAll((n) => {
        const nLower = n.name.toLowerCase().replace(/-/g, " ").replace(/_/g, " ");
        return nLower.includes(keyLower) || keyLower.includes(nLower);
      });
      if (matches.length > 0) {
        resolved.push(Object.assign({}, sug, { resolvedIds: matches.map((n) => n.id) }));
        continue;
      }
    }

    resolved.push(Object.assign({}, sug, { resolvedIds: [rootNode.id] }));
  }

  return resolved;
}

// ─── Documentation frame (copy mode) ─────────────────────────────────────────
// Creates an annotation frame beside the component containing a readable ARIA
// summary. This is NOT a new component — it is purely a documentation artifact.

async function createDocFrame(rootNode, issues, ariaSchemaStr, componentType) {
  const box = rootNode.absoluteBoundingBox;
  if (!box) return null;

  await ensureLabelFonts();

  const frame = figma.createFrame();
  frame.name  = "A11y_Doc_" + rootNode.name;
  frame.x     = box.x + box.width + 48;
  frame.y     = box.y;
  frame.fills = [{ type: "SOLID", color: { r: 0.08, g: 0.08, b: 0.10 } }];
  frame.strokes = [{ type: "SOLID", color: { r: 0.26, g: 0.26, b: 0.46 } }];
  frame.strokeWeight = 1;
  frame.cornerRadius = 10;
  frame.layoutMode  = "VERTICAL";
  frame.paddingTop  = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = 16;
  frame.itemSpacing = 10;
  frame.primaryAxisSizingMode   = "AUTO";
  frame.counterAxisSizingMode   = "FIXED";
  frame.resize(340, frame.height);

  function addText(content, size, weight, colorHex) {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: weight >= 600 ? "Semi Bold" : "Regular" };
    t.characters = content;
    t.fontSize   = size;
    t.fills      = [{ type: "SOLID", color: colorHex }];
    t.textAutoResize = "HEIGHT";
    t.resize(308, t.height);
    frame.appendChild(t);
    return t;
  }

  // Header
  addText("A11y Shift — Dev Annotations", 11, 600, { r: 0.53, g: 0.64, b: 1.0 });
  addText("Component: " + componentType, 13, 600, { r: 0.94, g: 0.94, b: 0.94 });

  // Issues summary
  var highIss = issues.filter(function(x) { return x.severity === "HIGH";   });
  var medIss  = issues.filter(function(x) { return x.severity === "MED";    });
  var manIss  = issues.filter(function(x) { return x.severity === "MANUAL"; });

  if (issues.length === 0) {
    addText("✅  All automated audits passed", 12, 400, { r: 0.24, g: 0.81, b: 0.56 });
  } else {
    var summary = [];
    if (highIss.length) summary.push(highIss.length + " BLOCK");
    if (medIss.length)  summary.push(medIss.length  + " WARN");
    if (manIss.length)  summary.push(manIss.length  + " MANUAL");
    addText("⚠  " + summary.join("  ·  "), 12, 600, { r: 0.96, g: 0.62, b: 0.07 });
    for (var idx = 0; idx < Math.min(issues.length, 6); idx++) {
      var iss = issues[idx];
      var prefix = iss.severity === "HIGH" ? "❌" : (iss.severity === "MANUAL" ? "🔍" : "⚠️");
      addText(prefix + "  " + iss.message.slice(0, 90), 11, 400, { r: 0.9, g: 0.9, b: 0.9 });
    }
    if (issues.length > 6) {
      addText("… and " + (issues.length - 6) + " more — see plugin for full list", 10, 400, { r: 0.6, g: 0.6, b: 0.6 });
    }
  }

  // ARIA Schema
  if (ariaSchemaStr) {
    addText("ARIA Schema:", 11, 600, { r: 0.53, g: 0.64, b: 1.0 });
    addText(ariaSchemaStr.slice(0, 600), 10, 400, { r: 0.78, g: 0.78, b: 0.78 });
  }

  // Footer
  addText("Source: A11y Shift plugin  ·  WCAG 2.2 AA  ·  ARIA APG", 9, 400, { r: 0.4, g: 0.4, b: 0.4 });

  // Place in the same parent as the component
  if (rootNode.parent && rootNode.parent.type !== "PAGE") {
    rootNode.parent.appendChild(frame);
  }

  return frame.id;
}

// ─── Apply fixes ──────────────────────────────────────────────────────────────
// mode: "inplace"  → mutate original component (all mutations in one undo group)
// mode: "copy"     → clone component 120px right, apply fixes to clone only
// mode: "annotate" → only write pluginData / sharedPluginData — no renames, no visual changes

async function applyFixes(suggestions, rootNodeId, mode, annotationDestination) {
  mode = mode || "inplace";
  const rootNode = await getNodeById(rootNodeId);
  if (!rootNode) {
    return { applied: 0, skipped: (suggestions || []).length, details: ["Root node not found — did the selection change?"] };
  }
  let dest = annotationDestination || await getAnnotationDestination();
  if (dest === "ask") dest = "devmode";

  let targetNode         = rootNode;
  let reviewIndicatorId  = null;

  // ── Copy mode: clone the component then apply fixes to the clone only
  if (mode === "copy") {
    const clone = rootNode.clone();
    clone.name  = rootNode.name + " \u2014 a11y copy";

    // Position 120px to the right of the original
    const origBox = rootNode.absoluteBoundingBox;
    if (origBox) {
      clone.x = rootNode.x + rootNode.width + 120;
      clone.y = rootNode.y;
    } else {
      clone.x = rootNode.x + 120;
    }

    // Append into the same parent frame/group as the original
    if (rootNode.parent && rootNode.parent.type !== "PAGE" && rootNode.parent.type !== "DOCUMENT") {
      rootNode.parent.appendChild(clone);
    } else {
      figma.currentPage.appendChild(clone);
    }

    // Green review indicator — a borderless rectangle around the clone
    const indicator  = figma.createRectangle();
    indicator.name   = "A11y Review";
    const cloneBox   = clone.absoluteBoundingBox;
    if (cloneBox) {
      indicator.x = cloneBox.x - 4; indicator.y = cloneBox.y - 4;
      indicator.resize(cloneBox.width + 8, cloneBox.height + 8);
    } else {
      indicator.x = clone.x - 4; indicator.y = clone.y - 4;
      indicator.resize((clone.width || 100) + 8, (clone.height || 40) + 8);
    }
    indicator.fills        = [];
    indicator.strokes      = [{ type: "SOLID", color: { r: 0.102, g: 0.498, b: 0.294 } }]; // #1A7F4B
    indicator.strokeWeight = 2;
    indicator.cornerRadius = 4;
    if (clone.parent) { clone.parent.appendChild(indicator); }
    else              { figma.currentPage.appendChild(indicator); }

    reviewIndicatorId = indicator.id;
    targetNode = clone;
    await copyA11yHeadingsToClone(rootNode, clone);
  }

  // ── Annotate mode: only write data keys, never rename or change visuals
  const filteredSugs = mode === "annotate"
    ? (suggestions || []).filter(function(s) { return s.type === "setPluginData"; })
    : (suggestions || []);

  const resolved = await resolveSuggestions(filteredSugs, targetNode);
  let applied = 0, skipped = 0;
  const details = [];
  let wroteDevMarkup = false;
  let renamedLayer = false;
  let addedLabel = false;

  function pushDesignerDetail(line) {
    if (details.indexOf(line) < 0) details.push(line);
  }

  for (let si = 0; si < resolved.length; si++) {
    const sug = resolved[si];
    for (let ni = 0; ni < sug.resolvedIds.length; ni++) {
      const nodeId = sug.resolvedIds[ni];
      const node   = await getNodeById(nodeId);
      if (!node) { skipped++; continue; }

      try {
        if (sug.type === "rename") {
          node.name = sug.value;
          applied++;
          renamedLayer = true;
          pushDesignerDetail("\u2713 Layer renamed to " + sug.value);
        } else if (sug.type === "setPluginData") {
          const dataKey  = sug.key || "a11y.v1.componentType";
          node.setPluginData(dataKey, sug.value);
          const parts    = dataKey.split(".");
          const shortKey = parts[parts.length - 1];
          const sharedKey = SHARED_A11Y_KEY_MAP[shortKey] || shortKey.replace(/([A-Z])/g, function(m) {
            return "-" + m.toLowerCase();
          });
          await writeA11yAnnotation(node, sharedKey, sug.value, dest);
          applied++;
          if (/aria|componenttype|wcag|schema|states/i.test(dataKey)) {
            wroteDevMarkup = true;
          }
        }
      } catch (e) {
        skipped++;
      }
    }
  }

  if (wroteDevMarkup) {
    pushDesignerDetail("\u2713 Accessibility markup written to Dev Mode");
    pushDesignerDetail("Developers can see ARIA code by selecting this layer in Dev Mode \u2192 Code tab \u2192 A11y Shift");
  }
  if (renamedLayer && !wroteDevMarkup && details.length === 0) {
    pushDesignerDetail("\u2713 Layer updated");
  }

  return {
    applied: applied,
    skipped: skipped,
    details: details,
    reviewIndicatorId: reviewIndicatorId,
    devModeCodegen: wroteDevMarkup,
  };
}

// ─── Auto-fix / self-healing ──────────────────────────────────────────────────
// Section 9 of the rules: never block — first attempt repair, then ask designer.
//
// Architecture:
//   1. AUTO_FIX_HANDLERS — keyed by issue code. Each handler mutates the node
//      and re-runs the failing audit to verify the issue is resolved.
//   2. autoFixIssue() — wraps the handler in figma.commitUndo() so a single
//      Cmd+Z reverts every change made by the fix.
//   3. "prompt" strategy returns canonical instruction text for the user to
//      paste into Figma's built-in AI assistant — we never touch the clipboard
//      from the main thread (sandbox restriction).
//
// Output contract for every handler:
//   { ok, code, source, message, createdNodeId?, mutatedNodeIds? }

async function callAILabel(params) {
  // params: { apiKey, systemPrompt, userPrompt, maxTokens }
  // Returns short label string (≤60 chars). Throws on network/key error.
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + params.apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: params.maxTokens || 20,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user",   content: params.userPrompt   },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("OpenAI " + resp.status + ": " + err.slice(0, 200));
  }
  const data = await resp.json();
  const raw  = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return raw.trim().replace(/^["'\u201C\u2018]+|["'\u201D\u2019.]+$/g, "").slice(0, 60);
}

function collectOptionTexts(node) {
  if (!node || !("findAllWithCriteria" in node)) return [];
  const texts = node.findAllWithCriteria({ types: ["TEXT"] });
  const out   = [];
  const seen  = {};
  for (let i = 0; i < texts.length && out.length < 12; i++) {
    const t = (texts[i].characters || "").trim();
    if (!t || seen[t]) continue;
    seen[t] = true;
    out.push(t);
  }
  return out;
}

async function loadInter(style) {
  try {
    await figma.loadFontAsync({ family: "Inter", style: style || "Regular" });
    return { family: "Inter", style: style || "Regular" };
  } catch (_e) {
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      return { family: "Inter", style: "Regular" };
    } catch (_e2) {
      try {
        await figma.loadFontAsync({ family: "Roboto", style: "Regular" });
        return { family: "Roboto", style: "Regular" };
      } catch (_e3) {
        return null;
      }
    }
  }
}

async function ensureLabelFonts() {
  await loadInter("Regular");
  await loadInter("Medium");
}

// Base name for wrappers/tags — COMPONENT_SET name, not variant instance name.
async function getCleanComponentBaseName(node) {
  if (!node) return "component";
  let baseName = node.name || "component";

  if (node.type === "INSTANCE") {
    const master = await getMainComponent(node);
    if (master) {
      const set = master.parent && master.parent.type === "COMPONENT_SET" ? master.parent : null;
      baseName = (set && set.name) ? set.name : master.name;
    }
  } else if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
    baseName = node.parent.name;
  }

  let clean = String(baseName).split("=")[0].split("/")[0].trim();
  if (clean.indexOf(",") >= 0) clean = clean.split(",")[0].trim();
  return clean || "component";
}

function inferLabelStyleFromContext(ctx, referenceNode) {
  const style = { fontSize: 14, color: { r: 0.12, g: 0.12, b: 0.12 }, fontName: null };
  if (referenceNode && referenceNode.parent && "children" in referenceNode.parent) {
    const siblings = referenceNode.parent.children;
    for (let si = 0; si < siblings.length; si++) {
      const sib = siblings[si];
      if (sib === referenceNode || sib.type !== "TEXT") continue;
      if ("fontSize" in sib && typeof sib.fontSize === "number") style.fontSize = sib.fontSize;
      if (sib.fills && sib.fills[0] && sib.fills[0].type === "SOLID") style.color = sib.fills[0].color;
      if (sib.fontName && sib.fontName !== figma.mixed) {
        const fam = String(sib.fontName.family || "").toLowerCase();
        if (fam.indexOf("inter") >= 0 || fam.indexOf("roboto") >= 0) style.fontName = sib.fontName;
      }
      return style;
    }
  }
  return style;
}

async function createFloatingA11yLabel(node, labelText, layerName) {
  await ensureLabelFonts();
  const fontName = await loadInter("Medium");
  const label = figma.createText();
  if (fontName) label.fontName = fontName;
  label.characters = labelText;
  label.fontSize = 14;
  label.fills = [{ type: "SOLID", color: { r: 0.12, g: 0.12, b: 0.12 } }];
  label.name = (layerName || "label") + " / _a11y_heading";
  label.setPluginData("a11y.generated", "true");
  if (node) {
    label.x = node.x;
    label.y = node.y - 22;
    label.setPluginData("a11y.labelFor", node.id);
  }
  if (node && node.parent && "insertChild" in node.parent) {
    const idx = node.parent.children.indexOf(node);
    node.parent.insertChild(idx >= 0 ? idx : 0, label);
  } else {
    figma.currentPage.appendChild(label);
  }
  return { label: label };
}

async function wrapNodeWithA11yLabel(node, labelText, layerName, ctx) {
  if (!node || !("parent" in node) || !node.parent) {
    return createFloatingA11yLabel(node, labelText, layerName);
  }
  const parent = node.parent;
  const idx = parent && "children" in parent ? parent.children.indexOf(node) : -1;
  const absX = node.x;
  const absY = node.y;

  const wrapper = figma.createFrame();
  const cleanName = await getCleanComponentBaseName(node);
  wrapper.name = "_a11y_labeled_" + cleanName;
  wrapper.layoutMode = "VERTICAL";
  wrapper.itemSpacing = 4;
  wrapper.primaryAxisSizingMode = "AUTO";
  wrapper.counterAxisSizingMode = "AUTO";
  wrapper.fills = [];
  wrapper.clipsContent = false;
  wrapper.x = absX;
  wrapper.y = absY;

  await ensureLabelFonts();
  const style = inferLabelStyleFromContext(ctx, node);
  const fontName = style.fontName || await loadInter("Medium");
  const label = figma.createText();
  if (fontName) label.fontName = fontName;
  label.characters = labelText;
  label.fontSize = style.fontSize;
  label.fills = [{ type: "SOLID", color: style.color }];
  const baseName = layerName || "label";
  label.name = baseName.indexOf("_a11y_heading") >= 0 ? baseName : baseName + " / _a11y_heading";
  label.setPluginData("a11y.generated", "true");
  label.setPluginData("a11y.labelFor", node.id);

  if (parent && idx >= 0 && "insertChild" in parent) {
    parent.insertChild(idx, wrapper);
  } else {
    figma.currentPage.appendChild(wrapper);
  }
  wrapper.appendChild(label);
  wrapper.appendChild(node);
  return { wrapper: wrapper, label: label };
}

async function placeLabelAbove(node, labelText, layerName) {
  const ctx = await gatherContext(node);
  const wrapped = await wrapNodeWithA11yLabel(node, labelText, layerName, ctx);
  return wrapped.label || wrapped;
}

// Re-run a single audit by name and check whether the given issue code is gone.
function reauditIsResolved(node, ctx, spec, auditName, issueCode) {
  const fn = AUDIT_FUNCTIONS[auditName];
  if (!fn) return true; // unknown audit — assume resolved
  try {
    const issues = fn(node, spec || { role: "group", requiredStates: [] }, ctx) || [];
    for (let i = 0; i < issues.length; i++) {
      if (issues[i].code === issueCode) return false;
    }
    return true;
  } catch (_e) { return true; }
}

// Clipboard prompt — Figma AI must get node ID, layer name, current values, exact action.
function buildContrastClipboardPrompt(node) {
  const metrics = getTextContrastMetrics(node);
  if (!metrics) {
    return "Fix contrast on text node [" + node.id + '] named "' + node.name + '". ' +
           "Action: Set a solid text fill that meets WCAG AA contrast against its background.";
  }
  const textHex = rgbToHex255(metrics.perceived.r, metrics.perceived.g, metrics.perceived.b);
  const bgHex   = rgbToHex255(metrics.bg.r, metrics.bg.g, metrics.bg.b);
  return (
    "Fix contrast on text node [" + node.id + '] named "' + node.name + "\".\n" +
    "Current text color: " + textHex + "\n" +
    "Background color: " + bgHex + "\n" +
    "Current ratio: " + metrics.ratio.toFixed(1) + ":1\n" +
    "Required: " + metrics.required + ":1 (WCAG AA " + (metrics.large ? "large" : "normal") + " text)\n" +
    "Action: Adjust the text fill color to meet " + metrics.required +
    ":1 minimum contrast against the background. Prefer darkening/lightening the existing hue rather than changing it."
  );
}

function buildClipboardPrompt(issueCode, node, rootNode) {
  const target   = node || rootNode;
  const root     = rootNode || node;
  const nodeId   = target.id;
  const nodeName = target.name || "layer";
  const optionTexts = collectOptionTexts(root).join(", ");

  switch (issueCode) {
    case "CONTRAST_TEXT_FAIL":
    case "LOW_CONTRAST":
    case "CONTRAST_FAIL":
      return target.type === "TEXT" ? buildContrastClipboardPrompt(target) : (
        "Fix contrast on node [" + nodeId + '] named "' + nodeName + '". ' +
        "Action: Select the failing TEXT child and adjust its fill to meet WCAG AA contrast."
      );
    case "NO_GROUP_LABEL":
      return "Add an accessible group label on node [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Options in group: " + (optionTexts || "(none)") + ".\n" +
             "Action: Create a text layer above the group, name it 'label / group-label', match font family, left-align.";
    case "NO_INPUT_LABEL":
      return "Add a visible label for text input [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Create a persistent text layer above the input named 'label / input-label' (not placeholder-only).";
    case "ICON_BUTTON_NO_LABEL":
      return "Add accessible name to icon button [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Current state: no visible label text and no aria-label in plugin data.\n" +
             "Action: Add visible label text OR set a11y.ariaLabel plugin data (3–6 words, verb-first).";
    case "NO_ERROR_STATE":
      return "Add error state variant to component [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Duplicate default variant, add red border + error icon + error message text (not color-only).";
    case "MISSING_STATE_FOCUS":
    case "MISSING_FOCUS_RING":
      return "Add focus variant to component [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Duplicate default variant; add 2px #4DA3FF outline, 2px offset, ≥3:1 contrast vs background.";
    case "MISSING_STATE_DISABLED":
      return "Add disabled variant to component [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Duplicate default variant; set opacity ~40%; ensure non-interactive affordance.";
    case "DIALOG_NO_CLOSE":
      return "Add close control to dialog [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Place icon button top-right named 'button / close' with aria-label 'Close dialog'.";
    case "DIALOG_NO_HEADING":
      return "Add heading to [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Create visible heading text layer 'heading / title' with correct aria-level (1–6).";
    case "ACCORDION_NO_HEADING":
      return "Add accessible name to accordion [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Set aria-label on root via Dev Mode handoff (setSharedPluginData \"a11y\" \"aria-label\").";
    case "ACCORDION_HEADER_NOT_BUTTON":
      return "Annotate accordion row triggers on [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Set aria-role=button on each direct row child via setSharedPluginData.";
    case "TOUCH_TARGET_SMALL":
    case "TOUCH_TARGET_CRITICAL":
      return "Increase touch target for [" + nodeId + '] named "' + nodeName + "\".\n" +
             "Current issue: below 44×44px minimum (WCAG 2.5.5).\n" +
             "Action: Wrap in auto-layout frame with min 44×44px or resize the interactive area.";
    default:
      return "Fix accessibility issue '" + issueCode + '" on node [' + nodeId + '] named "' + nodeName + "\".\n" +
             "Action: Apply the WCAG 2.2 AA fix for this specific issue on this layer (do not generic-review).";
  }
}

// ── Per-issue handlers ──

async function fixNoGroupLabel(p) {
  await ensureLabelFonts();
  const options = collectOptionTexts(p.rootNode).join(", ").slice(0, 800);
  const roleHint = p.detectedRole || (p.rootNode && p.rootNode.getPluginData && p.rootNode.getPluginData("a11y.v1.componentType")) || "radio-group";
  let labelText = getDefaultHeadingText(roleHint);
  let source    = "generic";
  if (p.strategy === "ai" && p.apiKey) {
    try {
      const ai = await callAILabel({
        apiKey:       p.apiKey,
        maxTokens:    20,
        systemPrompt: "You write short ARIA group labels for UI components. Return label text only, 3-6 words. No quotes.",
        userPrompt:   "Radio/checkbox group with options: " + options + ". Write the group label.",
      });
      if (ai && ai.length > 0 && ai.length <= 60) { labelText = ai; source = "ai"; }
    } catch (_e) { /* fall through to generic */ }
  }
  const ctx = await gatherContext(p.rootNode);
  const wrapped = await wrapNodeWithA11yLabel(p.rootNode, labelText, "label / group-label", ctx);
  const label = wrapped.label;

  const ctx2     = ctx;
  const resolved = reauditIsResolved(p.rootNode, ctx2, { role: "group", requiredStates: [] }, "hasGroupLabel", "NO_GROUP_LABEL");

  return {
    ok:            resolved,
    code:          "NO_GROUP_LABEL",
    source:        source,
    labelText:     labelText,
    createdNodeId: label.id,
    message:       resolved
      ? "Added label \u201C" + labelText + "\u201D in auto-layout wrapper"
      : "Label created but audit still flags it \u2014 verify alignment",
  };
}

async function fixNoInputLabel(p) {
  await ensureLabelFonts();
  let labelText = "Label";
  let source    = "generic";
  // Use the node name as a fallback hint (strip role prefixes)
  const baseName = (p.rootNode.name || "field").replace(/^(input|textfield|text-input|text)[\s\/_-]*/i, "").trim() || "field";

  if (p.strategy === "ai" && p.apiKey) {
    try {
      const ai = await callAILabel({
        apiKey:       p.apiKey,
        maxTokens:    20,
        systemPrompt: "You write short visible labels for form text inputs. Return label text only, 1-3 words, title case. No quotes.",
        userPrompt:   "Text input named \"" + baseName + "\". Write a visible label.",
      });
      if (ai && ai.length > 0 && ai.length <= 60) { labelText = ai; source = "ai"; }
    } catch (_e) {}
  }
  if (source === "generic") {
    labelText = baseName.charAt(0).toUpperCase() + baseName.slice(1);
  }

  const ctx = await gatherContext(p.rootNode);
  const wrapped = await wrapNodeWithA11yLabel(p.rootNode, labelText, "label / input-label", ctx);
  const label = wrapped.label;
  const ctx2      = ctx;
  const resolved = reauditIsResolved(p.rootNode, ctx2, { role: "textField", requiredStates: [] }, "hasInputLabel", "NO_INPUT_LABEL");

  return {
    ok:            resolved,
    code:          "NO_INPUT_LABEL",
    source:        source,
    labelText:     labelText,
    createdNodeId: label.id,
    message:       resolved ? "Added label \u201C" + labelText + "\u201D" : "Label created but audit still flags it",
  };
}

async function fixIconButtonNoLabel(p) {
  // Cannot create a visible label for an icon-only button without knowing intent —
  // write a best-effort aria-label to pluginData so the dev can refine it.
  let labelText = (p.rootNode.name || "Button").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Button";
  let source    = "generic";

  if (p.strategy === "ai" && p.apiKey) {
    try {
      const ai = await callAILabel({
        apiKey:       p.apiKey,
        maxTokens:    20,
        systemPrompt: "You write short ARIA labels for icon-only buttons. Return label text only, 2-5 words, verb-first when possible. No quotes.",
        userPrompt:   "Icon-only button named \"" + p.rootNode.name + "\". Write the aria-label.",
      });
      if (ai && ai.length > 0 && ai.length <= 60) { labelText = ai; source = "ai"; }
    } catch (_e) {}
  }

  p.rootNode.setPluginData("a11y.v1.ariaLabel", labelText);
  setSharedA11y(p.rootNode, "aria-label", labelText);

  return {
    ok:        true, // setPluginData always succeeds; the visual audit will still flag the missing text
    code:      "ICON_BUTTON_NO_LABEL",
    source:    source,
    labelText: labelText,
    message:   "Set aria-label to \u201C" + labelText + "\u201D in plugin data (visible in Dev Mode)",
  };
}

async function fixMissingFocusState(p) {
  // Only meaningful for COMPONENT_SET — duplicate default and add a focus stroke
  if (p.rootNode.type !== "COMPONENT_SET") {
    return { ok: false, code: "MISSING_STATE_FOCUS", message: "Focus variant requires a Component Set with variants." };
  }
  const stateMap   = await findStateVariantsAsync(p.rootNode);
  const defaultVar = stateMap["default"] || stateMap["rest"] || p.rootNode.children[0];
  if (!defaultVar) return { ok: false, code: "MISSING_STATE_FOCUS", message: "Could not find a default variant to duplicate." };

  const clone = defaultVar.clone();
  // Rename to declare the State property as Focus. Figma parses "State=Focus" segments.
  clone.name = "State=Focus";
  clone.strokes      = [{ type: "SOLID", color: { r: 0.302, g: 0.639, b: 1.0 } }]; // #4DA3FF
  clone.strokeWeight = 2;
  if ("strokeAlign" in clone) clone.strokeAlign = "OUTSIDE";
  p.rootNode.appendChild(clone);

  return { ok: true, code: "MISSING_STATE_FOCUS", source: "generic", createdNodeId: clone.id,
           message: "Added Focus variant with 2px #4DA3FF outline" };
}

async function fixMissingDisabledState(p) {
  if (p.rootNode.type !== "COMPONENT_SET") {
    return { ok: false, code: "MISSING_STATE_DISABLED", message: "Disabled variant requires a Component Set." };
  }
  const stateMap   = await findStateVariantsAsync(p.rootNode);
  const defaultVar = stateMap["default"] || stateMap["rest"] || p.rootNode.children[0];
  if (!defaultVar) return { ok: false, code: "MISSING_STATE_DISABLED", message: "Could not find a default variant to duplicate." };

  const clone     = defaultVar.clone();
  clone.name      = "State=Disabled";
  clone.opacity   = 0.4;
  p.rootNode.appendChild(clone);
  return { ok: true, code: "MISSING_STATE_DISABLED", source: "generic", createdNodeId: clone.id,
           message: "Added Disabled variant at 40% opacity" };
}

async function fixTouchTargetSmall(p) {
  // Wrap the component in an auto-layout frame sized to 44×44 minimum
  const box = p.rootNode.absoluteBoundingBox;
  if (!box) return { ok: false, code: "TOUCH_TARGET_SMALL", message: "Cannot read bounding box." };
  const w = box.width, h = box.height;
  if (w >= 44 && h >= 44) return { ok: true, code: "TOUCH_TARGET_SMALL", message: "Already meets 44×44px." };

  const padX = Math.max(0, Math.ceil((44 - w) / 2));
  const padY = Math.max(0, Math.ceil((44 - h) / 2));

  const wrapper = figma.createFrame();
  wrapper.name             = p.rootNode.name + " / hit-target";
  wrapper.fills            = [];
  wrapper.layoutMode       = "HORIZONTAL";
  wrapper.primaryAxisAlignItems = "CENTER";
  wrapper.counterAxisAlignItems = "CENTER";
  wrapper.paddingLeft  = padX; wrapper.paddingRight  = padX;
  wrapper.paddingTop   = padY; wrapper.paddingBottom = padY;
  wrapper.x = p.rootNode.x - padX;
  wrapper.y = p.rootNode.y - padY;

  const parent = p.rootNode.parent;
  const idx    = parent && "children" in parent ? parent.children.indexOf(p.rootNode) : -1;
  if (parent && "appendChild" in parent) parent.appendChild(wrapper);
  else figma.currentPage.appendChild(wrapper);
  wrapper.appendChild(p.rootNode);
  // Place wrapper back at original index when possible
  if (idx >= 0 && parent && "insertChild" in parent) {
    try { parent.insertChild(idx, wrapper); } catch (_e) {}
  }

  return { ok: true, code: "TOUCH_TARGET_SMALL", source: "generic", createdNodeId: wrapper.id,
           message: "Wrapped in 44×44 hit-target frame (padX " + padX + ", padY " + padY + ")" };
}

async function fixDialogNoClose(p) {
  // Add a small "✕" text node positioned at the top-right corner of the dialog
  await loadInter("Medium");
  const closeBtn = figma.createText();
  try { closeBtn.fontName = { family: "Inter", style: "Medium" }; } catch (_e) {}
  closeBtn.characters = "\u2715"; // ✕
  closeBtn.fontSize   = 18;
  closeBtn.fills      = [{ type: "SOLID", color: { r: 0.36, g: 0.36, b: 0.36 } }];
  const box = p.rootNode.absoluteBoundingBox;
  if (box) {
    closeBtn.x = p.rootNode.x + p.rootNode.width  - 32;
    closeBtn.y = p.rootNode.y + 12;
  } else {
    closeBtn.x = p.rootNode.x; closeBtn.y = p.rootNode.y;
  }
  closeBtn.name = "button / close";
  closeBtn.setPluginData("a11y.v1.ariaLabel",   "Close dialog");
  closeBtn.setPluginData("a11y.v1.componentType", "button");
  setSharedA11y(closeBtn, "aria-label", "Close dialog");
  if (p.rootNode.parent && "appendChild" in p.rootNode.parent) p.rootNode.parent.appendChild(closeBtn);
  else figma.currentPage.appendChild(closeBtn);

  return { ok: true, code: "DIALOG_NO_CLOSE", source: "generic", createdNodeId: closeBtn.id,
           message: "Added \u2715 close button at top-right" };
}

async function fixDialogNoHeading(p) {
  let headingText = "Dialog title";
  let source = "generic";
  if (p.strategy === "ai" && p.apiKey) {
    try {
      const innerTexts = collectOptionTexts(p.rootNode).slice(0, 6).join(" | ").slice(0, 800);
      const ai = await callAILabel({
        apiKey:       p.apiKey,
        maxTokens:    20,
        systemPrompt: "You write short dialog headings. Return heading text only, 2-6 words, title case. No quotes.",
        userPrompt:   "Dialog content includes: " + innerTexts + ". Write a heading.",
      });
      if (ai && ai.length > 0 && ai.length <= 60) { headingText = ai; source = "ai"; }
    } catch (_e) {}
  }

  const ctx = await gatherContext(p.rootNode);
  const wrapped = await wrapNodeWithA11yLabel(p.rootNode, headingText, "heading / dialog-title", ctx);
  const heading = wrapped.label;
  await loadInter("Bold");
  try { heading.fontName = { family: "Inter", style: "Bold" }; } catch (_e) {}
  heading.fontSize = 18;
  heading.fills = [{ type: "SOLID", color: { r: 0.12, g: 0.12, b: 0.12 } }];
  heading.name = "heading / dialog-title / _a11y_heading";
  heading.setPluginData("a11y.v1.ariaLevel", "2");
  return { ok: true, code: "DIALOG_NO_HEADING", source: source, labelText: headingText, createdNodeId: heading.id,
           message: "Added heading \u201C" + headingText + "\u201D in labeled wrapper" };
}

// ─── fixNonComponentElement — semantic component builders (11 types) ─────────

// One NON_COMPONENT fix per scanned root per plugin session (prevents duplicate ComponentSets).
var processedNonComponentNodeIds = new Set();

var NC_BRAND = { r: 0.2, g: 0.4, b: 1 };
var NC_GRAY = { r: 0.7, g: 0.7, b: 0.7 };
var NC_TEXT_DARK = { r: 0.1, g: 0.1, b: 0.1 };
var NC_ERROR = { r: 0.8, g: 0.1, b: 0.1 };
var NC_MASTER_OFFSET_X = 4000;

var COMPONENT_SEMANTIC_DESC = {
  button:      "Role: button\nStates: Default | Hover | Focus | Disabled\nHTML element: <button type=\"button\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/button/",
  textField:   "Role: textbox\nStates: Default | Hover | Focus | Disabled | Error\nRequired: True | False\nHTML element: <input type=\"text\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/textbox/",
  checkbox:    "Role: checkbox\nStates: Default | Hover | Focus | Disabled\nChecked: True | False\nHTML element: <input type=\"checkbox\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/",
  "radio-group":"Role: radiogroup > radio\nStates: Default | Hover | Focus | Disabled\nSelected: True | False\nHTML element: <fieldset><legend> + <input type=\"radio\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
  select:      "Role: combobox > listbox > option\nStates: Default | Hover | Focus | Disabled\nOpen: True | False\nHTML element: <select> or custom combobox\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/",
  modal:       "Role: dialog\nStates: Default\nHTML element: <dialog> or role=\"dialog\"\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
  tabs:        "Role: tablist > tab + tabpanel\nStates: Default | Hover | Focus | Disabled\nSelected: True | False\nHTML element: role=\"tablist\" / role=\"tab\" / role=\"tabpanel\"\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/",
  slider:      "Role: slider\nStates: Default | Hover | Focus | Disabled\nARIA attributes: aria-valuemin, aria-valuemax, aria-valuenow\nHTML element: <input type=\"range\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/slider/",
  "star-rating":"Role: radiogroup > radio (one per star)\nStates: Default | Hover | Focus | Disabled\nValue: 1 | 2 | 3 | 4 | 5\nHTML element: role=\"radiogroup\" + role=\"radio\" per star\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
  toggle:      "Role: switch\nStates: Default | Hover | Focus | Disabled\nChecked: True | False\nHTML element: <button role=\"switch\" aria-checked=\"true|false\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/switch/",
  accordion:   "Role: button (trigger) + region (panel)\nStates: Default | Hover | Focus | Disabled\nExpanded: True | False\nHTML element: <button aria-expanded> + <div role=\"region\">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/accordion/",
};

var COMPONENT_VARIANTS = {
  button:        ["State=Default", "State=Hover", "State=Focus", "State=Disabled"],
  textField:     ["State=Default", "State=Hover", "State=Focus", "State=Disabled", "State=Error"],
  checkbox:      ["State=Default,Checked=False", "State=Default,Checked=True", "State=Focus,Checked=False", "State=Focus,Checked=True", "State=Disabled,Checked=False"],
  "radio-group": ["State=Default,Selected=False", "State=Default,Selected=True", "State=Focus,Selected=False", "State=Focus,Selected=True", "State=Disabled,Selected=False"],
  select:        ["State=Default,Open=False", "State=Focus,Open=False", "State=Default,Open=True", "State=Disabled,Open=False"],
  modal:         ["State=Default"],
  tabs:          ["State=Default,Selected=True", "State=Default,Selected=False", "State=Focus,Selected=True", "State=Disabled,Selected=False"],
  slider:        ["State=Default", "State=Hover", "State=Focus", "State=Disabled"],
  "star-rating": ["State=Default,Value=1", "State=Default,Value=2", "State=Default,Value=3", "State=Default,Value=4", "State=Default,Value=5", "State=Focus,Value=3", "State=Disabled,Value=3"],
  toggle:        ["State=Default,Checked=False", "State=Default,Checked=True", "State=Focus,Checked=False", "State=Focus,Checked=True", "State=Disabled,Checked=False"],
  accordion:     ["State=Default,Expanded=False", "State=Default,Expanded=True", "State=Focus,Expanded=False", "State=Focus,Expanded=True", "State=Disabled,Expanded=False"],
};

function ncSolid(color, opacity) {
  return [{ type: "SOLID", color: color, opacity: opacity !== undefined ? opacity : 1 }];
}

function ncFocusShadow() {
  return [{
    type: "DROP_SHADOW",
    color: { r: NC_BRAND.r, g: NC_BRAND.g, b: NC_BRAND.b, a: 0.4 },
    offset: { x: 0, y: 0 },
    radius: 4,
    spread: 2,
    visible: true,
    blendMode: "NORMAL",
  }];
}

function extractLabelText(node) {
  if (!node) return null;
  if (node.type === "TEXT") {
    const c = (node.characters || "").trim();
    return c || null;
  }
  if ("children" in node) {
    for (let i = 0; i < node.children.length; i++) {
      const t = extractLabelText(node.children[i]);
      if (t) return t;
    }
  }
  return null;
}

function ncNodeSize(node) {
  const w = (node && node.width) || 120;
  const h = (node && node.height) || 44;
  const box = node && node.absoluteBoundingBox;
  return {
    width:  box ? box.width  : w,
    height: box ? box.height : h,
    x:      box ? box.x      : (node.x || 0),
    y:      box ? box.y      : (node.y || 0),
  };
}

function ncMasterXY(node) {
  const t = node.absoluteTransform;
  const x = (t && t[0]) ? t[0][2] + NC_MASTER_OFFSET_X : (node.x || 0) + NC_MASTER_OFFSET_X;
  const y = (t && t[1]) ? t[1][2] : (node.y || 0);
  return { x: x, y: y };
}

async function ncCreateText(name, characters, style, size, color, opacity) {
  const font = await loadInter(style || "Regular");
  const t = figma.createText();
  t.name = name;
  if (font) t.fontName = font;
  t.fontSize = size || 14;
  t.characters = characters || "";
  t.fills = ncSolid(color || NC_TEXT_DARK, opacity);
  return t;
}

async function ncHiddenLabel(characters) {
  const t = await ncCreateText("visually-hidden-label", characters, "Regular", 1, NC_TEXT_DARK, 1);
  try { t.resize(1, 1); } catch (_e) {}
  return t;
}

function ncFrame(name, opts) {
  opts = opts || {};
  const f = figma.createFrame();
  f.name = name;
  if (opts.layoutMode) f.layoutMode = opts.layoutMode;
  if (opts.itemSpacing !== undefined) f.itemSpacing = opts.itemSpacing;
  if (opts.paddingTop !== undefined) f.paddingTop = opts.paddingTop;
  if (opts.paddingBottom !== undefined) f.paddingBottom = opts.paddingBottom;
  if (opts.paddingLeft !== undefined) f.paddingLeft = opts.paddingLeft;
  if (opts.paddingRight !== undefined) f.paddingRight = opts.paddingRight;
  if (opts.primaryAxisAlignItems) f.primaryAxisAlignItems = opts.primaryAxisAlignItems;
  if (opts.counterAxisAlignItems) f.counterAxisAlignItems = opts.counterAxisAlignItems;
  if (opts.cornerRadius !== undefined) f.cornerRadius = opts.cornerRadius;
  if (opts.fills !== undefined) f.fills = opts.fills;
  if (opts.strokes) { f.strokes = opts.strokes; f.strokeWeight = opts.strokeWeight || 1; f.strokeAlign = opts.strokeAlign || "INSIDE"; }
  if (opts.effects) f.effects = opts.effects;
  if (opts.opacity !== undefined) f.opacity = opts.opacity;
  if (opts.resizeW && opts.resizeH) f.resize(opts.resizeW, opts.resizeH);
  if (opts.layoutGrow) f.layoutGrow = 1;
  return f;
}

function classifyNodeForFix(node) {
  if (!node || !("name" in node)) return "unknown";
  const fromRole = normalizeMatrixTypeKey(node.getPluginData && node.getPluginData("a11y.v1.componentType"));
  if (fromRole) return fromRole;
  const fromName = normalizeMatrixTypeKey(node.name || "");
  if (fromName) return fromName;
  const n = (node.name || "").toLowerCase();
  if (n.indexOf("accordion") >= 0 || n.indexOf("faq") >= 0) return "accordion";
  if (n.indexOf("tab") >= 0) return "tabs";
  if (n.indexOf("slider") >= 0 || n.indexOf("range") >= 0) return "slider";
  if (n.indexOf("star") >= 0 || n.indexOf("rating") >= 0) return "star-rating";
  if (n.indexOf("checkbox") >= 0 || n.indexOf("check") >= 0) return "checkbox";
  if (n.indexOf("radio") >= 0) return "radio-group";
  if (n.indexOf("select") >= 0 || n.indexOf("dropdown") >= 0) return "select";
  if (n.indexOf("modal") >= 0 || n.indexOf("dialog") >= 0) return "modal";
  if (n.indexOf("input") >= 0 || n.indexOf("field") >= 0) return "textField";
  if (n.indexOf("switch") >= 0 || n.indexOf("toggle") >= 0) return "toggle";
  return "button";
}

function isUniformChildrenForFix(node) {
  if (!("children" in node) || node.children.length < 2) return false;
  let firstType = null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!isNodeVisible(child) || isA11yGeneratedLayer(child)) continue;
    const t = classifyNodeForFix(child);
    if (t === "unknown") return false;
    if (!firstType) firstType = t;
    else if (t !== firstType) return false;
  }
  return !!firstType;
}

function classifyNode(node) {
  return classifyNodeForFix(node);
}

function isUniformChildren(node) {
  return isUniformChildrenForFix(node);
}

function getNonComponentCapability(node) {
  if (!node || !("name" in node)) return "FIGMA_AI";
  if (node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET") {
    return "AUTO";
  }
  if (isUniformChildren(node)) return "AUTO";
  if (!("children" in node) || visibleChildCount(node) <= 3) return "AUTO";
  return "FIGMA_AI";
}

function isMixedChildrenForFix(node) {
  if (!("children" in node)) return false;
  const seen = {};
  let count = 0;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!isNodeVisible(child) || isA11yGeneratedLayer(child)) continue;
    const t = classifyNodeForFix(child);
    if (!seen[t]) { seen[t] = true; count++; }
  }
  return count > 1;
}

function visibleChildCount(node) {
  if (!("children" in node)) return 0;
  let n = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (isNodeVisible(c) && !isA11yGeneratedLayer(c)) n++;
  }
  return n;
}

async function buildButtonComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isHover = variantName.indexOf("Hover") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Button";

  const comp = ncFrame("button-root", {
    layoutMode: "HORIZONTAL",
    itemSpacing: 8,
    paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24,
    primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
    cornerRadius: 8,
    fills: node.fills && node.fills.length ? JSON.parse(JSON.stringify(node.fills)) : ncSolid(NC_BRAND),
    resizeW: sz.width, resizeH: Math.max(sz.height, 44),
  });
  comp.name = variantName;

  if (isFocus) {
    comp.strokes = ncSolid(NC_BRAND);
    comp.strokeWeight = 2;
    comp.strokeAlign = "OUTSIDE";
  }
  if (isDisabled) comp.opacity = 0.38;

  const label = await ncCreateText("label", labelText, "Medium", 14, { r: 1, g: 1, b: 1 }, isDisabled ? 0.38 : 1);
  comp.appendChild(label);

  const hasVisibleText = labelText.length > 0;
  if (!hasVisibleText) {
    const icon = ncFrame("icon", { resizeW: 16, resizeH: 16, fills: [] });
    comp.insertChild(0, icon);
    comp.appendChild(await ncHiddenLabel("Button"));
  }

  if (isHover && !isDisabled) {
    const fills = comp.fills;
    if (fills && fills[0] && fills[0].type === "SOLID") {
      const c = fills[0].color;
      comp.fills = ncSolid({ r: c.r * 0.9, g: c.g * 0.9, b: c.b * 0.9 });
    }
  }
  return comp;
}

async function buildTextFieldComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isError = variantName.indexOf("Error") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Label";

  const comp = ncFrame("textfield-root", {
    layoutMode: "VERTICAL", itemSpacing: 4, fills: [],
    resizeW: sz.width || 280, resizeH: 80,
  });
  comp.name = variantName;
  comp.counterAxisSizingMode = "FIXED";

  comp.appendChild(await ncCreateText("label", labelText, "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));

  const borderColor = isError ? NC_ERROR : (isFocus ? NC_BRAND : NC_GRAY);
  const wrapper = ncFrame("input-wrapper", {
    layoutMode: "HORIZONTAL", resizeW: sz.width || 280, resizeH: 44, cornerRadius: 8,
    fills: ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(borderColor), strokeWeight: isFocus ? 2 : 1, strokeAlign: "INSIDE",
    paddingLeft: 12, paddingRight: 12,
    counterAxisAlignItems: "CENTER",
  });
  const input = ncFrame("input", { fills: [], layoutGrow: true, resizeW: 100, resizeH: 24 });
  wrapper.appendChild(input);
  comp.appendChild(wrapper);

  if (isError) {
    comp.appendChild(await ncCreateText("error-text", "Error message", "Regular", 12, NC_ERROR, 1));
  } else {
    comp.appendChild(await ncCreateText("hint-text", "Hint text", "Regular", 12, NC_GRAY, isDisabled ? 0.38 : 1));
  }
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildCheckboxComponent(node, variantName) {
  await ensureLabelFonts();
  const isChecked = variantName.indexOf("Checked=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Checkbox label";

  const comp = ncFrame("checkbox-root", {
    layoutMode: "HORIZONTAL", itemSpacing: 8, counterAxisAlignItems: "CENTER", fills: [],
  });
  comp.name = variantName;

  const box = ncFrame("checkbox-box", {
    resizeW: 20, resizeH: 20, cornerRadius: 4,
    fills: isChecked ? ncSolid(NC_BRAND) : ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(isChecked ? NC_BRAND : NC_GRAY), strokeWeight: 2, strokeAlign: "INSIDE",
  });
  if (isFocus) box.effects = ncFocusShadow();
  if (isChecked) {
    const mark = ncFrame("checkmark-icon", { resizeW: 12, resizeH: 12, fills: ncSolid({ r: 1, g: 1, b: 1 }) });
    box.appendChild(mark);
  }
  comp.appendChild(box);
  comp.appendChild(await ncCreateText("label", labelText, "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildToggleComponent(node, variantName) {
  await ensureLabelFonts();
  const isChecked = variantName.indexOf("Checked=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Toggle label";

  const comp = ncFrame("toggle-root", {
    layoutMode: "HORIZONTAL", itemSpacing: 8, counterAxisAlignItems: "CENTER", fills: [],
  });
  comp.name = variantName;

  const track = ncFrame("track", {
    resizeW: 44, resizeH: 24, cornerRadius: 12,
    fills: ncSolid(isChecked ? NC_BRAND : NC_GRAY),
  });
  if (isFocus) { track.strokes = ncSolid(NC_BRAND); track.strokeWeight = 2; track.strokeAlign = "OUTSIDE"; }
  const thumb = ncFrame("thumb", { resizeW: 20, resizeH: 20, cornerRadius: 10, fills: ncSolid({ r: 1, g: 1, b: 1 }) });
  thumb.x = isChecked ? 22 : 2;
  thumb.y = 2;
  track.appendChild(thumb);
  comp.appendChild(track);
  comp.appendChild(await ncCreateText("label", labelText, "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildAccordionComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isExpanded = variantName.indexOf("Expanded=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Accordion item";

  const comp = ncFrame("accordion-root", {
    layoutMode: "VERTICAL", itemSpacing: 0, fills: [], resizeW: sz.width || 400, resizeH: 120,
  });
  comp.name = variantName;

  const trigger = ncFrame("trigger", {
    layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER",
    paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14,
    fills: ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(isFocus ? NC_BRAND : { r: 0.9, g: 0.9, b: 0.9 }), strokeWeight: isFocus ? 2 : 1, strokeAlign: "INSIDE",
    resizeW: sz.width || 400, resizeH: 52,
  });
  const itemLabel = await ncCreateText("item-label", labelText, "Medium", 14, NC_TEXT_DARK, 1);
  itemLabel.layoutGrow = 1;
  trigger.appendChild(itemLabel);
  const chevron = ncFrame("chevron-icon", { resizeW: 24, resizeH: 24, fills: [] });
  chevron.rotation = isExpanded ? 180 : 0;
  trigger.appendChild(chevron);
  comp.appendChild(trigger);

  const panel = ncFrame("panel", {
    layoutMode: "VERTICAL", paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
    fills: ncSolid({ r: 0.97, g: 0.97, b: 0.97 }), resizeW: sz.width || 400, resizeH: 40,
  });
  panel.visible = isExpanded;
  panel.appendChild(await ncCreateText("content", "Panel content", "Regular", 14, { r: 0.3, g: 0.3, b: 0.3 }, 1));
  comp.appendChild(panel);

  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildRadioGroupComponent(node, variantName) {
  await ensureLabelFonts();
  const isSelected = variantName.indexOf("Selected=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const groupLabel = extractLabelText(node) || "Choose one";

  const comp = ncFrame("radiogroup-root", { layoutMode: "VERTICAL", itemSpacing: 8, fills: [] });
  comp.name = variantName;
  comp.appendChild(await ncCreateText("group-label", groupLabel, "Medium", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));

  const item = ncFrame("radio-item", { layoutMode: "HORIZONTAL", itemSpacing: 8, counterAxisAlignItems: "CENTER", fills: [] });
  const dot = ncFrame("radio-dot", {
    resizeW: 20, resizeH: 20, cornerRadius: 100,
    fills: ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(isSelected ? NC_BRAND : NC_GRAY), strokeWeight: 2, strokeAlign: "INSIDE",
  });
  if (isFocus) dot.effects = ncFocusShadow();
  if (isSelected) {
    const inner = ncFrame("inner-dot", { resizeW: 10, resizeH: 10, cornerRadius: 100, fills: ncSolid(NC_BRAND) });
    inner.x = 5; inner.y = 5;
    dot.appendChild(inner);
  }
  item.appendChild(dot);
  item.appendChild(await ncCreateText("label", "Option", "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  comp.appendChild(item);
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildSelectComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isOpen = variantName.indexOf("Open=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Label";

  const comp = ncFrame("select-root", { layoutMode: "VERTICAL", itemSpacing: 4, fills: [], resizeW: sz.width || 280, resizeH: 120 });
  comp.name = variantName;
  comp.appendChild(await ncCreateText("label", labelText, "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));

  const trigger = ncFrame("trigger", {
    layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER",
    paddingLeft: 12, paddingRight: 12, resizeW: sz.width || 280, resizeH: 44, cornerRadius: 8,
    fills: ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(isFocus ? NC_BRAND : NC_GRAY), strokeWeight: isFocus ? 2 : 1, strokeAlign: "INSIDE",
  });
  const val = await ncCreateText("selected-value", "Select…", "Regular", 14, NC_TEXT_DARK, 1);
  val.layoutGrow = 1;
  trigger.appendChild(val);
  trigger.appendChild(ncFrame("chevron-icon", { resizeW: 16, resizeH: 16, fills: [] }));
  comp.appendChild(trigger);

  const list = ncFrame("options-list", {
    layoutMode: "VERTICAL", paddingTop: 4, paddingBottom: 4, cornerRadius: 8,
    strokes: ncSolid(NC_GRAY), strokeWeight: 1, strokeAlign: "INSIDE", fills: ncSolid({ r: 1, g: 1, b: 1 }),
    resizeW: sz.width || 280, resizeH: 44,
  });
  list.visible = isOpen;
  const opt = ncFrame("option", { layoutMode: "HORIZONTAL", paddingLeft: 12, paddingRight: 12, resizeW: sz.width || 280, resizeH: 36, fills: [] });
  opt.appendChild(await ncCreateText("option-label", "Option", "Regular", 14, NC_TEXT_DARK, 1));
  list.appendChild(opt);
  comp.appendChild(list);
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildModalComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const titleText = extractLabelText(node) || "Dialog title";

  const comp = ncFrame("modal-root", {
    layoutMode: "VERTICAL", cornerRadius: 12, paddingTop: 32, paddingBottom: 32, paddingLeft: 32, paddingRight: 32,
    fills: ncSolid({ r: 1, g: 1, b: 1 }), resizeW: sz.width || 400, resizeH: sz.height || 280,
  });
  comp.name = variantName;

  const surface = ncFrame("dialog-surface", { layoutMode: "VERTICAL", itemSpacing: 16, fills: [] });
  const header = ncFrame("header", { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER", fills: [] });
  header.appendChild(await ncCreateText("title", titleText, "Medium", 18, NC_TEXT_DARK, 1));
  const closeBtn = ncFrame("close-button", { resizeW: 32, resizeH: 32, cornerRadius: 6, fills: [] });
  closeBtn.appendChild(ncFrame("icon", { resizeW: 16, resizeH: 16, fills: [] }));
  closeBtn.appendChild(await ncHiddenLabel("Close dialog"));
  header.appendChild(closeBtn);
  surface.appendChild(header);
  const body = ncFrame("body", { layoutMode: "VERTICAL", itemSpacing: 12, fills: [] });
  body.appendChild(ncFrame("content", { resizeW: 200, resizeH: 80, fills: [] }));
  surface.appendChild(body);
  const footer = ncFrame("footer", { layoutMode: "HORIZONTAL", itemSpacing: 12, fills: [] });
  footer.appendChild(ncFrame("cancel-button", { resizeW: 80, resizeH: 36, cornerRadius: 8, fills: ncSolid(NC_GRAY) }));
  footer.appendChild(ncFrame("confirm-button", { resizeW: 80, resizeH: 36, cornerRadius: 8, fills: ncSolid(NC_BRAND) }));
  surface.appendChild(footer);
  comp.appendChild(surface);
  return comp;
}

async function buildTabsComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isSelected = variantName.indexOf("Selected=True") >= 0;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;

  const comp = ncFrame("tabs-root", { layoutMode: "VERTICAL", fills: [], resizeW: sz.width || 400, resizeH: 200 });
  comp.name = variantName;

  const tabList = ncFrame("tab-list", { layoutMode: "HORIZONTAL", itemSpacing: 0, fills: [] });
  const tab = ncFrame("tab", {
    layoutMode: "VERTICAL", counterAxisAlignItems: "CENTER",
    paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, fills: [],
  });
  tab.appendChild(await ncCreateText("tab-label", "Tab", "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  const indicator = ncFrame("active-indicator", { resizeW: 60, resizeH: 2, fills: ncSolid(NC_BRAND) });
  indicator.visible = isSelected;
  tab.appendChild(indicator);
  if (isFocus) tab.effects = ncFocusShadow();
  tabList.appendChild(tab);
  comp.appendChild(tabList);
  const panel = ncFrame("tab-panel", { layoutMode: "VERTICAL", paddingTop: 16, paddingBottom: 16, fills: [] });
  panel.appendChild(ncFrame("content", { resizeW: 200, resizeH: 80, fills: [] }));
  comp.appendChild(panel);
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildSliderComponent(node, variantName) {
  await ensureLabelFonts();
  const sz = ncNodeSize(node);
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;
  const labelText = extractLabelText(node) || "Volume";

  const comp = ncFrame("slider-root", { layoutMode: "VERTICAL", itemSpacing: 8, fills: [], resizeW: sz.width || 280, resizeH: 60 });
  comp.name = variantName;

  const labelRow = ncFrame("label-row", { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", fills: [] });
  labelRow.appendChild(await ncCreateText("label", labelText, "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  labelRow.appendChild(await ncCreateText("value-display", "50%", "Regular", 14, NC_TEXT_DARK, isDisabled ? 0.38 : 1));
  comp.appendChild(labelRow);

  const trackWrap = ncFrame("track-wrapper", { resizeW: sz.width || 280, resizeH: 20, fills: [] });
  trackWrap.layoutMode = "NONE";
  const track = ncFrame("track", { resizeW: sz.width || 280, resizeH: 4, cornerRadius: 2, fills: ncSolid({ r: 0.88, g: 0.88, b: 0.88 }) });
  track.y = 8;
  const fill = ncFrame("fill", { resizeW: (sz.width || 280) * 0.5, resizeH: 4, cornerRadius: 2, fills: ncSolid(NC_BRAND) });
  fill.y = 8;
  const thumb = ncFrame("thumb", {
    resizeW: 20, resizeH: 20, cornerRadius: 100, fills: ncSolid({ r: 1, g: 1, b: 1 }),
    strokes: ncSolid(NC_BRAND), strokeWeight: 2, strokeAlign: "INSIDE",
  });
  thumb.x = (sz.width || 280) * 0.5 - 10;
  thumb.y = 0;
  if (isFocus) thumb.effects = ncFocusShadow();
  trackWrap.appendChild(track);
  trackWrap.appendChild(fill);
  trackWrap.appendChild(thumb);
  comp.appendChild(trackWrap);
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildStarRatingComponent(node, variantName) {
  await ensureLabelFonts();
  const valueMatch = variantName.match(/Value=(\d)/);
  const value = valueMatch ? parseInt(valueMatch[1], 10) : 3;
  const isFocus = variantName.indexOf("Focus") >= 0;
  const isDisabled = variantName.indexOf("Disabled") >= 0;

  const comp = ncFrame("rating-root", { layoutMode: "HORIZONTAL", itemSpacing: 4, fills: [] });
  comp.name = variantName;

  for (let s = 1; s <= 5; s++) {
    const starFrame = ncFrame("star-" + s, { layoutMode: "VERTICAL", fills: [] });
    const filled = s <= value;
    starFrame.appendChild(ncFrame("star-icon", {
      resizeW: 24, resizeH: 24,
      fills: ncSolid(filled ? NC_BRAND : { r: 0.88, g: 0.88, b: 0.88 }),
    }));
    starFrame.appendChild(await ncHiddenLabel(s + (s === 1 ? " star" : " stars")));
    comp.appendChild(starFrame);
  }
  comp.appendChild(await ncHiddenLabel("Rating: " + value + " out of 5"));
  if (isFocus) comp.effects = ncFocusShadow();
  if (isDisabled) comp.opacity = 0.38;
  return comp;
}

async function buildComponentVariant(node, componentType, variantName) {
  switch (componentType) {
    case "button":       return buildButtonComponent(node, variantName);
    case "textField":    return buildTextFieldComponent(node, variantName);
    case "checkbox":     return buildCheckboxComponent(node, variantName);
    case "toggle":       return buildToggleComponent(node, variantName);
    case "accordion":    return buildAccordionComponent(node, variantName);
    case "radio-group":  return buildRadioGroupComponent(node, variantName);
    case "select":       return buildSelectComponent(node, variantName);
    case "modal":        return buildModalComponent(node, variantName);
    case "tabs":         return buildTabsComponent(node, variantName);
    case "slider":       return buildSliderComponent(node, variantName);
    case "star-rating":  return buildStarRatingComponent(node, variantName);
    default:             return buildButtonComponent(node, variantName);
  }
}

async function buildComponentSet(node, componentType) {
  const typeKey = normalizeMatrixTypeKey(componentType) || "button";
  const baseName = await getCleanComponentBaseName(node);
  const variants = COMPONENT_VARIANTS[typeKey] || COMPONENT_VARIANTS.button;
  const master = ncMasterXY(node);
  const sz = ncNodeSize(node);

  const components = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const comp = await buildComponentVariant(node, typeKey, variants[vi]);
    comp.x = master.x + vi * (sz.width + 40);
    comp.y = master.y;
    figma.currentPage.appendChild(comp);
    components.push(comp);
  }

  const componentSet = figma.combineAsVariants(components, figma.currentPage);
  componentSet.name = baseName;
  componentSet.description = COMPONENT_SEMANTIC_DESC[typeKey] || COMPONENT_SEMANTIC_DESC.button;
  return componentSet;
}

function buildNonComponentPathCPrompt(node, componentType) {
  const typeKey = normalizeMatrixTypeKey(componentType) || "button";
  const childIds = [];
  if ("children" in node) {
    for (let i = 0; i < node.children.length && i < 12; i++) {
      const c = node.children[i];
      if (!isNodeVisible(c)) continue;
      childIds.push('"' + (c.name || "layer") + '" (id: ' + c.id + ", type: " + c.type + ")");
    }
  }
  const variants = (COMPONENT_VARIANTS[typeKey] || []).join(", ");
  return (
    'Convert node "' + (node.name || "layer") + '" (id: ' + node.id + ", type: " + node.type + ") into a Figma component set.\n" +
    "Component type: " + typeKey + "\n" +
    "Required variants: " + variants + "\n" +
    "Children to preserve as slots: " + (childIds.join(", ") || "none") + "\n" +
    (COMPONENT_SEMANTIC_DESC[typeKey] || "") + "\n" +
    "Place the ComponentSet at x+4000 from the node's position. Replace the original with a Default-state instance at the same x, y, width, height. " +
    "Use semantic layer names (label, input, trigger, panel, etc.). Focus ring 2px #3366FF. Disabled opacity 0.38."
  );
}

async function replaceNodeWithDefaultInstance(node, componentSet, componentType) {
  const parent = node.parent;
  if (!parent || !("insertChild" in parent)) {
    return { success: false, reason: "no_parent" };
  }
  const nodeIndex = parent.children.indexOf(node);
  let defaultComp = null;
  for (let i = 0; i < componentSet.children.length; i++) {
    const c = componentSet.children[i];
    if (c.name.indexOf("Default") >= 0) { defaultComp = c; break; }
  }
  if (!defaultComp) defaultComp = componentSet.children[0];

  const instance = defaultComp.createInstance();
  instance.x = node.x;
  instance.y = node.y;
  try {
    if ("resize" in instance && node.width && node.height) {
      instance.resize(node.width, node.height);
    }
  } catch (_e) {}

  const role = componentType || typeKeyFromSet(componentSet);
  instance.setSharedPluginData("a11y", "role", role);
  instance.setSharedPluginData("a11y", "componentized", "true");
  instance.setSharedPluginData("a11y", "componentSetId", componentSet.id);

  parent.insertChild(nodeIndex, instance);
  node.remove();
  return { success: true, instanceId: instance.id, componentSetId: componentSet.id };
}

function typeKeyFromSet(set) {
  const d = set.description || "";
  if (d.indexOf("textbox") >= 0) return "textField";
  if (d.indexOf("checkbox") >= 0) return "checkbox";
  return "button";
}

// Composite controls get one ComponentSet on the parent (PATH A), not per uniform child (PATH B).
var NON_COMPONENT_COMPOSITE_TYPES = {
  "star-rating": true,
  "radio-group": true,
  "tabs": true,
  "slider": true,
  "accordion": true,
};

async function fixNonComponentElement(node, componentType) {
  if (!node || !("name" in node)) return { success: false, reason: "invalid_node" };
  if (isA11yGeneratedLayer(node)) return { success: false, reason: "skipped_a11y_layer" };

  // Already a component or instance — nothing to do
  if (node.type === "COMPONENT" || node.type === "INSTANCE") {
    return { success: false, reason: "already_component" };
  }
  if (node.type === "COMPONENT_SET") {
    return { success: false, reason: "already_component" };
  }

  // Already inside a ComponentSet — it's a variant, skip it
  if (node.parent && node.parent.type === "COMPONENT_SET") {
    return { success: false, reason: "is_variant" };
  }

  // Already inside a Component — it's a child layer, skip it
  if (node.parent && node.parent.type === "COMPONENT") {
    return { success: false, reason: "inside_component" };
  }

  const parent = node.parent;
  if (!parent || !("insertChild" in parent)) return { success: false, reason: "no_parent" };

  const typeKey = normalizeMatrixTypeKey(componentType) || classifyNodeForFix(node) || "button";

  // PATH B — uniform children: componentize each child, not the parent
  // Skip for composite types (e.g. star-rating with 5 star layers → one set via PATH A).
  if (isUniformChildrenForFix(node) && !NON_COMPONENT_COMPOSITE_TYPES[typeKey]) {
    if (node.parent && node.parent.type === "COMPONENT_SET") {
      return { success: false, reason: "is_variant" };
    }
    const childResults = [];
    const kids = node.children.slice();
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!isNodeVisible(child) || isA11yGeneratedLayer(child)) continue;
      if (child.type === "COMPONENT" || child.type === "INSTANCE") continue;
      if (child.parent && child.parent.type === "COMPONENT_SET") continue;
      if (child.parent && child.parent.type === "COMPONENT") continue;
      const childType = classifyNodeForFix(child);
      if (childType === "unknown") continue;
      childResults.push(await fixNonComponentElement(child, childType));
    }
    if (childResults.length > 0) {
      return { success: true, path: "B", childResults: childResults };
    }
  }

  // PATH C — complex structure → Figma AI prompt only (must match getNonComponentCapability)
  if (getNonComponentCapability(node) === "FIGMA_AI") {
    return {
      success: false,
      path: "C",
      figmaAiPrompt: buildNonComponentPathCPrompt(node, typeKey),
    };
  }

  // PATH A — leaf or simple: build component set off-canvas, swap instance in place
  try {
    const componentSet = await buildComponentSet(node, typeKey);
    const swapped = await replaceNodeWithDefaultInstance(node, componentSet, typeKey);
    if (!swapped.success) return Object.assign({ path: "A" }, swapped);
    return {
      success: true,
      path: "A",
      componentSetId: swapped.componentSetId,
      instanceId: swapped.instanceId,
    };
  } catch (err) {
    return { success: false, path: "A", error: String(err) };
  }
}

async function fixNonComponentElementHandler(p) {
  const scanRoot = p.rootNode || p.node;
  if (!scanRoot) {
    return { ok: false, code: "NON_COMPONENT_ELEMENT", message: "Selection changed." };
  }

  const scanRootId = scanRoot.id;
  if (processedNonComponentNodeIds.has(scanRootId)) {
    return {
      ok: false,
      code: "NON_COMPONENT_ELEMENT",
      message: "This layer was already componentized in this session.",
    };
  }

  const typeKey = normalizeMatrixTypeKey(p.detectedRole || p.role || "") ||
    classifyNodeForFix(scanRoot) || "button";

  // Optional: link to existing library component first when user chose from picker
  if (p.linkAction || p.linkCandidateId) {
    return fixLinkToComponent(p);
  }

  const result = await fixNonComponentElement(scanRoot, typeKey);

  if (result.success && result.path === "A") {
    processedNonComponentNodeIds.add(scanRootId);
  }

  if (result.path === "C") {
    if (p.rootNode && p.rootNode.setPluginData) {
      p.rootNode.setPluginData("a11y-waiting-ai", JSON.stringify({
        issueCode: "NON_COMPONENT_ELEMENT",
        markedAt:  Date.now(),
        prompt:    result.figmaAiPrompt,
      }));
    }
    return {
      ok: true,
      code: "NON_COMPONENT_ELEMENT",
      source: "prompt",
      promptForClipboard: result.figmaAiPrompt,
      waitingForAi: true,
      message: "Complex structure — copy the prompt into Figma AI (⌘⌥I), apply, then Re-scan.",
    };
  }

  if (result.success) {
    figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
    const msg = result.path === "B"
      ? "Componentized " + (result.childResults ? result.childResults.length : 0) + " child layer(s)."
      : "Created component set and replaced layer with Default instance. Cmd+Z to undo.";
    return {
      ok: true,
      code: "NON_COMPONENT_ELEMENT",
      source: "generic",
      message: msg,
      createdNodeId: result.instanceId || scanRoot.id,
    };
  }

  return {
    ok: false,
    code: "NON_COMPONENT_ELEMENT",
    message: result.error || result.reason || "Could not componentize this layer.",
  };
}


async function fixLinkToComponent(p) {
  const originalNode = p.node || p.rootNode;
  const rootNode = p.rootNode || originalNode;
  const typeKey = normalizeMatrixTypeKey(p.detectedRole || p.role || "button");
  const spec = COMPONENT_SPECS.find(function(s) { return normalizeMatrixTypeKey(s.role) === typeKey; });
  const ariaRole = (spec && spec.ariaRole) || typeKey;

  if (!originalNode) {
    return { ok: false, code: "NON_COMPONENT_ELEMENT", message: "Selection changed." };
  }

  if (p.linkAction === "build_new") {
    const prompt = buildComponentLinkAIPrompt(originalNode, typeKey, ariaRole);
    return {
      ok: true,
      code: "NON_COMPONENT_ELEMENT",
      source: "prompt",
      promptForClipboard: prompt,
      message: "No suitable component found — copy the prompt and paste into Figma AI chat.",
    };
  }

  if (p.linkCandidateId) {
    const pick = await getNodeById(p.linkCandidateId);
    if (pick && pick.type === "COMPONENT") {
      const instance = await linkNodeToComponentInstance(originalNode, pick);
      figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
      return {
        ok: true,
        code: "NON_COMPONENT_ELEMENT",
        source: "generic",
        message: "Linked to " + pick.name + ". Original layer hidden (not deleted). Cmd+Z to undo.",
        createdNodeId: instance.id,
      };
    }
  }

  const candidateEntries = await findAccessibleComponentCandidates(typeKey, originalNode);
  const skipSet = {};
  const skipList = p.skipCandidateIds || [];
  for (let si = 0; si < skipList.length; si++) skipSet[skipList[si]] = true;

  let chosen = null;
  let blocker = null;
  const candidateSummaries = [];

  for (let i = 0; i < candidateEntries.length; i++) {
    const entry = candidateEntries[i];
    const c = entry.component;
    if (skipSet[c.id]) continue;
    const count = await auditCandidateIssueCount(c, typeKey);
    const thumb = await exportNodeThumbnailBase64(c);
    candidateSummaries.push({
      id:              c.id,
      name:            c.name,
      source:          entry.source,
      isPossibleMatch: entry.isPossibleMatch,
      issueCount:      count,
      thumbnailBase64: thumb,
    });
    if (count < 2 && !chosen) {
      chosen = c;
      continue;
    }
    if (!blocker) blocker = { comp: c, count: count, isPossibleMatch: entry.isPossibleMatch };
  }

  if (chosen) {
    const instance = await linkNodeToComponentInstance(originalNode, chosen);
    figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
    return {
      ok: true,
      code: "NON_COMPONENT_ELEMENT",
      source: "generic",
      message: "Linked to " + chosen.name + ". Original layer hidden (not deleted). Cmd+Z to undo.",
      createdNodeId: instance.id,
    };
  }

  if (candidateSummaries.length > 0 && p.linkAction !== "force") {
    return {
      ok: false,
      code: "NON_COMPONENT_ELEMENT",
      needsComponentLinkChoice: true,
      candidates:        candidateSummaries,
      candidateId:       blocker ? blocker.comp.id : candidateSummaries[0].id,
      candidateName:     blocker ? blocker.comp.name : candidateSummaries[0].name,
      candidateIssueCount: blocker ? blocker.count : candidateSummaries[0].issueCount,
      isPossibleMatch:   blocker ? blocker.isPossibleMatch : candidateSummaries[0].isPossibleMatch,
      message: blocker
        ? "Found " + blocker.comp.name + " but it has " + blocker.count + " accessibility issues."
        : "Select a component to link.",
    };
  }

  if (blocker && p.linkAction === "force") {
    const instance = await linkNodeToComponentInstance(originalNode, blocker.comp);
    figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
    return {
      ok: true,
      code: "NON_COMPONENT_ELEMENT",
      message: "Linked to " + blocker.comp.name + " (issues remain). Original hidden. Cmd+Z to undo.",
      createdNodeId: instance.id,
    };
  }

  const prompt = buildComponentLinkAIPrompt(originalNode, typeKey, ariaRole);
  return {
    ok: true,
    code: "NON_COMPONENT_ELEMENT",
    source: "prompt",
    promptForClipboard: prompt,
    message: "No suitable component found — copy the prompt and paste into Figma AI chat.",
  };
}

async function fixAccordionNoHeadingAnnotation(p) {
  const target = p.rootNode || p.node;
  if (!target) return { ok: false, code: p.issueCode, message: "No target node." };
  let label = (target.name || "Accordion")
    .replace(/^(accordion|faq)[\s\/_-]*/i, "")
    .replace(/[_\-]+/g, " ")
    .trim();
  if (!label) label = target.name || "Accordion";
  const dest = p.annotationDestination || await getAnnotationDestination();
  await writeA11yAnnotation(target, "aria-label", label, dest === "ask" ? "devmode" : dest);
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "annotation", message: "Applied fix. Cmd+Z to undo." };
}

async function fixAccordionHeaderButtons(p) {
  const root = p.rootNode || p.node;
  if (!root || !("children" in root)) {
    return { ok: false, code: p.issueCode, message: "Accordion root not found." };
  }
  const dest = p.annotationDestination || await getAnnotationDestination();
  const effectiveDest = dest === "ask" ? "devmode" : dest;
  let count = 0;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (!isNodeVisible(child) || child.type === "TEXT") continue;
    await writeA11yAnnotation(child, "aria-role", "button", effectiveDest);
    count++;
  }
  if (count === 0) {
    return { ok: false, code: p.issueCode, message: "No accordion row children to annotate." };
  }
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "annotation", message: "Applied fix. Cmd+Z to undo." };
}

// ─── Annotation autofix map (Part A) ─────────────────────────────────────────

var ANNOTATION_FIX_MAP = {
  ROLE_BUTTON_ANNOTATED:        { target: "root",     key: "aria-role",      value: "button" },
  ROLE_TEXTBOX_ANNOTATED:       { target: "root",     key: "aria-role",      value: "textbox" },
  ROLE_CHECKBOX_ANNOTATED:      { target: "root",     key: "aria-role",      value: "checkbox" },
  ARIA_CHECKED_ANNOTATED:       { target: "root",     key: "aria-checked",   value: "false" },
  ROLE_RADIOGROUP_ON_CONTAINER: { target: "root",     key: "aria-role",      value: "radiogroup" },
  ROLE_RADIO_ON_ITEMS:          { target: "children", key: "aria-role",      value: "radio" },
  ROLE_COMBOBOX_OR_LISTBOX:     { target: "root",     key: "aria-role",      value: "combobox" },
  EXPANSION_STATE_ANNOTATED:    { target: "root",     key: "aria-expanded",  value: "false" },
  ARIA_EXPANDED_ANNOTATED:      { target: "root",     key: "aria-expanded",  value: "false" },
  ROLE_DIALOG_ANNOTATED:        { target: "root",     key: "aria-role",      value: "dialog" },
  ARIA_MODAL_TRUE:              { target: "root",     key: "aria-modal",     value: "true" },
  ROLE_TABLIST_ON_CONTAINER:    { target: "root",     key: "aria-role",      value: "tablist" },
  ROLE_TAB_ON_ITEMS:            { target: "children", key: "aria-role",      value: "tab" },
  ARIA_SELECTED_ANNOTATED:      { target: "children", key: "aria-selected",  value: "false" },
  ROLE_TABPANEL_ON_PANEL:       { target: "root",     key: "aria-role",      value: "tabpanel" },
  ROLE_SLIDER_ANNOTATED:        { target: "root",     key: "aria-role",      value: "slider" },
  ARIA_VALUE_NOW_MIN_MAX:       { target: "root",     key: "aria-valuenow",  value: "0",
    extra: [{ key: "aria-valuemin", value: "0" }, { key: "aria-valuemax", value: "100" }] },
  ROLE_GROUP_OR_IMG:            { target: "root",     key: "aria-role",      value: "group" },
  ROLE_SWITCH_ANNOTATED:        { target: "root",     key: "aria-role",      value: "switch" },
  PANEL_HAS_REGION_ROLE:        { target: "root",     key: "aria-role",      value: "region" },
};

var ISSUE_TO_ANNOTATION_CHECK = {
  ROLE_BUTTON_MISSING:       "ROLE_BUTTON_ANNOTATED",
  ROLE_TEXTBOX_MISSING:      "ROLE_TEXTBOX_ANNOTATED",
  ROLE_CHECKBOX_MISSING:     "ROLE_CHECKBOX_ANNOTATED",
  ARIA_CHECKED_MISSING:      "ARIA_CHECKED_ANNOTATED",
  ROLE_RADIOGROUP_MISSING:   "ROLE_RADIOGROUP_ON_CONTAINER",
  ROLE_COMBOBOX_MISSING:     "ROLE_COMBOBOX_OR_LISTBOX",
  ARIA_EXPANDED_MISSING:     "EXPANSION_STATE_ANNOTATED",
  ROLE_DIALOG_MISSING:       "ROLE_DIALOG_ANNOTATED",
  ARIA_MODAL_MISSING:        "ARIA_MODAL_TRUE",
  ROLE_TABLIST_MISSING:      "ROLE_TABLIST_ON_CONTAINER",
  ARIA_SELECTED_MISSING:     "ARIA_SELECTED_ANNOTATED",
  TABS_NO_TAB_ITEMS:         "ROLE_TAB_ON_ITEMS",
  TABS_NO_TABPANEL:          "ROLE_TABPANEL_ON_PANEL",
  ROLE_SLIDER_MISSING:       "ROLE_SLIDER_ANNOTATED",
  SLIDER_ARIA_VALUE_MISSING: "ARIA_VALUE_NOW_MIN_MAX",
  RATING_ROLE_MISSING:       "ROLE_GROUP_OR_IMG",
  ROLE_SWITCH_MISSING:       "ROLE_SWITCH_ANNOTATED",
  ACCORDION_PANEL_REGION:    "PANEL_HAS_REGION_ROLE",
};

async function fixAnnotation(node, checkId, destination) {
  const spec = ANNOTATION_FIX_MAP[checkId];
  if (!spec || !node) return false;
  const dest = destination || "devmode";
  try {
    if (spec.target === "root") {
      await writeA11yAnnotation(node, spec.key, spec.value, dest);
      if (spec.extra) {
        for (let i = 0; i < spec.extra.length; i++) {
          await writeA11yAnnotation(node, spec.extra[i].key, spec.extra[i].value, dest);
        }
      }
    } else if (spec.target === "children" && "children" in node) {
      for (let i = 0; i < node.children.length; i++) {
        if (!isNodeVisible(node.children[i])) continue;
        await writeA11yAnnotation(node.children[i], spec.key, spec.value, dest);
      }
    } else {
      return false;
    }
    return true;
  } catch (_e) { return false; }
}

function makeAnnotationFixHandler(checkId) {
  return async function(p) {
    const target = p.rootNode || p.node;
    const dest = p.annotationDestination || await getAnnotationDestination();
    const ok = await fixAnnotation(target, checkId, dest === "ask" ? "devmode" : dest);
    figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
    return {
      ok: ok,
      code: p.issueCode,
      source: "annotation",
      message: ok ? "Applied fix. Cmd+Z to undo." : "Could not apply annotation.",
    };
  };
}

async function fixFocusTrapDescribed(p) {
  const target = p.rootNode || p.node;
  if (!target) return { ok: false, code: p.issueCode, message: "No target node." };
  const dest = p.annotationDestination || await getAnnotationDestination();
  const effectiveDest = dest === "ask" ? "devmode" : dest;
  await writeA11yAnnotation(target, "focus-trap", "true", effectiveDest);
  await writeA11yAnnotation(target, "keyboard-pattern", "Tab cycles within dialog. Escape closes.", effectiveDest);
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "annotation", message: "Applied fix. Cmd+Z to undo." };
}

function applyAccessiblePaint(node, metrics, targetRatio) {
  const hsl = rgbToHsl255(metrics.perceived.r, metrics.perceived.g, metrics.perceived.b);
  const newL = findAccessibleColor(hsl.h, hsl.s, metrics.bg, targetRatio, hsl.l);
  if (newL === null) return null;
  const newRgb = hslToRgb255(hsl.h, hsl.s, newL);
  const newColor = {
    r: newRgb.r / 255,
    g: newRgb.g / 255,
    b: newRgb.b / 255,
  };

  if (metrics.paintKind === "stroke" && "strokes" in node) {
    const strokes = node.strokes;
    if (strokes === figma.mixed || !strokes || !strokes.length) return null;
    const newStrokes = [];
    let applied = false;
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      if (!applied && s.type === "SOLID" && s.visible !== false) {
        newStrokes.push(Object.assign({}, s, {
          color: Object.assign({}, s.color || {}, newColor, { a: (s.color && s.color.a !== undefined) ? s.color.a : 1 }),
        }));
        applied = true;
      } else {
        newStrokes.push(s);
      }
    }
    if (!applied) return null;
    node.strokes = newStrokes;
    return newRgb;
  }

  const fills = node.fills;
  if (fills === figma.mixed || !fills || !fills.length) return null;
  const newFills = [];
  let applied = false;
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    if (!applied && f.type === "SOLID" && f.visible !== false) {
      newFills.push({
        type: "SOLID",
        visible: true,
        color: Object.assign({}, newColor, { a: (f.color && f.color.a !== undefined) ? f.color.a : 1 }),
        opacity: f.opacity !== undefined ? f.opacity : 1,
      });
      applied = true;
    } else {
      newFills.push(f);
    }
  }
  if (!applied) return null;
  node.fills = newFills;
  return newRgb;
}

async function fixNonTextContrast(p) {
  const node = p.node || p.rootNode;
  const code = p.issueCode || "NON_TEXT_CONTRAST_FAIL";
  if (!node || node.type === "TEXT") {
    return { ok: false, code: code, message: "Non-text contrast fix requires a shape layer." };
  }
  const metrics = getShapeContrastMetrics(node);
  if (!metrics) return { ok: false, code: code, message: "Could not read fill/stroke or background." };
  if (metrics.ratio >= 3.0) {
    return { ok: true, code: code, message: "Contrast already meets 3:1." };
  }
  const newRgb = applyAccessiblePaint(node, metrics, 3.0);
  if (!newRgb) {
    return { ok: false, code: code, message: "Could not reach 3:1 by adjusting lightness only." };
  }
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return {
    ok: true,
    code: code,
    source: "generic",
    message: "Applied fix. Cmd+Z to undo.",
  };
}

async function fixOnOffStateAnnotate(p) {
  const target = p.rootNode || p.node;
  if (!target) return { ok: false, code: p.issueCode, message: "No target node." };
  setSharedA11y(target, "state-indicator", "visual-only-color");
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return {
    ok: true,
    code: p.issueCode,
    source: "annotation",
    fixKind: "message_only",
    designerMessage: "Add a text label or icon to distinguish on/off state beyond color alone.",
    message: "Add a text label or icon to distinguish on/off state beyond color alone.",
  };
}

async function placeTextBeside(anchorNode, text, opts) {
  opts = opts || {};
  const fontName = await loadInter(opts.fontStyle || "Regular");
  const label = figma.createText();
  if (fontName) label.fontName = fontName;
  label.characters = text;
  label.fontSize = opts.fontSize || 14;
  if (opts.color) {
    label.fills = [{ type: "SOLID", color: opts.color }];
  } else if (anchorNode.type === "TEXT" && anchorNode.fills !== figma.mixed) {
    const af = anchorNode.fills;
    if (af && af[0]) label.fills = [af[0]];
  }
  label.x = anchorNode.x + anchorNode.width + (opts.offsetX || 8);
  label.y = anchorNode.y + (anchorNode.height - label.height) / 2 + (opts.offsetY || 0);
  if (opts.name) label.name = opts.name;
  label.setPluginData("a11y.generated", "true");
  const parent = anchorNode.parent;
  if (parent && "appendChild" in parent) parent.appendChild(label);
  else figma.currentPage.appendChild(label);
  return label;
}

function findFirstVisibleText(root) {
  if (!root || !("findAllWithCriteria" in root)) return null;
  const texts = root.findAllWithCriteria({ types: ["TEXT"] });
  for (let i = 0; i < texts.length; i++) {
    if (isNodeVisible(texts[i]) && (texts[i].characters || "").trim()) return texts[i];
  }
  return null;
}

function findInputLabelNode(root) {
  if (!root || !("children" in root)) return null;
  let labelNode = null;
  let maxSize = 0;
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.type === "TEXT" && isNodeVisible(c)) {
      if (c.name.toLowerCase().indexOf("label") >= 0) return c;
      const sz = c.fontSize || 0;
      if (sz > maxSize) { maxSize = sz; labelNode = c; }
    }
  }
  if (labelNode) return labelNode;
  const box = root.absoluteBoundingBox;
  if (!box) return null;
  const allText = figma.currentPage.findAllWithCriteria({ types: ["TEXT"] });
  for (let j = 0; j < allText.length; j++) {
    const t = allText[j];
    if (!isNodeVisible(t)) continue;
    const tb = t.absoluteBoundingBox;
    if (!tb) continue;
    const above = tb.y + tb.height <= box.y + 10 && tb.y + tb.height >= box.y - 80;
    const left  = tb.x + tb.width  <= box.x + 10 && tb.x + tb.width  >= box.x - 80;
    if (above || left) return t;
  }
  return null;
}

function findStarChildren(root) {
  if (!root || !("children" in root)) return [];
  return root.children.filter(function(c) {
    if (!isNodeVisible(c)) return false;
    const n = c.name.toLowerCase();
    return n.includes("star") || n.includes("rating") || n.includes("vector") ||
           n.includes("icon") || c.type === "VECTOR" || c.type === "INSTANCE";
  });
}

function findSliderParts(root) {
  if (!root || !("findAll" in root)) return { track: null, thumb: null };
  let track = null;
  let thumb = null;
  const all = root.findAll(function(n) {
    return n.type !== "TEXT" && isNodeVisible(n);
  });
  for (let i = 0; i < all.length; i++) {
    const nl = all[i].name.toLowerCase();
    if (!track && (nl.indexOf("track") >= 0 || nl.indexOf("fill") >= 0 || nl.indexOf("rail") >= 0)) track = all[i];
    if (!thumb && (nl.indexOf("thumb") >= 0 || nl.indexOf("handle") >= 0 || nl.indexOf("indicator") >= 0)) thumb = all[i];
  }
  if (!thumb && all.length > 0) {
    let smallest = null;
    let smallestArea = Infinity;
    for (let j = 0; j < all.length; j++) {
      const b = all[j].absoluteBoundingBox;
      if (!b) continue;
      const area = b.width * b.height;
      if (area < smallestArea) { smallestArea = area; smallest = all[j]; }
    }
    thumb = smallest;
  }
  if (!track && root.absoluteBoundingBox) track = root;
  return { track: track, thumb: thumb };
}

async function fixChevronIndicator(p) {
  const root = p.rootNode || p.node;
  if (!root) return { ok: false, code: p.issueCode, message: "No target node." };
  const textNode = findFirstVisibleText(root);
  if (!textNode) return { ok: false, code: p.issueCode, message: "No text row found for chevron placement." };

  const chevronRe = /chevron|arrow|caret|expand/i;
  let chevronSource = null;
  if ("findAll" in figma.currentPage) {
    const found = figma.currentPage.findAll(function(n) {
      return chevronRe.test(n.name) && isNodeVisible(n);
    });
    if (found.length > 0) chevronSource = found[0];
  }

  let indicator = null;
  if (chevronSource) {
    indicator = chevronSource.clone();
  } else {
    await loadInter("Regular");
    indicator = figma.createText();
    try { indicator.fontName = { family: "Inter", style: "Regular" }; } catch (_e) {}
    indicator.characters = "\u203A";
    const rowH = textNode.height || 16;
    indicator.fontSize = Math.max(10, rowH * 0.6);
    if (textNode.fills !== figma.mixed && textNode.fills && textNode.fills[0]) {
      indicator.fills = [textNode.fills[0]];
    }
  }
  setSharedA11y(indicator, "aria-hidden", "true");
  indicator.x = textNode.x + textNode.width + 8;
  indicator.y = textNode.y + (textNode.height - (indicator.height || 16)) / 2;
  if (root.parent && "appendChild" in root.parent) root.parent.appendChild(indicator);
  else if ("appendChild" in root) root.appendChild(indicator);
  else figma.currentPage.appendChild(indicator);

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "generic", message: "Applied fix. Cmd+Z to undo.", createdNodeId: indicator.id };
}

async function fixStarAriaLabels(p) {
  const root = p.rootNode || p.node;
  if (!root) return { ok: false, code: p.issueCode, message: "No target node." };
  const stars = findStarChildren(root);
  if (!stars.length) return { ok: false, code: p.issueCode, message: "No star layers found." };

  let currentRating = stars.length;
  for (let i = 0; i < stars.length; i++) {
    const checked = getSharedA11y(stars[i], "ariaChecked");
    if (checked === "true") currentRating = i + 1;
  }

  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const label = (i + 1) + " star" + (i === 0 ? "" : "s");
    setSharedA11y(star, "aria-label", label);
    setSharedA11y(star, "aria-role", "radio");
    setSharedA11y(star, "aria-checked", i < currentRating ? "true" : "false");
  }
  setSharedA11y(root, "aria-role", "radiogroup");
  setSharedA11y(root, "aria-label", "Star rating");

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return {
    ok: true,
    code: p.issueCode,
    source: "annotation",
    message: "Applied ARIA to each star — visible in Dev Mode Code tab. Cmd+Z to undo.",
  };
}

async function fixRequiredIndicator(p) {
  const root = p.rootNode || p.node;
  if (!root) return { ok: false, code: p.issueCode, message: "No target node." };
  const labelNode = findInputLabelNode(root);
  if (labelNode) {
    try { await figma.loadFontAsync(labelNode.fontName); } catch (_e) {}
    const chars = labelNode.characters || "";
    if (!chars.endsWith("*") && chars.toLowerCase().indexOf("(required)") < 0) {
      labelNode.characters = chars + " *";
    }
  } else {
    await loadInter("Regular");
    const req = figma.createText();
    try { req.fontName = { family: "Inter", style: "Regular" }; } catch (_e) {}
    req.characters = " *";
    req.fontSize = 14;
    req.fills = [{ type: "SOLID", color: { r: 0.816, g: 0, b: 0 } }];
    req.x = root.x + root.width + 4;
    req.y = root.y;
    req.name = "label / required-indicator";
    if (root.parent && "appendChild" in root.parent) root.parent.appendChild(req);
    else figma.currentPage.appendChild(req);
  }
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "generic", message: "Applied fix. Cmd+Z to undo." };
}

async function fixRadioLabels(p) {
  const root = p.rootNode || p.node;
  if (!root || !("children" in root)) {
    return { ok: false, code: p.issueCode, message: "Radio group not found." };
  }
  const groupName = root.name || "option group";
  const ctx = await gatherContext(root);
  const nearbyText = (ctx.nearbyText || []).slice(0, 5).join(", ");
  let fixed = 0;

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child.type === "TEXT") continue;
    let hasText = false;
    if ("findAllWithCriteria" in child) {
      const tns = child.findAllWithCriteria({ types: ["TEXT"] });
      for (let j = 0; j < tns.length; j++) {
        if ((tns[j].characters || "").trim()) { hasText = true; break; }
      }
    }
    if (hasText) continue;

    let generated = "Option " + (fixed + 1);
    if (p.strategy === "ai" && p.apiKey) {
      try {
        generated = await callAILabel({
          apiKey: p.apiKey,
          maxTokens: 20,
          systemPrompt: "Generate a short label (2-4 words) for a radio option. Return only the label text, nothing else.",
          userPrompt: "Generate a short label (2-4 words) for radio option number " + (i + 1) +
            " in a group called '" + groupName + "'. Context: " + nearbyText +
            ". Return only the label text, nothing else.",
        });
      } catch (_e) {}
    }

    const label = await placeTextBeside(child, generated, { fontSize: 14, name: "label / radio-option" });
    setSharedA11y(child, "aria-label", generated);
    setSharedA11y(child, "aria-role", "radio");
    fixed++;
  }

  if (fixed === 0) return { ok: false, code: p.issueCode, message: "All radio items already have labels." };
  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: p.strategy === "ai" ? "ai" : "generic", message: "Applied fix. Cmd+Z to undo." };
}

async function fixErrorMessageText(p) {
  const root = p.rootNode || p.node;
  if (!root) return { ok: false, code: p.issueCode, message: "No target node." };
  const labelNode = findInputLabelNode(root);
  const fieldName = labelNode ? (labelNode.characters || "").replace(/\s*\*$/, "").trim() : (root.name || "field");

  let generated = "Error: Invalid " + fieldName;
  if (p.strategy === "ai" && p.apiKey) {
    try {
      generated = await callAILabel({
        apiKey: p.apiKey,
        maxTokens: 24,
        systemPrompt: "Write a short error message (under 8 words) for a form field. Start with 'Error:'. Return only the message.",
        userPrompt: "Write a short error message (under 8 words) for a form field called '" + fieldName +
          "'. Start with 'Error:'. Return only the message.",
      });
    } catch (_e) {}
  }

  await loadInter("Regular");
  const errText = figma.createText();
  try { errText.fontName = { family: "Inter", style: "Regular" }; } catch (_e) {}
  errText.characters = generated;
  errText.fontSize = 12;
  errText.fills = [{ type: "SOLID", color: { r: 0.816, g: 0, b: 0 } }];
  errText.x = root.x;
  errText.y = root.y + root.height + 4;
  errText.name = "text / error-message";
  if (root.parent && "appendChild" in root.parent) root.parent.appendChild(errText);
  else figma.currentPage.appendChild(errText);
  setSharedA11y(root, "error-text", generated);

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: p.strategy === "ai" ? "ai" : "generic", message: "Applied fix. Cmd+Z to undo.", createdNodeId: errText.id };
}

async function fixSliderValueVisible(p) {
  const root = p.rootNode || p.node;
  const parts = findSliderParts(root);
  if (!parts.track || !parts.thumb) {
    return { ok: false, code: p.issueCode, message: "Could not find slider track and thumb." };
  }
  const track = parts.track;
  const thumb = parts.thumb;
  const trackW = track.width || (track.absoluteBoundingBox && track.absoluteBoundingBox.width) || 1;
  const value = Math.round(((thumb.x - track.x) / Math.max(trackW, 1)) * 100);
  const clamped = Math.max(0, Math.min(100, value));

  await loadInter("Medium");
  const valText = figma.createText();
  try { valText.fontName = { family: "Inter", style: "Medium" }; } catch (_e) {}
  valText.characters = String(clamped);
  valText.fontSize = 12;
  valText.x = thumb.x + thumb.width / 2 - 8;
  valText.y = thumb.y - 20;
  valText.name = "text / slider-value";
  if (root.parent && "appendChild" in root.parent) root.parent.appendChild(valText);
  else if ("appendChild" in root) root.appendChild(valText);
  else figma.currentPage.appendChild(valText);
  setSharedA11y(root, "aria-valuenow", String(clamped));

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "generic", message: "Applied fix. Cmd+Z to undo.", createdNodeId: valText.id };
}

async function fixStarCurrentValue(p) {
  const root = p.rootNode || p.node;
  const stars = findStarChildren(root);
  if (!stars.length) {
    return fixSliderValueVisible(p);
  }
  const selected = Math.max(1, stars.length);
  setSharedA11y(root, "aria-valuenow", String(selected));
  await loadInter("Medium");
  const valText = figma.createText();
  try { valText.fontName = { family: "Inter", style: "Medium" }; } catch (_e) {}
  valText.characters = String(selected);
  valText.fontSize = 12;
  valText.x = root.x;
  valText.y = root.y - 20;
  valText.name = "text / rating-value";
  if (root.parent && "appendChild" in root.parent) root.parent.appendChild(valText);
  else figma.currentPage.appendChild(valText);

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });
  return { ok: true, code: p.issueCode, source: "generic", message: "Applied fix. Cmd+Z to undo.", createdNodeId: valText.id };
}

async function fixLowContrast(p) {
  const node = p.node;
  const code = p.issueCode || "CONTRAST_TEXT_FAIL";
  if (!node || node.type !== "TEXT") {
    return { ok: false, code: code, message: "Contrast fix requires a TEXT layer." };
  }
  if (!isNodeVisible(node)) {
    return { ok: false, code: code, message: "Text layer is hidden — cannot adjust fill." };
  }

  const metrics = getTextContrastMetrics(node);
  if (!metrics) {
    return { ok: false, code: code, message: "Could not read text fill or background colors." };
  }
  if (metrics.ratio >= metrics.required) {
    return { ok: true, code: code, message: "Contrast already meets " + metrics.required + ":1." };
  }

  const hsl = rgbToHsl255(metrics.perceived.r, metrics.perceived.g, metrics.perceived.b);
  const newL = findAccessibleColor(hsl.h, hsl.s, metrics.bg, metrics.required, hsl.l);
  if (newL === null) {
    return {
      ok: false,
      code: code,
      message: "Could not reach " + metrics.required + ":1 by adjusting lightness only — use Figma AI prompt.",
      promptForClipboard: buildContrastClipboardPrompt(node),
    };
  }

  const newRgb = hslToRgb255(hsl.h, hsl.s, newL);
  const fills  = node.fills;
  if (fills === figma.mixed || !fills || !fills.length) {
    return { ok: false, code: code, message: "Text node has no editable solid fill." };
  }

  const newFills = [];
  let applied = false;
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    if (!applied && f.type === "SOLID" && f.visible !== false) {
      newFills.push({
        type: "SOLID",
        visible: true,
        color: {
          r: newRgb.r / 255,
          g: newRgb.g / 255,
          b: newRgb.b / 255,
          a: (f.color && f.color.a !== undefined) ? f.color.a : 1,
        },
        opacity: f.opacity !== undefined ? f.opacity : 1,
      });
      applied = true;
    } else {
      newFills.push(f);
    }
  }
  if (!applied) {
    return { ok: false, code: code, message: "No visible SOLID fill to update on text layer." };
  }

  node.fills = newFills;

  const after = getTextContrastMetrics(node);
  const newRatio = after ? after.ratio.toFixed(2) : "?";
  const ctx = await gatherContext(p.rootNode || node);
  const resolved = reauditIsResolved(
    p.rootNode || node,
    ctx,
    { role: "button", requiredStates: [] },
    "textContrast",
    code
  );

  figma.ui.postMessage({ type: "REFRESH_SUMMARY_BANNER" });

  return {
    ok:       after ? after.ratio >= metrics.required : true,
    code:     code,
    source:   "generic",
    message:  "Text fill → " + rgbToHex255(newRgb.r, newRgb.g, newRgb.b) +
              " (contrast " + newRatio + ":1, target " + metrics.required + ":1)",
    resolved: resolved,
  };
}

// ─── Issue capability: AUTO | FIGMA_AI | DESIGNER (drives UI — no false Auto-fix) ─
var ISSUE_CAPABILITY = {
  NO_GROUP_LABEL: "AUTO",
  NO_INPUT_LABEL: "AUTO",
  ICON_BUTTON_NO_LABEL: "AUTO",
  MISSING_FOCUS_RING: "AUTO",
  MISSING_STATE_FOCUS: "AUTO",
  MISSING_STATE_DISABLED: "AUTO",
  TOUCH_TARGET_SMALL: "AUTO",
  DIALOG_NO_CLOSE: "AUTO",
  DIALOG_NO_HEADING: "AUTO",
  ACCORDION_NO_HEADING: "AUTO",
  CONTRAST_TEXT_FAIL: "AUTO",
  CONTRAST_FAIL: "AUTO",
  LOW_CONTRAST: "AUTO",
  NON_TEXT_CONTRAST_FAIL: "AUTO",
  ROLE_BUTTON_MISSING: "AUTO",
  ROLE_TEXTBOX_MISSING: "AUTO",
  ROLE_CHECKBOX_MISSING: "AUTO",
  ARIA_CHECKED_MISSING: "AUTO",
  ROLE_RADIOGROUP_MISSING: "AUTO",
  ROLE_COMBOBOX_MISSING: "AUTO",
  ARIA_EXPANDED_MISSING: "AUTO",
  ROLE_DIALOG_MISSING: "AUTO",
  ARIA_MODAL_MISSING: "AUTO",
  ROLE_TABLIST_MISSING: "AUTO",
  ARIA_SELECTED_MISSING: "AUTO",
  TABS_NO_TAB_ITEMS: "AUTO",
  TABS_NO_TABPANEL: "AUTO",
  ROLE_SLIDER_MISSING: "AUTO",
  SLIDER_ARIA_VALUE_MISSING: "AUTO",
  RATING_ROLE_MISSING: "FIGMA_AI",
  ROLE_SWITCH_MISSING: "AUTO",
  ACCORDION_PANEL_REGION: "AUTO",
  ACCORDION_HEADER_NOT_BUTTON: "AUTO",
  FOCUS_TRAP_VERIFY: "AUTO",
  STAR_MISSING_ARIA_LABEL: "AUTO",
  REQUIRED_NOT_INDICATED: "AUTO",
  COLOR_ONLY_DISABLED: "AUTO",
  COMBOBOX_NO_CHEVRON: "FIGMA_AI",
  ERROR_COLOR_ONLY_VERIFY: "FIGMA_AI",
  RADIO_NO_LABEL: "FIGMA_AI",
  RATING_VALUE_NOT_COMMUNICATED: "FIGMA_AI",
  SLIDER_VALUE_NOT_VISIBLE: "FIGMA_AI",
  CHEVRON_OR_EXPAND_INDICATOR: "FIGMA_AI",
  EACH_RADIO_HAS_LABEL: "FIGMA_AI",
  VALUE_VISIBLE: "FIGMA_AI",
  CURRENT_VALUE_COMMUNICATED: "FIGMA_AI",
  ERROR_TEXT_NOT_COLOR_ONLY: "FIGMA_AI",
  STATE_COVERAGE_CORE: "DESIGNER",
  STATE_COVERAGE_INPUT: "DESIGNER",
  STATE_COVERAGE_CHECKBOX: "DESIGNER",
  STATE_COVERAGE_SELECT: "DESIGNER",
  STATE_COVERAGE_SLIDER: "DESIGNER",
  STATE_COVERAGE_TOGGLE: "DESIGNER",
  FOCUS_RING_VISIBLE: "DESIGNER",
  PLACEHOLDER_NOT_ONLY_LABEL: "DESIGNER",
  TOUCH_TARGET_CRITICAL: "DESIGNER",
  NO_ERROR_STATE: "DESIGNER",
  NO_INDETERMINATE_STATE: "DESIGNER",
  ACCORDION_BUTTON_CONTAINS_HEADING: "DESIGNER",
  CHIP_REMOVE_NO_LABEL: "DESIGNER",
  SLIDER_PARTS_MISSING: "DESIGNER",
  FOCUS_RING_CONTRAST_FAIL: "DESIGNER",
  FOCUS_RING_CONTRAST_UNKNOWN: "DESIGNER",
};

var ISSUE_DESIGNER_CAPABILITY_MESSAGES = {
  FOCUS_RING_VISIBLE: "Add a Focus variant on the component set with a visible 2px outline (WCAG 2.4.11).",
  FOCUS_RING_CONTRAST_FAIL: "Adjust the focus ring color to meet 3:1 contrast against adjacent colors.",
  FOCUS_RING_CONTRAST_UNKNOWN: "Verify the focus indicator contrast manually (WCAG 1.4.11).",
  PLACEHOLDER_NOT_ONLY_LABEL: "Add a visible label — placeholder text alone is not sufficient.",
  TOUCH_TARGET_CRITICAL: "Resize or add spacing so the tap target is at least 24×24px (44×44 recommended).",
  NO_ERROR_STATE: "Create an Error variant on the input component with visible error text.",
  NO_INDETERMINATE_STATE: "Add an indeterminate variant if this supports tri-state selection.",
  ACCORDION_BUTTON_CONTAINS_HEADING: "Restructure: heading wraps the trigger (heading > button), not button > heading.",
  CHIP_REMOVE_NO_LABEL: "Add an accessible name for the remove control (visible text or aria-label).",
  SLIDER_PARTS_MISSING: "Include track, thumb, and value elements in the slider design.",
  ERROR_COLOR_ONLY_VERIFY: "Add error text and an icon — do not rely on color alone (requires visual review).",
};

var FIGMA_AI_PROMPTS = {
  NON_COMPONENT_ELEMENT: function(node) {
    return (
      "Convert the layer named \"" + (node.name || "layer") + "\" (node ID: " + node.id + ") into a proper Figma component.\n" +
      "Requirements:\n" +
      "- Wrap it in a Component (not just a Frame)\n" +
      "- Add these states as variants: Default, Hover, Focus, Disabled\n" +
      "- Focus state must have a 2px solid outline with 3:1 contrast against adjacent colors\n" +
      "- Preserve all existing visual design exactly\n" +
      "- Place the new component in the same position, remove the original layer"
    );
  },
  COMBOBOX_NO_CHEVRON: function(node) {
    return (
      "Add a chevron/expand indicator to the layer \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Add a ▾ or › icon to the right side of each interactive row\n" +
      "- The icon must be aria-hidden (decorative only)\n" +
      "- Match the existing visual style (color, size proportional to text)\n" +
      "- Do not change the layout of existing content"
    );
  },
  RADIO_NO_LABEL: function(node) {
    return (
      "Add visible text labels to all radio options in \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Each radio option that lacks a visible text label needs one added\n" +
      "- Labels should be short (2–4 words), descriptive, and match the design context\n" +
      "- Place labels to the right of each radio circle\n" +
      "- Match the existing typography style"
    );
  },
  RATING_ROLE_MISSING: function(node) {
    return (
      "Add accessible role and structure to the star rating in \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Wrap stars in a group with role=\"radiogroup\"\n" +
      "- Add a visible label above the group (e.g. \"Rate this item\")\n" +
      "- Each star should communicate its value visually and semantically"
    );
  },
  ERROR_COLOR_ONLY_VERIFY: function(node) {
    return (
      "Add a text error message to the field \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Add a visible error text below the input (e.g. \"Error: This field is required\")\n" +
      "- Color: #D00000, font size 12px\n" +
      "- Add a ⚠ or ✕ icon before the text\n" +
      "- The error must be communicated in text, not color alone"
    );
  },
  MISSING_STATE_FOCUS: function(node) {
    return (
      "Add a Focus state variant to the component \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements per WCAG 2.4.11:\n" +
      "- Add a new variant with property State=Focus\n" +
      "- Focus ring: 2px solid outline, 2px offset\n" +
      "- Ring color must achieve 3:1 contrast against adjacent colors\n" +
      "- Do not change the default appearance"
    );
  },
  MISSING_FOCUS_RING: function(node) {
    return FIGMA_AI_PROMPTS.MISSING_STATE_FOCUS(node);
  },
  RATING_VALUE_NOT_COMMUNICATED: function(node) {
    return (
      "Communicate the current star rating value in \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Show which star is selected (filled vs outline)\n" +
      "- Add a visible label or text showing the rating value if needed"
    );
  },
  SLIDER_VALUE_NOT_VISIBLE: function(node) {
    return (
      "Make the current slider value visible in \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Add a text label showing the current value (e.g. \"50%\")\n" +
      "- Position it near the thumb or below the track\n" +
      "- Match existing typography"
    );
  },
  STAR_MISSING_ARIA_LABEL: function(node) {
    return (
      "Add descriptive labels to each star in \"" + (node.name || "layer") + "\" (node ID: " + node.id + ").\n" +
      "Requirements:\n" +
      "- Each star needs a clear name (e.g. \"1 star\", \"2 stars\")\n" +
      "- Preserve the visual design"
    );
  },
  CHEVRON_OR_EXPAND_INDICATOR: function(node) {
    return FIGMA_AI_PROMPTS.COMBOBOX_NO_CHEVRON(node);
  },
  EACH_RADIO_HAS_LABEL: function(node) {
    return FIGMA_AI_PROMPTS.RADIO_NO_LABEL(node);
  },
  VALUE_VISIBLE: function(node) {
    return FIGMA_AI_PROMPTS.SLIDER_VALUE_NOT_VISIBLE(node);
  },
  CURRENT_VALUE_COMMUNICATED: function(node) {
    return FIGMA_AI_PROMPTS.RATING_VALUE_NOT_COMMUNICATED(node);
  },
  ERROR_TEXT_NOT_COLOR_ONLY: function(node) {
    return FIGMA_AI_PROMPTS.ERROR_COLOR_ONLY_VERIFY(node);
  },
};

function buildGenericFigmaAiPrompt(node, issueCode, issueMessage) {
  const name = (node && node.name) || "layer";
  const id = (node && node.id) || "";
  return (
    "Fix accessibility issue on layer \"" + name + "\" (node ID: " + id + ").\n" +
    "Issue: " + (issueMessage || issueCode) + "\n" +
    "WCAG requirement: " + issueCode + "\n" +
    "Please apply the minimal change needed to resolve this issue while preserving the existing design."
  );
}

function buildFigmaAiPromptForIssue(issue, node, rootNode) {
  const target = node || rootNode;
  if (!target) {
    return buildGenericFigmaAiPrompt({ id: issue.nodeId || "", name: "layer" }, issue.code, issue.message);
  }
  const fn = FIGMA_AI_PROMPTS[issue.code];
  if (fn) return fn(target);
  if (isFocusStateIssue(issue)) return buildFocusStateComponentPrompt(target, rootNode || target);
  return buildGenericFigmaAiPrompt(target, issue.code, issue.message);
}

function getDesignerCapabilityMessage(issueCode) {
  if (ISSUE_DESIGNER_CAPABILITY_MESSAGES[issueCode]) return ISSUE_DESIGNER_CAPABILITY_MESSAGES[issueCode];
  if (/^MISSING_STATE_/.test(issueCode)) {
    return "Add a \"" + issueCode.replace("MISSING_STATE_", "").toLowerCase() + "\" variant to the component set.";
  }
  return "This change needs a design decision — the plugin cannot apply it automatically.";
}

function getIssueCapability(issueCode, ctx) {
  ctx = ctx || {};

  if (issueCode === "NON_COMPONENT_ELEMENT") {
    const node = ctx.targetNode || ctx.rootNode || null;
    return getNonComponentCapability(node);
  }

  let cap = ISSUE_CAPABILITY[issueCode];

  if (cap === "AUTO" && (issueCode === "MISSING_STATE_FOCUS" || issueCode === "MISSING_FOCUS_RING")) {
    const root = ctx.rootNode;
    if (root && root.type !== "COMPONENT_SET" && root.type !== "COMPONENT") {
      cap = "FIGMA_AI";
    }
  }

  if (!cap) {
    if (/^MISSING_STATE_/.test(issueCode) &&
        issueCode !== "MISSING_STATE_FOCUS" &&
        issueCode !== "MISSING_STATE_DISABLED") {
      return "DESIGNER";
    }
    if (AUTO_FIX_HANDLERS && AUTO_FIX_HANDLERS.hasOwnProperty(issueCode)) return "AUTO";
    return "DESIGNER";
  }
  return cap;
}

// Issue codes the engine emits → handler. Codes without a handler fall through
// to acknowledge-only UI (no Auto-fix button).
var ISSUE_FIX_META = {
  COLOR_ONLY_DISABLED:     { fixKind: "annotation" },
  RADIO_NO_LABEL:          { fixKind: "ai_content" },
  ERROR_COLOR_ONLY_VERIFY: { fixKind: "ai_content" },
  ROLE_BUTTON_MISSING:       { fixKind: "annotation" },
  ROLE_TEXTBOX_MISSING:      { fixKind: "annotation" },
  ROLE_CHECKBOX_MISSING:     { fixKind: "annotation" },
  ARIA_CHECKED_MISSING:      { fixKind: "annotation" },
  ROLE_RADIOGROUP_MISSING:   { fixKind: "annotation" },
  ROLE_COMBOBOX_MISSING:     { fixKind: "annotation" },
  ARIA_EXPANDED_MISSING:     { fixKind: "annotation" },
  ROLE_DIALOG_MISSING:       { fixKind: "annotation" },
  ARIA_MODAL_MISSING:        { fixKind: "annotation" },
  ROLE_TABLIST_MISSING:      { fixKind: "annotation" },
  ARIA_SELECTED_MISSING:     { fixKind: "annotation" },
  TABS_NO_TAB_ITEMS:         { fixKind: "annotation" },
  TABS_NO_TABPANEL:          { fixKind: "annotation" },
  ROLE_SLIDER_MISSING:       { fixKind: "annotation" },
  SLIDER_ARIA_VALUE_MISSING: { fixKind: "annotation" },
  RATING_ROLE_MISSING:       { fixKind: "annotation" },
  ROLE_SWITCH_MISSING:       { fixKind: "annotation" },
  ACCORDION_NO_HEADING:        { fixKind: "annotation" },
  ACCORDION_HEADER_NOT_BUTTON: { fixKind: "annotation" },
  FOCUS_TRAP_VERIFY:         { fixKind: "annotation" },
  STAR_MISSING_ARIA_LABEL:   { fixKind: "annotation" },
};

async function enrichIssueFixMeta(issues, rootNode) {
  if (!issues || !issues.length) return;
  let ackMap = {};
  if (rootNode && rootNode.getPluginData) {
    try { ackMap = JSON.parse(rootNode.getPluginData("a11y.acknowledged") || "{}"); } catch (_e) { ackMap = {}; }
  }
  for (let qi = 0; qi < issues.length; qi++) {
    const code = issues[qi].code;
    const meta = ISSUE_FIX_META[code] || {};
    const targetNode = await getIssueTargetNode(issues[qi], rootNode);
    const pending = readDesignerPending(targetNode);
    const waitingAi = readWaitingForAi(rootNode);
    const capability = getIssueCapability(code, { rootNode: rootNode, targetNode: targetNode });

    issues[qi].capability = capability;

    if (waitingAi && waitingAi.issueCode === code) {
      issues[qi].waitingForAi = true;
      issues[qi].waitingSince = waitingAi.markedAt;
      issues[qi].waitingPrompt = waitingAi.prompt || "";
      issues[qi].autoFixable = false;
    }
    if (pending && pending.issueCode === code) {
      issues[qi].designerPending = true;
      issues[qi].pendingSince = pending.markedAt;
      issues[qi].pendingMessage = pending.message || "";
      issues[qi].autoFixable = false;
    }

    if (!issues[qi].designerPending && !issues[qi].waitingForAi) {
      if (capability === "AUTO") {
        issues[qi].autoFixable = true;
        issues[qi].fixKind = meta.fixKind || "visual";
      } else if (capability === "FIGMA_AI") {
        issues[qi].autoFixable = false;
        issues[qi].fixKind = "figma_ai";
        issues[qi].figmaAiPrompt = buildFigmaAiPromptForIssue(issues[qi], targetNode, rootNode);
      } else {
        issues[qi].autoFixable = false;
        issues[qi].fixKind = "designer_only";
        if (!issues[qi].designerMessage) {
          issues[qi].designerMessage = meta.designerMessage || getDesignerCapabilityMessage(code);
        }
      }
    }

    if (capability === "FIGMA_AI" && !issues[qi].figmaAiPrompt) {
      issues[qi].figmaAiPrompt = buildFigmaAiPromptForIssue(issues[qi], targetNode, rootNode);
    }
    if (meta.designerMessage && capability === "DESIGNER") {
      issues[qi].designerMessage = meta.designerMessage;
    }
    if (ackMap[code]) issues[qi].acknowledged = true;
  }
}

const AUTO_FIX_HANDLERS = {
  "NO_GROUP_LABEL":         fixNoGroupLabel,
  "NO_INPUT_LABEL":         fixNoInputLabel,
  "ICON_BUTTON_NO_LABEL":   fixIconButtonNoLabel,
  "MISSING_STATE_FOCUS":    fixMissingFocusState,
  "MISSING_FOCUS_RING":     fixMissingFocusState,
  "MISSING_STATE_DISABLED": fixMissingDisabledState,
  "TOUCH_TARGET_SMALL":     fixTouchTargetSmall,
  "DIALOG_NO_CLOSE":        fixDialogNoClose,
  "DIALOG_NO_HEADING":      fixDialogNoHeading,
  "ACCORDION_NO_HEADING":        fixAccordionNoHeadingAnnotation,
  "ACCORDION_HEADER_NOT_BUTTON": fixAccordionHeaderButtons,
  "NON_COMPONENT_ELEMENT":     fixNonComponentElementHandler,
  "CONTRAST_TEXT_FAIL":     fixLowContrast,
  "LOW_CONTRAST":           fixLowContrast,
  "CONTRAST_FAIL":          fixLowContrast,
  "NON_TEXT_CONTRAST_FAIL": fixNonTextContrast,
  "COMBOBOX_NO_CHEVRON":    fixChevronIndicator,
  "STAR_MISSING_ARIA_LABEL": fixStarAriaLabels,
  "REQUIRED_NOT_INDICATED": fixRequiredIndicator,
  "RADIO_NO_LABEL":         fixRadioLabels,
  "ERROR_COLOR_ONLY_VERIFY": fixErrorMessageText,
  "SLIDER_VALUE_NOT_VISIBLE": fixSliderValueVisible,
  "RATING_VALUE_NOT_COMMUNICATED": fixStarCurrentValue,
  "COLOR_ONLY_DISABLED":    fixOnOffStateAnnotate,
  "FOCUS_TRAP_VERIFY":      fixFocusTrapDescribed,
  "ROLE_BUTTON_MISSING":       makeAnnotationFixHandler("ROLE_BUTTON_ANNOTATED"),
  "ROLE_TEXTBOX_MISSING":      makeAnnotationFixHandler("ROLE_TEXTBOX_ANNOTATED"),
  "ROLE_CHECKBOX_MISSING":     makeAnnotationFixHandler("ROLE_CHECKBOX_ANNOTATED"),
  "ARIA_CHECKED_MISSING":      makeAnnotationFixHandler("ARIA_CHECKED_ANNOTATED"),
  "ROLE_RADIOGROUP_MISSING":   makeAnnotationFixHandler("ROLE_RADIOGROUP_ON_CONTAINER"),
  "ROLE_COMBOBOX_MISSING":     makeAnnotationFixHandler("ROLE_COMBOBOX_OR_LISTBOX"),
  "ARIA_EXPANDED_MISSING":     makeAnnotationFixHandler("EXPANSION_STATE_ANNOTATED"),
  "ROLE_DIALOG_MISSING":       makeAnnotationFixHandler("ROLE_DIALOG_ANNOTATED"),
  "ARIA_MODAL_MISSING":        makeAnnotationFixHandler("ARIA_MODAL_TRUE"),
  "ROLE_TABLIST_MISSING":      makeAnnotationFixHandler("ROLE_TABLIST_ON_CONTAINER"),
  "ARIA_SELECTED_MISSING":     makeAnnotationFixHandler("ARIA_SELECTED_ANNOTATED"),
  "TABS_NO_TAB_ITEMS":         makeAnnotationFixHandler("ROLE_TAB_ON_ITEMS"),
  "TABS_NO_TABPANEL":          makeAnnotationFixHandler("ROLE_TABPANEL_ON_PANEL"),
  "ROLE_SLIDER_MISSING":       makeAnnotationFixHandler("ROLE_SLIDER_ANNOTATED"),
  "SLIDER_ARIA_VALUE_MISSING": makeAnnotationFixHandler("ARIA_VALUE_NOW_MIN_MAX"),
  "RATING_ROLE_MISSING":       makeAnnotationFixHandler("ROLE_GROUP_OR_IMG"),
  "ROLE_SWITCH_MISSING":       makeAnnotationFixHandler("ROLE_SWITCH_ANNOTATED"),
  "ACCORDION_PANEL_REGION":    makeAnnotationFixHandler("PANEL_HAS_REGION_ROLE"),
};

// Codes the user can ALWAYS attempt to auto-fix (UI shows the Auto-fix button)
function autoFixAvailable(issueCode) {
  return AUTO_FIX_HANDLERS.hasOwnProperty(issueCode);
}

// ─── Debug: matrix check ↔ autofix coverage ───────────────────────────────────
// AUTO_FIX_HANDLERS keys are issue codes (NO_INPUT_LABEL), not matrix check IDs (HAS_LABEL).
// Run from UI DevTools: reportFixCoverage()  — or main sandbox console (see globalThis).

var MATRIX_CHECK_FIX_BRIDGE = {
  HAS_ACCESSIBLE_NAME:        ["ICON_BUTTON_NO_LABEL"],
  HAS_LABEL:                  ["NO_INPUT_LABEL"],
  PLACEHOLDER_NOT_ONLY_LABEL: ["NO_INPUT_LABEL"],
  GROUP_HAS_LABEL:            ["NO_GROUP_LABEL"],
  GROUP_LABEL_IF_IN_GROUP:    ["NO_GROUP_LABEL"],
  CONTRAST_TEXT:              ["CONTRAST_TEXT_FAIL", "LOW_CONTRAST", "CONTRAST_FAIL"],
  CONTRAST_NON_TEXT:          ["NON_TEXT_CONTRAST_FAIL"],
  FOCUS_RING_VISIBLE:         ["MISSING_FOCUS_RING"],
  STATE_COVERAGE_CORE:        ["MISSING_STATE_FOCUS", "MISSING_STATE_DISABLED"],
  STATE_COVERAGE_INPUT:       ["MISSING_STATE_FOCUS"],
  STATE_COVERAGE_CHECKBOX:    ["MISSING_STATE_FOCUS", "MISSING_STATE_DISABLED"],
  STATE_COVERAGE_SELECT:      ["MISSING_STATE_FOCUS"],
  STATE_COVERAGE_SLIDER:      ["MISSING_STATE_FOCUS"],
  STATE_COVERAGE_TOGGLE:      ["MISSING_STATE_FOCUS", "MISSING_STATE_DISABLED"],
  TOUCH_TARGET_44:            ["TOUCH_TARGET_SMALL"],
  TOUCH_TARGET_24_WITH_SPACING: ["TOUCH_TARGET_SMALL"],
  HAS_HEADING:                ["DIALOG_NO_HEADING", "ACCORDION_NO_HEADING"],
  CLOSE_BUTTON_HAS_LABEL:     ["DIALOG_NO_CLOSE"],
  ACCORDION_HEADERS_ARE_BUTTONS: ["ACCORDION_HEADER_NOT_BUTTON"],
  ROLE_BUTTON_ANNOTATED:      ["ROLE_BUTTON_MISSING"],
  ROLE_TEXTBOX_ANNOTATED:     ["ROLE_TEXTBOX_MISSING"],
  ROLE_CHECKBOX_ANNOTATED:    ["ROLE_CHECKBOX_MISSING"],
  ARIA_CHECKED_ANNOTATED:     ["ARIA_CHECKED_MISSING"],
  ROLE_RADIOGROUP_ON_CONTAINER: ["ROLE_RADIOGROUP_MISSING"],
  ROLE_RADIO_ON_ITEMS:        ["RADIO_NO_LABEL"],
  ROLE_COMBOBOX_OR_LISTBOX:   ["ROLE_COMBOBOX_MISSING"],
  EXPANSION_STATE_ANNOTATED:  ["ARIA_EXPANDED_MISSING"],
  ARIA_EXPANDED_ANNOTATED:    ["ARIA_EXPANDED_MISSING"],
  CHEVRON_OR_EXPAND_INDICATOR: ["COMBOBOX_NO_CHEVRON"],
  ROLE_DIALOG_ANNOTATED:      ["ROLE_DIALOG_MISSING"],
  ARIA_MODAL_TRUE:            ["ARIA_MODAL_MISSING"],
  FOCUS_TRAP_DESCRIBED:       ["FOCUS_TRAP_VERIFY"],
  ROLE_TABLIST_ON_CONTAINER:  ["ROLE_TABLIST_MISSING"],
  ROLE_TAB_ON_ITEMS:          ["TABS_NO_TAB_ITEMS"],
  ARIA_SELECTED_ANNOTATED:    ["ARIA_SELECTED_MISSING"],
  ROLE_TABPANEL_ON_PANEL:     ["TABS_NO_TABPANEL"],
  ROLE_SLIDER_ANNOTATED:      ["ROLE_SLIDER_MISSING"],
  ARIA_VALUE_NOW_MIN_MAX:     ["SLIDER_ARIA_VALUE_MISSING"],
  VALUE_VISIBLE:              ["SLIDER_VALUE_NOT_VISIBLE"],
  ROLE_GROUP_OR_IMG:          ["RATING_ROLE_MISSING"],
  CURRENT_VALUE_COMMUNICATED: ["RATING_VALUE_NOT_COMMUNICATED"],
  EACH_STAR_DESCRIBED:        ["STAR_MISSING_ARIA_LABEL"],
  ROLE_SWITCH_ANNOTATED:      ["ROLE_SWITCH_MISSING"],
  ON_OFF_STATE_NOT_COLOR_ONLY: ["COLOR_ONLY_DISABLED"],
  PANEL_HAS_REGION_ROLE:      ["ACCORDION_PANEL_REGION"],
  REQUIRED_STATE_INDICATED:   ["REQUIRED_NOT_INDICATED"],
  EACH_RADIO_HAS_LABEL:       ["RADIO_NO_LABEL"],
  ERROR_TEXT_NOT_COLOR_ONLY:  ["ERROR_COLOR_ONLY_VERIFY"],
};

function matrixCheckHasAutofix(checkId) {
  if (AUTO_FIX_HANDLERS.hasOwnProperty(checkId)) return true;
  var codes = MATRIX_CHECK_FIX_BRIDGE[checkId];
  if (!codes) return false;
  for (var i = 0; i < codes.length; i++) {
    if (AUTO_FIX_HANDLERS.hasOwnProperty(codes[i])) return true;
  }
  return false;
}

function buildFixCoverageReport() {
  var allChecks = [];
  var types = Object.keys(COMPONENT_SPEC_MATRIX);
  for (var t = 0; t < types.length; t++) {
    var list = COMPONENT_SPEC_MATRIX[types[t]];
    for (var c = 0; c < list.length; c++) allChecks.push(list[c]);
  }
  var unique = [];
  for (var i = 0; i < allChecks.length; i++) {
    if (unique.indexOf(allChecks[i]) < 0) unique.push(allChecks[i]);
  }

  var withFix = unique.filter(function(id) { return matrixCheckHasAutofix(id); });
  var withoutFix = unique.filter(function(id) { return !matrixCheckHasAutofix(id); });
  var handlerKeys = Object.keys(AUTO_FIX_HANDLERS);

  var lines = [
    "=== FIX COVERAGE REPORT ===",
    "Total checks: " + unique.length,
    "With autofix (via issue bridge): " + withFix.length,
    "Missing autofix: " + withoutFix.length,
    "",
    "MISSING:",
  ];
  withoutFix.forEach(function(id) { lines.push(" ✗ " + id); });
  lines.push("");
  lines.push("IMPLEMENTED:");
  withFix.forEach(function(id) { lines.push(" ✓ " + id); });
  lines.push("");
  lines.push("--- AUTO_FIX_HANDLERS (issue codes) ---");
  lines.push("Count: " + handlerKeys.length);
  handlerKeys.forEach(function(code) { lines.push(" ✓ " + code); });

  return { lines: lines, total: unique.length, withFix: withFix.length, withoutFix: withoutFix.length };
}

function reportFixCoverage() {
  var report = buildFixCoverageReport();
  for (var i = 0; i < report.lines.length; i++) console.log(report.lines[i]);
  return report;
}

function exposeDebugApi() {
  try {
    if (typeof globalThis !== "undefined") globalThis.reportFixCoverage = reportFixCoverage;
  } catch (_e) {}
  try {
    if (typeof self !== "undefined") self.reportFixCoverage = reportFixCoverage;
  } catch (_e) {}
  try {
    figma._a11yDebug = figma._a11yDebug || {};
    figma._a11yDebug.reportFixCoverage = reportFixCoverage;
  } catch (_e) {}
}
exposeDebugApi();

// ─── Two-layer issue messaging ───────────────────────────────────────────────
// LAYER 1: A short, designer-friendly title. Generated by AI when available,
//          falls back to ISSUE_EXPLANATIONS[code].staticTitle.
// LAYER 2: A static "Why it matters" explanation shown in a slide-in panel.
//          Pure data — no AI needed.

const ISSUE_EXPLANATIONS = {
  "NO_GROUP_LABEL": {
    staticTitle: "Group of options has no visible label above it",
    why:         "Screen readers announce each option in isolation when the group has no label. Users hear \"radio button\" or \"checkbox\" with no idea what they're selecting from.",
    example: {
      before: "<RadioGroup>\n  <Radio>Small</Radio>\n  <Radio>Medium</Radio>\n</RadioGroup>",
      after:  "<fieldset>\n  <legend>Size</legend>\n  <RadioGroup>…</RadioGroup>\n</fieldset>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
  },
  "NO_INPUT_LABEL": {
    staticTitle: "Text input is missing a visible label",
    why:         "Placeholder text disappears when the user starts typing — it is not a substitute for a label. Without a label, screen readers cannot announce the field's purpose and users with cognitive disabilities lose orientation.",
    example: {
      before: "<input placeholder=\"Email\">",
      after:  "<label for=\"email\">Email</label>\n<input id=\"email\" type=\"email\">",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html",
    apgLink:  "https://www.w3.org/WAI/tutorials/forms/labels/",
  },
  "FOCUS_RING_CONTRAST_FAIL": {
    staticTitle: "Focus ring is too faint against its background",
    why:         "Keyboard users rely on the focus ring to know which element will activate next. When the ring contrasts poorly with the surrounding area, sighted keyboard users lose their place entirely.",
    example: {
      before: "outline: 2px solid #DDD;  /* 1.4:1 on white */",
      after:  "outline: 2px solid #1A73E8; /* 4.5:1 on white */",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/",
  },
  "NON_COMPONENT_ELEMENT": {
    staticTitle: "Interactive element is not a Figma component",
    why:         "Developers and assistive tech rely on stable component structure. A loose frame or group does not carry variants, states, or Dev Mode metadata the way a component does.",
    example: {
      before: "Frame named \"button / submit\" (not a component)",
      after:  "Component instance with default, hover, focus, and disabled variants",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/",
  },
  "MISSING_FOCUS_RING": {
    staticTitle: "Component has no visible focus indicator",
    why:         "When a sighted user navigates with the keyboard, they need a visible signal showing which element has focus. Removing the outline without a replacement makes the interface unusable for them.",
    example: {
      before: "button:focus { outline: none; }",
      after:  "button:focus-visible {\n  outline: 2px solid #1A73E8;\n  outline-offset: 2px;\n}",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/",
  },
  "TOUCH_TARGET_SMALL": {
    staticTitle: "Tap target is smaller than 44 × 44 pixels",
    why:         "Users with limited dexterity, tremors, or large fingers struggle to hit small targets. On mobile, a 24px button fails roughly one in five tap attempts. WCAG 2.5.5 recommends 44px minimum, 2.5.8 requires 24px.",
    example: {
      before: "<button style=\"width: 24px; height: 24px\">×</button>",
      after:  "<button style=\"min-width: 44px; min-height: 44px\">×</button>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/structural-roles/",
  },
  "TOUCH_TARGET_CRITICAL": {
    staticTitle: "Tap target is below the 24px absolute minimum",
    why:         "WCAG 2.5.8 makes 24×24 a hard floor. Below this size, even users without motor impairments routinely miss the target. There is no exception clause — this must be resized.",
    example: {
      before: "width: 18px; height: 18px",
      after:  "width: 44px; height: 44px",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/structural-roles/",
  },
  "ACCORDION_BUTTON_CONTAINS_HEADING": {
    staticTitle: "Accordion has the wrong heading + button order",
    why:         "Screen reader users navigate by heading. When the heading is inside the button, the heading disappears from the document outline and the button announcement becomes verbose. The required pattern is heading > button, not button > heading.",
    example: {
      before: "<button>\n  <h3>Section 1</h3>\n</button>",
      after:  "<h3>\n  <button aria-expanded=\"false\">Section 1</button>\n</h3>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/",
  },
  "ACCORDION_NO_HEADING": {
    staticTitle: "Accordion is missing an accessible heading label",
    why:         "Accordions need a section title for screen reader users — via visible heading text, aria-label, or aria-labelledby. Without it, users cannot orient themselves in the FAQ or section list.",
    example: {
      before: "No heading text or aria-label on accordion root",
      after:  "aria-label=\"Frequently asked questions\" on accordion container",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/",
  },
  "ACCORDION_HEADER_NOT_BUTTON": {
    staticTitle: "Accordion row trigger is not annotated as a button",
    why:         "Each accordion row trigger must expose role=\"button\" with aria-expanded so assistive tech knows it is expandable. Dev Mode handoff requires aria-role=button on each direct row child.",
    example: {
      before: "Row frame with no aria-role annotation",
      after:  "setSharedPluginData(\"a11y\", \"aria-role\", \"button\") on each row trigger",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/accordion/",
  },
  "DIALOG_NO_HEADING": {
    staticTitle: "Dialog has no heading at the top",
    why:         "Dialogs need a visible heading so the user knows what just opened. The heading is also used as the accessible name of the dialog via aria-labelledby — without it, the dialog announces only its role.",
    example: {
      before: "<div role=\"dialog\">…</div>",
      after:  "<div role=\"dialog\" aria-labelledby=\"dlg-title\">\n  <h2 id=\"dlg-title\">Confirm deletion</h2>\n  …\n</div>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
  },
  "DIALOG_NO_CLOSE": {
    staticTitle: "Dialog has no close button",
    why:         "Users who get into a dialog must be able to get out. Without a visible close control, keyboard and screen reader users can be trapped (a WCAG 2.1.2 violation). Escape key alone is not discoverable.",
    example: {
      before: "<div role=\"dialog\">\n  <h2>Title</h2>\n  …\n</div>",
      after:  "<div role=\"dialog\">\n  <h2>Title</h2>\n  <button aria-label=\"Close dialog\">×</button>\n  …\n</div>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
  },
  "ERROR_COLOR_ONLY_VERIFY": {
    staticTitle: "Error state may be conveyed by color alone",
    why:         "Roughly 1 in 12 men and 1 in 200 women have some form of color vision deficiency. Showing errors only by turning a border red excludes them. Pair color with an icon, message text, or a shape change.",
    example: {
      before: "input.error { border-color: red; }",
      after:  "input.error { border-color: red; }\n.error-icon { display: inline; }\n.error-message { display: block; }",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html",
    apgLink:  "https://www.w3.org/WAI/tutorials/forms/notifications/",
  },
  "STATE_MISSING": {
    staticTitle: "Component is missing a required interaction state",
    why:         "Each interactive component must visually express every state it can be in — at minimum default, hover, focus, and disabled. Missing states create a confusing experience and often break keyboard accessibility entirely.",
    example: {
      before: "<button class=\"btn\">Save</button>",
      after:  "/* All four states defined */\n.btn { … }\n.btn:hover { … }\n.btn:focus-visible { outline: 2px solid #1A73E8 }\n.btn[disabled] { opacity: 0.4 }",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/",
  },
  "CONTRAST_FAIL": {
    staticTitle: "Text contrast is below the WCAG minimum",
    why:         "Low-contrast text is unreadable for users with low vision, in bright sunlight, or on low-quality screens. Normal text needs at least 4.5:1 contrast against its background; large text (18px+ or 14px bold+) needs 3:1.",
    example: {
      before: "color: #999;  background: #FFF;  /* 2.85:1 — fails */",
      after:  "color: #595959; background: #FFF; /* 7:1 — passes */",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html",
    apgLink:  "https://www.w3.org/WAI/tutorials/page-structure/styling/",
  },
  "ICON_BUTTON_NO_LABEL": {
    staticTitle: "Icon-only button has no accessible name",
    why:         "When a button shows only an icon, screen readers announce it as an unlabeled \"button\" with no purpose. Users cannot tell what will happen if they activate it. Add visible text, aria-label, or an aria-labelledby reference to descriptive text.",
    example: {
      before: "<button><svg aria-hidden=\"true\">…</svg></button>",
      after:  "<button aria-label=\"Close dialog\"><svg aria-hidden=\"true\">…</svg></button>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/button/",
  },
  "RADIO_NO_LABEL": {
    staticTitle: "Radio option is missing an accessible name",
    why:         "Each radio in a group must have a name so assistive tech can announce the specific choice (e.g. \"Credit card, radio button, not checked\"). Without a label tied to the control, users only hear \"radio button\".",
    example: {
      before: "<input type=\"radio\" name=\"pay\" />",
      after:  "<input type=\"radio\" id=\"pay-cc\" name=\"pay\" />\n<label for=\"pay-cc\">Credit card</label>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
  },
  "STAR_MISSING_ARIA_LABEL": {
    staticTitle: "Star in rating group is missing an aria-label",
    why:         "Star ratings are usually implemented as a radio group. Each star must announce its value (e.g. \"3 stars\") so screen reader users know what they are selecting, not just \"button\" or \"image\".",
    example: {
      before: "<button class=\"star\">★</button>",
      after:  "<button class=\"star\" aria-label=\"3 stars\">★</button>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
  },
  "COMBOBOX_NO_CHEVRON": {
    staticTitle: "Select/dropdown may lack a visible open indicator",
    why:         "A combobox or custom select should show that it opens a list — typically with a chevron or \"opens popup\" cue. Decorative chevrons must be aria-hidden so they are not read twice.",
    example: {
      before: "<div role=\"combobox\">Country</div>",
      after:  "<div role=\"combobox\" aria-expanded=\"false\">Country <span aria-hidden=\"true\">▾</span></div>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/",
  },
  "CHIP_REMOVE_NO_LABEL": {
    staticTitle: "Removable chip has no label on its dismiss control",
    why:         "Chips with a remove (×) button need an accessible name on that control — e.g. aria-label=\"Remove tag Design\". Otherwise screen reader users hear only \"button\" with no context.",
    example: {
      before: "<button>×</button>",
      after:  "<button aria-label=\"Remove tag Design\">×</button>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/button/",
  },
  "COLOR_ONLY_DISABLED": {
    staticTitle: "Disabled state may rely on color or opacity alone",
    why:         "Lowering opacity or graying out without other cues can be missed by users with low vision or color blindness. Pair reduced emphasis with a cursor change, strikethrough, or explicit \"disabled\" text where possible.",
    example: {
      before: ".btn[disabled] { opacity: 0.4; }",
      after:  ".btn[disabled] { opacity: 0.4; cursor: not-allowed; aria-disabled=\"true\" }",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/",
  },
  "FOCUS_RING_CONTRAST_UNKNOWN": {
    staticTitle: "Focus ring contrast could not be verified automatically",
    why:         "Keyboard users need a focus indicator that stands out against whatever is behind it. Automated checks sometimes cannot sample the exact pixels. Verify manually that the ring is clearly visible on all backgrounds.",
    example: {
      before: "outline: 1px solid #E0E0E0; /* may fail on pale backgrounds */",
      after:  "outline: 2px solid #1A73E8; outline-offset: 2px;",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html",
    apgLink:  "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html",
  },
  "NO_INDETERMINATE_STATE": {
    staticTitle: "Checkbox group may need an indeterminate (mixed) state",
    why:         "Select-all checkboxes in a list often use aria-checked=\"mixed\" when only some children are selected. Without that state, assistive tech cannot convey partial selection accurately.",
    example: {
      before: "<input type=\"checkbox\" aria-checked=\"false\" />",
      after:  "<input type=\"checkbox\" aria-checked=\"mixed\" />",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    apgLink:  "https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/",
  },
  "NO_ERROR_STATE": {
    staticTitle: "Input is missing a dedicated error state variant",
    why:         "When validation fails, users need more than a red border — error text, aria-invalid, and aria-describedby linking to the message. A distinct error variant helps designers and developers ship the full pattern.",
    example: {
      before: "<input class=\"invalid\" style=\"border-color:red\">",
      after:  "<input aria-invalid=\"true\" aria-describedby=\"email-err\">\n<span id=\"email-err\" role=\"alert\">Enter a valid email</span>",
    },
    wcagLink: "https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html",
    apgLink:  "https://www.w3.org/WAI/tutorials/forms/notifications/",
  },
};

// Map our internal audit codes to their canonical explanation key.
// Several codes share an explanation (e.g. MISSING_STATE_FOCUS → STATE_MISSING).
const EXPLANATION_ALIASES = {
  "MISSING_STATE_FOCUS":    "STATE_MISSING",
  "MISSING_STATE_HOVER":    "STATE_MISSING",
  "MISSING_STATE_DISABLED": "STATE_MISSING",
  "MISSING_STATE_ACTIVE":   "STATE_MISSING",
  "MISSING_STATE_LOADING":  "STATE_MISSING",
  "MISSING_STATE_ERROR":    "STATE_MISSING",
  "CONTRAST_TEXT_FAIL":     "CONTRAST_FAIL",
  "NO_ERROR_STATE":         "ERROR_COLOR_ONLY_VERIFY",
};

function getExplanation(code) {
  const key = EXPLANATION_ALIASES[code] || code;
  return ISSUE_EXPLANATIONS[key] || null;
}

// LAYER 1: Generate short, contextual titles via OpenAI.
// Batched into ONE call (all issues in a single request) so we pay one round-trip
// instead of N. Returns a `{ code: title }` map or null on any failure.
async function generateContextualTitles(issues, rootNode, ctx, apiKey) {
  if (!apiKey || !issues || issues.length === 0) return null;

  // Dedupe: same code repeated → one entry
  const uniqueCodes = {};
  for (let i = 0; i < issues.length; i++) uniqueCodes[issues[i].code] = true;
  const codeList = Object.keys(uniqueCodes);
  if (codeList.length === 0) return null;

  const optionTexts   = collectOptionTexts(rootNode).slice(0, 6).join(", ").slice(0, 200);
  const componentType = (ctx && ctx.componentType) || (rootNode && rootNode.name) || "component";

  const systemPrompt =
    "You write short, designer-friendly accessibility issue titles. Each title is 10-15 words, " +
    "uses plain language, contains no WCAG codes and no technical jargon. " +
    "Return ONLY a valid JSON object mapping each issue code to its title. " +
    "Example: {\"NO_GROUP_LABEL\": \"Group of options has no visible label above it\"}";

  const userPrompt =
    "Component type: " + componentType + "\n" +
    "Component name: " + (rootNode ? rootNode.name : "") + "\n" +
    "Visible text inside: " + (optionTexts || "(none)") + "\n" +
    "Issue codes needing titles: " + codeList.join(", ") + "\n" +
    "Return one title per code as a single JSON object. No prose around the JSON.";

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 400, // 11 codes × ~30 tokens each is more than enough
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt   },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data    = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return null;
    const parsed  = JSON.parse(content);
    // Cap each title at 80 chars per spec
    const titles  = {};
    for (let k in parsed) {
      if (parsed.hasOwnProperty(k) && typeof parsed[k] === "string") {
        titles[k] = parsed[k].slice(0, 80).trim().replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, "");
      }
    }
    return titles;
  } catch (_e) { return null; }
}

// Mutates each issue in place to attach displayTitle + explanation.
async function enrichIssuesWithTitlesAndExplanations(issues, rootNode, ctx, apiKey) {
  if (!issues || issues.length === 0) return;

  // Always attach static fallbacks first — UI can show them immediately if AI fails
  for (let i = 0; i < issues.length; i++) {
    const exp = getExplanation(issues[i].code);
    issues[i].displayTitle = (exp && exp.staticTitle) ? exp.staticTitle : issues[i].message;
    issues[i].explanation  = exp;
  }

  // Then try to upgrade titles via AI in a single batched call
  const aiTitles = await generateContextualTitles(issues, rootNode, ctx, apiKey);
  if (aiTitles) {
    for (let i = 0; i < issues.length; i++) {
      const t = aiTitles[issues[i].code];
      if (typeof t === "string" && t.length > 0) issues[i].displayTitle = t;
    }
  }
}

async function applyAllIssueFixes(rootNode, issues, opts) {
  opts = opts || {};
  const dest = opts.annotationDestination || await getAnnotationDestination();
  const effectiveDest = dest === "ask" ? "devmode" : dest;
  const fixable = [];
  for (let i = 0; i < (issues || []).length; i++) {
    const iss = issues[i];
    const issCap = iss.capability ||
      getIssueCapability(iss.code, { rootNode: rootNode, targetNode: rootNode });
    if (issCap !== "AUTO") continue;
    if (!AUTO_FIX_HANDLERS[iss.code]) continue;
    if (iss.fixKind === "message_only" || iss.fixKind === "figma_ai" || iss.fixKind === "designer_only") continue;
    if (iss.designerPending || iss.waitingForAi) continue;
    if (iss.acknowledged || iss.fixed) continue;
    if (iss.severity === "MANUAL") continue;
    fixable.push(iss);
  }

  if (opts.fixOrder === "blockers-first") {
    const high = fixable.filter(function(iss) { return iss.severity === "HIGH"; });
    const rest = fixable.filter(function(iss) { return iss.severity !== "HIGH"; });
    fixable.length = 0;
    for (let hi = 0; hi < high.length; hi++) fixable.push(high[hi]);
    for (let ri = 0; ri < rest.length; ri++) fixable.push(rest[ri]);
  }

  const total = fixable.length;
  let fixed = 0;
  let failed = 0;
  if (total === 0) return { fixed: 0, failed: 0, total: 0 };

  const apiKey = await figma.clientStorage.getAsync("openai-api-key");
  const progressLabels = {
    CONTRAST_TEXT_FAIL: "Analyzing contrast\u2026",
    CONTRAST_FAIL:      "Analyzing contrast\u2026",
    LOW_CONTRAST:       "Adjusting color to meet 4.5:1\u2026",
    NON_TEXT_CONTRAST_FAIL: "Adjusting component contrast\u2026",
  };

  for (let i = 0; i < fixable.length; i++) {
    const iss = fixable[i];
    const label = progressLabels[iss.code] ||
      ("Fixing: " + (iss.displayTitle || iss.message || iss.code).slice(0, 50));
    figma.ui.postMessage({
      type: "FIX_PROGRESS", step: i + 1, total: total, label: label,
      status: "running", issueCode: iss.code,
    });
    await new Promise(function(r) { setTimeout(r, 300); });
    const targetNode = (await getIssueTargetNode(iss, rootNode)) || rootNode;
    try {
      const result = await AUTO_FIX_HANDLERS[iss.code]({
        node:                  targetNode,
        rootNode:              rootNode,
        strategy:              "generic",
        apiKey:                apiKey,
        issueCode:             iss.code,
        annotationDestination: effectiveDest,
        detectedRole:          opts.detectedRole,
      });
      if (result && result.ok) {
        fixed++;
        figma.ui.postMessage({
          type: "FIX_PROGRESS", step: i + 1, total: total,
          label: result.message || "Fixed", status: "ok", issueCode: iss.code,
        });
      } else {
        failed++;
        figma.ui.postMessage({
          type: "FIX_PROGRESS", step: i + 1, total: total,
          label: (result && result.message) || "Could not fix", status: "fail", issueCode: iss.code,
        });
      }
    } catch (e) {
      failed++;
      figma.ui.postMessage({
        type: "FIX_PROGRESS", step: i + 1, total: total,
        label: String(e).slice(0, 80), status: "fail", issueCode: iss.code,
      });
    }
  }
  return { fixed: fixed, failed: failed, total: total };
}

async function analyzeNodeAndPost(rootNode, options) {
  options = options || {};
  const previousIssues = options.previousIssues || [];

  if (isA11yGeneratedLayer(rootNode)) {
    notifyScanSkipped(rootNode);
    return;
  }

  if (!options.skipSnapshot) await saveA11ySnapshot(rootNode);

  const ctx = await gatherContext(rootNode);
  let detection = detectComponent(ctx, rootNode);
  ctx.competitorRole = detection.competitorRole || null;

  if (detection.needsVisionTiebreak) {
    const tieKey = await figma.clientStorage.getAsync("openai-api-key");
    if (tieKey) {
      figma.ui.postMessage({ type: "AI_LOADING", phase: "vision" });
      try {
        const visionResult = await classifyWithVision(rootNode, tieKey);
        const visionSpec   = findSpecByRoleHint(visionResult.role);
        if (visionSpec) {
          detection = Object.assign({}, detection, {
            role:               visionSpec.role,
            spec:               visionSpec,
            reasoning:          "Vision tiebreak vs " + (detection.competitorRole || "?") + ": " +
                                (visionResult.reasoning || visionSpec.role),
            detectionPath:      "vision-tiebreak",
            confidence:         visionResult.confidence || "MED",
            needsVisionTiebreak: false,
          });
        }
      } catch (_tieErr) { /* keep spec-engine winner */ }
    }
  }

  const auditResult  = detection.spec ? await auditNode(rootNode, detection.spec, ctx) : { issues: [], auditLog: [] };
  const issues       = auditResult.issues;
  const auditLog     = auditResult.auditLog;

  if (issues.length > 0) {
    const apiKeyForTitles = await figma.clientStorage.getAsync("openai-api-key");
    ctx.componentType = (detection.role || (detection.spec && detection.spec.role) || ctx.nodeType);
    await enrichIssuesWithTitlesAndExplanations(issues, rootNode, ctx, apiKeyForTitles);
    await enrichIssueFixMeta(issues, rootNode);
  }

  refreshDevModeAnnotations(rootNode);
  persistCodegenHandoffFields(rootNode, detection.spec, issues);

  const waitingState = readWaitingForAi(rootNode);
  if (waitingState) {
    const stillOpen = issues.some(function(iss) {
      return iss.code === waitingState.issueCode;
    });
    if (!stillOpen && rootNode.setPluginData) {
      rootNode.setPluginData("a11y-waiting-ai", "");
    }
  }

  const suggestions = detection.spec
    ? generateSuggestions(rootNode, detection.spec, ctx, issues)
    : (detection.suggestions || []);

  const resolvedIssues = [];
  if (previousIssues.length) {
    const remainingKeys = {};
    for (let i = 0; i < issues.length; i++) {
      remainingKeys[issues[i].code + ":" + (issues[i].nodeId || "")] = true;
    }
    for (let j = 0; j < previousIssues.length; j++) {
      const pi = previousIssues[j];
      const key = pi.code + ":" + (pi.nodeId || "");
      if (!remainingKeys[key] && !pi.acknowledged) resolvedIssues.push(pi);
    }
  }

  const pendingDesignerCount = countDesignerPendingIssues(issues);

  const resultPayload = {
    role:           detection.role,
    confidence:     detection.confidence,
    reasoning:      detection.reasoning,
    suggestions:    suggestions,
    askQuestions:   detection.askQuestions,
    issues:         issues,
    auditLog:       auditLog,
    signalDetails:  detection.signalDetails || [],
    signalScore:    detection.signalScore || 0,
    detectionPath:  detection.detectionPath || "rule-engine",
    rankedScores:   detection.rankedScores || [],
    competitorRole: detection.competitorRole || null,
    resolvedIssues: resolvedIssues,
  };

  try {
    const bytes = await exportPreviewNode(rootNode);
    figma.ui.postMessage({
      type:      "UPDATE_PREVIEW",
      ok:        true,
      nodeId:    rootNode.id,
      imageData: figma.base64Encode(bytes),
    });
  } catch (_e) {}

  figma.ui.postMessage({
    type:                 "ANALYSIS_RESULTS",
    nodeId:               rootNode.id,
    nodeName:             rootNode.name,
    nodeType:             rootNode.type,
    result:               resultPayload,
    usedSpec:             !!detection.spec,
    pendingDesignerCount: pendingDesignerCount,
    afterFix:             !!options.afterFix,
  });
}

async function autoFixIssue(params) {
  // params: { issueCode, nodeId, rootNodeId, strategy, annotationDestination, detectedRole, linkAction }
  const node     = await getNodeById(params.nodeId)     || await getNodeById(params.rootNodeId);
  const rootNode = await getNodeById(params.rootNodeId) || node;
  if (!rootNode) {
    return { ok: false, code: params.issueCode, message: "Selection changed. Please re-run analysis." };
  }

  if (params.strategy === "prompt") {
    let prompt = params.figmaAiPrompt || "";
    if (!prompt) {
      prompt = buildFigmaAiPromptForIssue(
        { code: params.issueCode, message: params.message || "" },
        node,
        rootNode
      );
    }
    if (rootNode && rootNode.setPluginData) {
      rootNode.setPluginData("a11y-waiting-ai", JSON.stringify({
        issueCode: params.issueCode,
        markedAt:  Date.now(),
        prompt:    prompt,
      }));
    }
    return {
      ok:                 true,
      code:               params.issueCode,
      source:             "prompt",
      promptForClipboard: prompt,
      waitingForAi:       true,
      message:            "Prompt copied — paste into Figma AI assistant",
    };
  }

  const fixTarget = node || rootNode;
  if (getIssueCapability(params.issueCode, { rootNode: rootNode, targetNode: fixTarget }) !== "AUTO") {
    return {
      ok:      false,
      code:    params.issueCode,
      message: "This issue cannot be fixed automatically by the plugin.",
    };
  }

  const handler = AUTO_FIX_HANDLERS[params.issueCode];
  if (!handler) {
    return {
      ok:      false,
      code:    params.issueCode,
      message: "No auto-fix available for " + params.issueCode + " \u2014 requires designer review.",
    };
  }

  figma.commitUndo();
  const apiKey = await figma.clientStorage.getAsync("openai-api-key");
  try {
    return await handler({
      node:                  node,
      rootNode:              rootNode,
      strategy:              params.strategy || "ai",
      apiKey:                apiKey,
      issueCode:             params.issueCode,
      annotationDestination: params.annotationDestination,
      detectedRole:          params.detectedRole,
      role:                  params.detectedRole,
      linkAction:            params.linkAction,
      linkCandidateId:     params.linkCandidateId,
      skipCandidateIds:      params.skipCandidateIds,
    });
  } catch (e) {
    return { ok: false, code: params.issueCode, message: "Auto-fix failed: " + String(e) };
  }
}

// ─── OpenAI (main thread only) ────────────────────────────────────────────────

async function classifyWithAI(ctx, apiKey) {
  const systemPrompt = `You are an expert Figma accessibility auditor (WCAG 2.1 AA, ARIA APG).
Given a component's context, identify its semantic role. Return ONLY valid JSON:
{
  "role": "button|radioGroup|checkbox|switch|textField|slider|combobox|dialog|tablist|navigation|status|tooltip|accordion|starRating|unknown",
  "confidence": "HIGH|MED|LOW",
  "reasoning": "short explanation",
  "suggestions": [
    { "type": "rename|setPluginData", "nodeId": "__ROOT__|__STAR_CHILDREN__", "value": "...", "label": "..." }
  ],
  "askQuestions": [{ "id": "q1", "question": "...", "options": ["..."] }]
}
askQuestions only when confidence is MED. nodeId must be __ROOT__, __STAR_CHILDREN__, or a semantic slug.`;

  const userPrompt = `Name: ${ctx.nodeName}
Type: ${ctx.nodeType}
Parent: ${ctx.parentName}
Grandparent: ${ctx.grandparentName}
Sibling count: ${ctx.siblingCount}
Sibling names: ${ctx.siblings.slice(0, 8).map((s) => s.name).join(", ")}
Inner text: ${ctx.innerText.slice(0, 5).join(" | ")}
Nearby labels (spatial): ${ctx.nearbyText.slice(0, 5).join(" | ")}
Variant props: ${JSON.stringify(ctx.variantProps)}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

// Map AI / vision role slugs to a COMPONENT_SPECS entry for re-audit.
function findSpecByRoleHint(roleHint) {
  if (!roleHint) return null;
  const r = String(roleHint).toLowerCase().replace(/[\s_()-]+/g, "");
  if (!r || r === "unknown") return null;

  if (r.includes("starrating") || (r.includes("star") && r.includes("rating")))
    return COMPONENT_SPECS.find(function(s) { return s.isStarRating; }) || null;
  if (r.includes("radiogroup") || r === "radio" || r.includes("radio"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "radio-group" && !s.isStarRating; }) || null;
  if (r.includes("textfield") || r.includes("textbox") || r === "input")
    return COMPONENT_SPECS.find(function(s) { return s.role === "textField"; }) || null;
  if (r.includes("checkbox") || r === "check")
    return COMPONENT_SPECS.find(function(s) { return s.role === "checkbox"; }) || null;
  if (r.includes("switch") || r === "toggle")
    return COMPONENT_SPECS.find(function(s) { return s.role === "toggle"; }) || null;
  if (r.includes("tablist") || (r.includes("tab") && r.indexOf("table") < 0))
    return COMPONENT_SPECS.find(function(s) { return s.role === "tablist"; }) || null;
  if (r.includes("slider") || r.includes("range"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "slider"; }) || null;
  if (r.includes("combobox") || r.includes("dropdown") || r.includes("select"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "combobox"; }) || null;
  if (r.includes("dialog") || r.includes("modal") || r.includes("drawer"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "dialog"; }) || null;
  if (r.includes("accordion") || r.includes("faq"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "accordion"; }) || null;
  if (r.includes("button") || r === "cta")
    return COMPONENT_SPECS.find(function(s) { return s.role === "button"; }) || null;
  if (r.includes("chip") || r.includes("badge") || r === "status" || r.includes("tag"))
    return COMPONENT_SPECS.find(function(s) { return s.role === "status"; }) || null;
  return null;
}

// Re-run full spec matrix for a resolved component type (text or vision hint).
async function runSpecsForType(roleHint, rootNode, ctx) {
  const spec = findSpecByRoleHint(roleHint);
  if (!spec) return { spec: null, issues: [], auditLog: [] };
  const audited = await auditNode(rootNode, spec, ctx);
  return { spec: spec, issues: audited.issues, auditLog: audited.auditLog };
}

// Vision fallback when text classification returns unknown (GPT-4o, low detail).
async function classifyWithVision(rootNode, apiKey) {
  const bytes = await rootNode.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: 0.5 },
  });
  const b64 = figma.base64Encode(bytes);

  const systemPrompt =
    "You classify Figma UI components for accessibility auditing. " +
    "Return ONLY valid JSON: {\"role\":\"button|radioGroup|checkbox|switch|textField|slider|" +
    "combobox|dialog|tablist|navigation|status|tooltip|accordion|starRating|unknown\"," +
    "\"confidence\":\"HIGH|MED|LOW\",\"reasoning\":\"one short sentence\"}";

  const userText =
    "What interactive component is this? Name: " + (rootNode.name || "") +
    ". Prefer starRating for star-rating controls; radioGroup for radio sets; combobox for dropdowns.";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64," + b64, detail: "low" },
            },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Vision OpenAI " + resp.status + ": " + err.slice(0, 200));
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("Vision OpenAI returned empty content");
  return JSON.parse(content);
}

// ─── Batch scan helpers (Phase D) ────────────────────────────────────────────

// Collect candidate interactive-component nodes inside a frame.
// Performance rules (per Figma plugin dev guidelines):
//   - allTextNodes pre-collected once by caller → no O(n×m) page.findAll per node
//   - maxDepth caps descent → avoids traversing deeply nested design-system internals
//   - Skip leaf node types that are never interactive components
async function collectScanCandidates(rootFrame, allTextNodes, maxDepth) {
  maxDepth = maxDepth !== undefined ? maxDepth : 5;
  var candidates = [];
  var SKIP_TYPES = { TEXT: true, VECTOR: true, BOOLEAN_OPERATION: true, STAR: true, ELLIPSE: true, LINE: true, RECTANGLE: true };

  async function walk(node, depth) {
    if (!node) return;
    if (isA11yGeneratedLayer(node)) return;
    if (SKIP_TYPES[node.type]) return;
    if (depth > maxDepth) return;

    var ctx = await gatherContext(node, allTextNodes);
    var detection = detectComponent(ctx, node);

    if (detection.spec && detection.signalScore >= 2) {
      candidates.push({ node: node, spec: detection.spec, score: detection.signalScore, ctx: ctx });
      return; // stop descent — don't double-count children of a matched component
    }

    if ("children" in node) {
      // Cap sibling scanning: don't scan more than 40 children at one level
      var limit = Math.min(node.children.length, 40);
      for (var j = 0; j < limit; j++) await walk(node.children[j], depth + 1);
    }
  }

  if ("children" in rootFrame) {
    for (var i = 0; i < rootFrame.children.length; i++) await walk(rootFrame.children[i], 1);
  }
  return candidates;
}

// ─── Persistent component state + history index ─────────────────────────────
// Storage layout:
//   • Per-node:  node.setPluginData("a11y.v1.lastScan", JSON) → full issue list (≤100KB)
//   • Per-file:  figma.clientStorage["a11y.componentIndex"]   → summary only (~1MB cap)
// Cap the index at 200 entries — drop the oldest by lastScanned timestamp.

const INDEX_KEY      = "a11y.componentIndex";
const INDEX_MAX_ROWS = 200;
const LAST_SCAN_KEY  = "a11y.v1.lastScan";
const SNAPSHOT_KEY   = "a11y-snapshot";

const A11Y_PLUGIN_DATA_KEYS = [
  "a11y.v1.componentType", "a11y.v1.ariaRole", "a11y.v1.ariaLabel",
  "a11y.v1.ariaLevel", "a11y.v1.states", "a11y.v1.wcagRef",
  "a11y.v1.issues", "a11y.v1.ariaSchema", "a11y.generated",
  "a11y.labelFor", "a11y-waiting-ai", LAST_SCAN_KEY,
];

function collectPluginDataSnapshot(node) {
  const pluginData = {};
  for (let i = 0; i < A11Y_PLUGIN_DATA_KEYS.length; i++) {
    const k = A11Y_PLUGIN_DATA_KEYS[i];
    try {
      const v = node.getPluginData(k);
      if (v) pluginData[k] = v;
    } catch (_e) {}
  }
  return pluginData;
}

function collectSharedA11ySnapshot(node) {
  const shared = {};
  if (!node.getSharedPluginData) return shared;
  for (const pk in SHARED_A11Y_KEY_MAP) {
    if (!SHARED_A11Y_KEY_MAP.hasOwnProperty(pk)) continue;
    const sk = SHARED_A11Y_KEY_MAP[pk];
    try {
      const v = node.getSharedPluginData("a11y", sk);
      if (v) shared[sk] = v;
    } catch (_e) {}
  }
  try {
    const ls = node.getSharedPluginData("a11y", "lastScan");
    if (ls) shared.lastScan = ls;
  } catch (_e) {}
  return shared;
}

async function saveA11ySnapshot(node) {
  if (!node || !node.setPluginData) return;
  let annotations = [];
  try {
    if (node.annotations && node.annotations.length) {
      annotations = JSON.parse(JSON.stringify(node.annotations));
    }
  } catch (_e) {}
  const childrenState = ("children" in node && node.children)
    ? node.children.map(function(c) { return { id: c.id, name: c.name, visible: c.visible }; })
    : [];
  const snap = {
    name: node.name,
    visible: node.visible,
    pluginData: collectPluginDataSnapshot(node),
    sharedPluginData: collectSharedA11ySnapshot(node),
    annotations: annotations,
    childrenState: childrenState,
  };
  try { node.setPluginData(SNAPSHOT_KEY, JSON.stringify(snap)); } catch (_e) {}
}

async function restoreA11ySnapshot(node) {
  if (!node || !node.getPluginData) return { ok: false, message: "No snapshot available" };
  const raw = node.getPluginData(SNAPSHOT_KEY);
  if (!raw) return { ok: false, message: "No snapshot available" };
  let snap;
  try { snap = JSON.parse(raw); } catch (_e) {
    return { ok: false, message: "Snapshot could not be read" };
  }

  node.name = snap.name;
  if (snap.visible !== undefined) node.visible = snap.visible;

  const keysToClear = {};
  let ki;
  for (ki = 0; ki < A11Y_PLUGIN_DATA_KEYS.length; ki++) keysToClear[A11Y_PLUGIN_DATA_KEYS[ki]] = true;
  const pdKeys = snap.pluginData || {};
  for (const k in pdKeys) { if (pdKeys.hasOwnProperty(k)) keysToClear[k] = true; }
  for (const k in keysToClear) {
    try { node.setPluginData(k, ""); } catch (_e) {}
  }
  for (const k in pdKeys) {
    if (!pdKeys.hasOwnProperty(k)) continue;
    try { node.setPluginData(k, pdKeys[k]); } catch (_e) {}
  }

  if (node.setSharedPluginData) {
    for (const pk in SHARED_A11Y_KEY_MAP) {
      if (!SHARED_A11Y_KEY_MAP.hasOwnProperty(pk)) continue;
      try { node.setSharedPluginData("a11y", SHARED_A11Y_KEY_MAP[pk], ""); } catch (_e) {}
    }
    const sd = snap.sharedPluginData || {};
    for (const sk in sd) {
      if (!sd.hasOwnProperty(sk)) continue;
      try { node.setSharedPluginData("a11y", sk, sd[sk]); } catch (_e) {}
    }
  }

  if (snap.annotations && node.setAnnotations) {
    try { node.setAnnotations(snap.annotations); } catch (_e) {}
  }

  const parent = node.parent;
  if (parent && "children" in parent) {
    const toRemove = [];
    for (let i = 0; i < parent.children.length; i++) {
      const c = parent.children[i];
      if ((c.name || "").indexOf("_a11y_") >= 0) toRemove.push(c);
    }
    for (let j = 0; j < toRemove.length; j++) {
      try { toRemove[j].remove(); } catch (_e) {}
    }
  }

  return { ok: true };
}

async function exportPreviewNode(node) {
  const box = node && node.absoluteBoundingBox;
  let scale = 1;
  if (box && box.width > 0 && box.height > 0) {
    scale = Math.min(320 / box.height, 580 / box.width, 1);
  }
  return await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });
}

async function loadComponentIndex() {
  const stored = await figma.clientStorage.getAsync(INDEX_KEY);
  return stored && typeof stored === "object" ? stored : {};
}

async function persistComponentIndex(index) {
  const ids = Object.keys(index);
  if (ids.length > INDEX_MAX_ROWS) {
    // Drop the N oldest entries until we are at the cap
    ids.sort(function(a, b) { return (index[a].lastScanned || 0) - (index[b].lastScanned || 0); });
    const drop = ids.slice(0, ids.length - INDEX_MAX_ROWS);
    for (let i = 0; i < drop.length; i++) delete index[drop[i]];
  }
  await figma.clientStorage.setAsync(INDEX_KEY, index);
}

// Sanitize issue objects for pluginData — drop bulky fields, cap message length.
function packIssuesForStorage(issues) {
  const out = [];
  for (let i = 0; i < issues.length; i++) {
    const x = issues[i];
    out.push({
      severity:     x.severity,
      code:         x.code,
      wcagRef:      x.wcagRef,
      message:      (x.message     || "").slice(0, 240),
      displayTitle: (x.displayTitle || "").slice(0, 120),
      nodeId:       x.nodeId,
      fixed:        !!x.fixed,
      acknowledged: !!x.acknowledged,
      autoFixable:  !!x.autoFixable,
      fixKind:      x.fixKind || null,
    });
  }
  return out;
}

function readStoredScan(node) {
  if (!node || !node.getPluginData) return null;
  const raw = node.getPluginData(LAST_SCAN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

async function saveLastScan(rootNodeId, payload) {
  const node = await getNodeById(rootNodeId);
  if (!node) return;

  const issues   = Array.isArray(payload.issues) ? packIssuesForStorage(payload.issues) : [];
  const total    = issues.length;
  const resolved = issues.filter(function(x) { return x.fixed; }).length;

  const fullPayload = {
    timestamp:      Date.now(),
    role:           payload.role     || "",
    nodeName:       payload.nodeName || node.name,
    nodeType:       payload.nodeType || node.type,
    totalIssues:    total,
    resolvedIssues: resolved,
    issues:         issues,
  };

  // Per-node full snapshot
  try {
    node.setPluginData(LAST_SCAN_KEY, JSON.stringify(fullPayload));
    try { node.setSharedPluginData("a11y", "lastScan", JSON.stringify({
      timestamp: fullPayload.timestamp, total: total, resolved: resolved,
    })); } catch (_e) {}
  } catch (_e) { /* pluginData has a per-key size limit — skip on overflow */ }

  // File-wide summary index
  const index = await loadComponentIndex();
  index[rootNodeId] = {
    name:        fullPayload.nodeName,
    type:        fullPayload.nodeType,
    role:        fullPayload.role,
    lastScanned: fullPayload.timestamp,
    total:       total,
    resolved:    resolved,
  };
  await persistComponentIndex(index);
}

async function removeFromIndex(nodeId) {
  const index = await loadComponentIndex();
  if (index[nodeId]) {
    delete index[nodeId];
    await persistComponentIndex(index);
  }
  const node = await getNodeById(nodeId);
  if (node && node.setPluginData) {
    try { node.setPluginData(LAST_SCAN_KEY, ""); } catch (_e) {}
  }
}

// ── Selection change → keep preview in sync with canvas selection ──
figma.on("selectionchange", async function() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.ui.postMessage({ type: "SELECTION_CLEARED" });
    return;
  }
  const raw = sel[0];
  const root = getSemanticRoot(raw);
  figma.ui.postMessage({
    type:     "SELECTION_CHANGED",
    nodeId:   root.id,
    nodeName: root.name,
    nodeType: root.type,
  });
  try {
    const bytes = await exportPreviewNode(root);
    figma.ui.postMessage({
      type:      "UPDATE_PREVIEW",
      ok:        true,
      nodeId:    root.id,
      imageData: figma.base64Encode(bytes),
    });
  } catch (_e) {
    figma.ui.postMessage({ type: "UPDATE_PREVIEW", ok: false, nodeId: root.id });
  }
});

async function scrollToNode(nodeId) {
  const node = await getNodeById(nodeId);
  if (!node) return false;
  try { figma.viewport.scrollAndZoomIntoView([node]); return true; }
  catch (_e) { return false; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 600, height: 680, themeColors: true });

// Notify the UI which editor mode we are running in
figma.ui.postMessage({
  type: "INIT",
  editorType: figma.editorType || "figma",
  debugHint: "UI console: reportFixCoverage() · Main sandbox: figma._a11yDebug.reportFixCoverage()",
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === "SAVE_API_KEY") {
    await figma.clientStorage.setAsync("openai-api-key", msg.key);
    figma.ui.postMessage({ type: "KEY_SAVED" });
    return;
  }

  // ── Persistent state & navigation ──
  if (msg.type === "SCROLL_TO_NODE" || msg.type === "SCROLL_TO_COMPONENT") {
    const targetId = msg.nodeId || msg.rootNodeId;
    const ok = await scrollToNode(targetId);
    figma.ui.postMessage({ type: "SCROLL_TO_NODE_RESULT", ok: ok, nodeId: targetId });
    return;
  }

  if (msg.type === "EXPORT_PREVIEW") {
    const targetId = msg.nodeId || msg.rootNodeId;
    const node = await getNodeById(targetId);
    if (!node) {
      figma.ui.postMessage({ type: "UPDATE_PREVIEW", ok: false, nodeId: targetId });
      return;
    }
    try {
      const bytes = await exportPreviewNode(node);
      figma.ui.postMessage({
        type:      "UPDATE_PREVIEW",
        ok:        true,
        nodeId:    node.id,
        imageData: figma.base64Encode(bytes),
      });
    } catch (_e) {
      figma.ui.postMessage({ type: "UPDATE_PREVIEW", ok: false, nodeId: targetId });
    }
    return;
  }

  if (msg.type === "RESET_LAYER") {
    const targetId = msg.rootNodeId || msg.nodeId;
    const node = await getNodeById(targetId);
    if (!node) {
      figma.ui.postMessage({ type: "RESET_RESULT", ok: false, message: "Layer not found" });
      figma.notify("Layer not found");
      return;
    }
    const result = await restoreA11ySnapshot(node);
    if (!result.ok) {
      figma.notify(result.message);
      figma.ui.postMessage({ type: "RESET_RESULT", ok: false, message: result.message });
      return;
    }
    figma.commitUndo();
    figma.notify("Reset complete — all plugin changes removed");
    await analyzeNodeAndPost(node, { skipSnapshot: true });
    figma.ui.postMessage({ type: "RESET_RESULT", ok: true });
    return;
  }

  if (msg.type === "SAVE_LAST_SCAN") {
    // UI posts this after analysis AND after every successful autofix.
    // The payload is { nodeId, role, nodeName, nodeType, issues }.
    if (msg.nodeId) await saveLastScan(msg.nodeId, msg);
    return;
  }

  if (msg.type === "GET_STORED_STATE") {
    const node     = await getNodeById(msg.nodeId);
    const snapshot = node ? readStoredScan(node) : null;
    figma.ui.postMessage({
      type:     "STORED_STATE",
      nodeId:   msg.nodeId,
      snapshot: snapshot,
    });
    return;
  }

  if (msg.type === "GET_COMPONENT_INDEX") {
    const index = await loadComponentIndex();
    // Drop stale entries whose nodes no longer exist on the page
    const live = {};
    const ids  = Object.keys(index);
    for (let i = 0; i < ids.length; i++) {
      const id   = ids[i];
      const node = await getNodeById(id);
      if (node) live[id] = index[id];
    }
    // Persist the cleaned-up index only if something was pruned
    if (Object.keys(live).length !== ids.length) await persistComponentIndex(live);
    figma.ui.postMessage({ type: "COMPONENT_INDEX", index: live });
    return;
  }

  if (msg.type === "DELETE_FROM_INDEX") {
    await removeFromIndex(msg.nodeId);
    const index = await loadComponentIndex();
    figma.ui.postMessage({ type: "COMPONENT_INDEX", index: index });
    return;
  }

  if (msg.type === "OPEN_STORED_COMPONENT") {
    // Triggered by the dashboard [→] button: select the node, scroll viewport,
    // and reply with the snapshot so the UI can render it in the analyze view.
    const node = await getNodeById(msg.nodeId);
    if (!node) {
      figma.ui.postMessage({ type: "STORED_STATE", nodeId: msg.nodeId, snapshot: null, missing: true });
      return;
    }
    try { figma.currentPage.selection = [node]; } catch (_e) {}
    await scrollToNode(msg.nodeId);
    const snapshot = readStoredScan(node);
    figma.ui.postMessage({
      type:     "STORED_STATE",
      nodeId:   msg.nodeId,
      nodeName: node.name,
      nodeType: node.type,
      snapshot: snapshot,
      autoOpen: true,
    });
    return;
  }

  if (msg.type === "APPLY_FIXES") {
    try {
      const rootNode = await getNodeById(msg.rootNodeId);
      const issues = msg.issues || [];
      if (rootNode) figma.commitUndo();
      figma.ui.postMessage({ type: "FIX_PROGRESS_START", total: issues.length });
      const batchResult = rootNode
        ? await applyAllIssueFixes(rootNode, issues, {
            annotationDestination: msg.annotationDestination,
            detectedRole:          msg.detectedRole,
            fixOrder:              msg.fixOrder,
          })
        : { fixed: 0, failed: 0, total: 0 };
      const result = await applyFixes(msg.suggestions, msg.rootNodeId, "inplace", msg.annotationDestination);
      if (rootNode) await analyzeNodeAndPost(rootNode, { afterFix: true, previousIssues: issues });
      figma.ui.postMessage({ type: "FIX_COMPLETE", fixed: batchResult.fixed, failed: batchResult.failed, total: batchResult.total });
      figma.ui.postMessage(Object.assign({ type: "APPLY_RESULT", mode: "inplace", modeNote: "Cmd+Z undoes all changes" }, result));
    } catch (e) {
      figma.ui.postMessage({ type: "APPLY_RESULT", applied: 0, skipped: 0, details: [String(e)] });
    }
    return;
  }

  // APPLY_WITH_MODE — three-option action dialog in the UI sends this
  // mode "inplace"  → commit to one undo group, rename + data on original
  // mode "copy"     → clone 120px right, apply to clone, green indicator on original
  // mode "annotate" → pluginData / sharedPluginData only, no renames
  if (msg.type === "APPLY_WITH_MODE") {
    try {
      const rootNode = await getNodeById(msg.rootNodeId);
      const issues = msg.issues || [];
      if (msg.mode === "inplace" && rootNode) {
        figma.commitUndo();
      }
      figma.ui.postMessage({ type: "FIX_PROGRESS_START", total: issues.length });
      const batchResult = rootNode
        ? await applyAllIssueFixes(rootNode, issues, {
            annotationDestination: msg.annotationDestination,
            detectedRole:          msg.detectedRole,
            fixOrder:              msg.fixOrder,
          })
        : { fixed: 0, failed: 0, total: 0 };
      const result = await applyFixes(msg.suggestions, msg.rootNodeId, msg.mode, msg.annotationDestination);
      if (rootNode) await analyzeNodeAndPost(rootNode, { afterFix: true, previousIssues: issues });

      const modeNote =
        msg.mode === "inplace"  ? "Cmd+Z undoes all changes" :
        msg.mode === "copy"     ? "Fixed copy placed 120px right. Original is untouched." :
                                  "Annotations written. Open Dev Mode to inspect.";

      figma.ui.postMessage({ type: "FIX_COMPLETE", fixed: batchResult.fixed, failed: batchResult.failed, total: batchResult.total });
      figma.ui.postMessage(Object.assign({ type: "APPLY_RESULT", mode: msg.mode, modeNote: modeNote }, result));
    } catch (e) {
      figma.ui.postMessage({ type: "APPLY_RESULT", applied: 0, skipped: 0, details: [String(e)] });
    }
    return;
  }

  if (msg.type === "RESCAN_SELECTION") {
    const rootNode = await getNodeById(msg.rootNodeId);
    if (!rootNode) {
      figma.ui.postMessage({ type: "ERROR", message: "Selection changed. Please re-select the layer." });
      return;
    }
    const waiting = readWaitingForAi(rootNode);
    await analyzeNodeAndPost(rootNode, { afterFix: true, previousIssues: msg.previousIssues || [] });
    if (waiting) {
      const stillOpen = !!(await getNodeById(msg.rootNodeId)) && readWaitingForAi(rootNode);
      figma.ui.postMessage({
        type: "RESCAN_AI_STATUS",
        issueCode: waiting.issueCode,
        verified: !stillOpen,
      });
    }
    return;
  }

  // Preview panel state (collapsed + light/dark bg) — persisted via clientStorage.
  // Plugin UI runs in a data: URL where localStorage is blocked, so we must
  // round-trip state through the main thread.
  // Self-healing: try to fix an individual issue inline.
  // msg: { issueCode, nodeId, rootNodeId, strategy: "ai" | "generic" | "prompt", issueIdx }
  if (msg.type === "AUTO_FIX_ISSUE") {
    const rootNode = await getNodeById(msg.rootNodeId);
    const previousIssues = msg.previousIssues || [];
    if (msg.strategy !== "prompt" && rootNode) {
      figma.ui.postMessage({ type: "FIX_PROGRESS_START", total: 1 });
    }
    const result = await autoFixIssue({
      issueCode:             msg.issueCode,
      nodeId:                msg.nodeId,
      rootNodeId:            msg.rootNodeId,
      strategy:              msg.strategy,
      annotationDestination: msg.annotationDestination,
      detectedRole:          msg.detectedRole,
      linkAction:            msg.linkAction,
      linkCandidateId:       msg.linkCandidateId,
      skipCandidateIds:      msg.skipCandidateIds,
      message:               msg.message,
      figmaAiPrompt:         msg.figmaAiPrompt,
    });
    if (rootNode && result.ok && msg.strategy !== "prompt" && !result.needsComponentLinkChoice) {
      await analyzeNodeAndPost(rootNode, { afterFix: true, previousIssues: previousIssues });
      figma.ui.postMessage({ type: "FIX_COMPLETE", fixed: 1, failed: 0, total: 1 });
    } else if (rootNode && (result.waitingForAi || msg.strategy === "prompt")) {
      await analyzeNodeAndPost(rootNode, { afterFix: true, previousIssues: previousIssues });
    }
    figma.ui.postMessage(Object.assign(
      { type: "AUTO_FIX_RESULT", issueCode: msg.issueCode, issueIdx: msg.issueIdx, strategy: msg.strategy },
      result
    ));
    return;
  }

  if (msg.type === "ACKNOWLEDGE_ISSUE") {
    const rootNode = await getNodeById(msg.rootNodeId);
    if (!rootNode) {
      figma.ui.postMessage({ type: "ACKNOWLEDGE_RESULT", ok: false, issueIdx: msg.issueIdx, message: "Selection changed." });
      return;
    }
    let ackMap = {};
    try { ackMap = JSON.parse(rootNode.getPluginData("a11y.acknowledged") || "{}"); } catch (_e) { ackMap = {}; }
    ackMap[msg.issueCode] = Date.now();
    rootNode.setPluginData("a11y.acknowledged", JSON.stringify(ackMap));
    if (msg.issueCode === "COLOR_ONLY_DISABLED") {
      setSharedA11y(rootNode, "state-indicator", "visual-only-color");
    }
    figma.ui.postMessage({
      type: "ACKNOWLEDGE_RESULT",
      ok: true,
      issueCode: msg.issueCode,
      issueIdx: msg.issueIdx,
      message: "Marked as acknowledged.",
    });
    return;
  }

  if (msg.type === "LOAD_PREVIEW_STATE") {
    const collapsed = await figma.clientStorage.getAsync("preview-collapsed");
    const bgLight   = await figma.clientStorage.getAsync("preview-bg-light");
    figma.ui.postMessage({
      type: "PREVIEW_STATE_LOADED",
      collapsed: collapsed === true,
      bgLight:   bgLight !== false, // default true (light)
    });
    return;
  }

  if (msg.type === "SAVE_PREVIEW_STATE") {
    if (msg.collapsed !== undefined) await figma.clientStorage.setAsync("preview-collapsed", !!msg.collapsed);
    if (msg.bgLight   !== undefined) await figma.clientStorage.setAsync("preview-bg-light", !!msg.bgLight);
    return;
  }

  if (msg.type === "DEBUG_FIX_COVERAGE") {
    var report = reportFixCoverage();
    figma.ui.postMessage({ type: "DEBUG_FIX_COVERAGE_RESULT", lines: report.lines });
    return;
  }

  if (msg.type === "LOAD_SETTINGS") {
    const storedKey   = await figma.clientStorage.getAsync("openai-api-key");
    const threshold   = await figma.clientStorage.getAsync("confidence-threshold") || 3;
    const aiModel     = await figma.clientStorage.getAsync("ai-model") || "gpt-4o-mini";
    const annotationDestination = await getAnnotationDestination();
    figma.ui.postMessage({
      type: "SETTINGS_LOADED",
      hasApiKey: !!storedKey,
      threshold: Number(threshold),
      aiModel: String(aiModel),
      annotationDestination: annotationDestination,
    });
    return;
  }

  if (msg.type === "SAVE_SETTINGS") {
    if (msg.threshold !== undefined) await figma.clientStorage.setAsync("confidence-threshold", msg.threshold);
    if (msg.aiModel   !== undefined) await figma.clientStorage.setAsync("ai-model", msg.aiModel);
    if (msg.annotationDestination !== undefined) {
      await figma.clientStorage.setAsync(ANNOTATION_DEST_STORAGE_KEY, msg.annotationDestination);
    }
    figma.ui.postMessage({ type: "SETTINGS_SAVED" });
    return;
  }

  if (msg.type === "MARK_PENDING_DESIGNER") {
    const target = await getNodeById(msg.nodeId) || await getNodeById(msg.rootNodeId);
    if (!target) {
      figma.ui.postMessage({ type: "PENDING_RESULT", ok: false, issueIdx: msg.issueIdx, message: "Selection changed." });
      return;
    }
    target.setPluginData("a11y-pending", JSON.stringify({
      issueCode: msg.issueCode,
      markedAt: Date.now(),
      message: "Designer committed to build focus state",
    }));
    figma.ui.postMessage({
      type: "PENDING_RESULT",
      ok: true,
      issueCode: msg.issueCode,
      issueIdx: msg.issueIdx,
      message: "Marked as pending — build the focus state variant, then re-scan.",
    });
    return;
  }

  if (msg.type === "GET_FRAMEWORK_CODE") {
    // msg.ariaSchema: JSON string, msg.framework: "html" | "react" | "vue"
    const code = generateFrameworkCode(msg.ariaSchema || "{}", msg.framework || "html");
    figma.ui.postMessage({ type: "FRAMEWORK_CODE", framework: msg.framework, code: code });
    return;
  }

  if (msg.type === "GET_NODE_DATA") {
    // Dev Mode inspector: read all a11y plugin data from the selected node
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "NODE_DATA", data: null, message: "No layer selected." });
      return;
    }
    const node = selection[0];
    const keys = ["componentType", "ariaRole", "ariaLabel", "ariaLevel", "states", "wcagRef", "issues", "ariaSchema"];
    const data = { nodeId: node.id, nodeName: node.name, nodeType: node.type };
    for (let k = 0; k < keys.length; k++) {
      const fullKey = "a11y.v1." + keys[k];
      const val = node.getPluginData(fullKey);
      if (val) data[keys[k]] = val;
    }
    // Also try sharedPluginData
    for (let k = 0; k < keys.length; k++) {
      if (!data[keys[k]]) {
        try {
          const val = node.getSharedPluginData("a11y", keys[k]);
          if (val) data[keys[k]] = val;
        } catch (e) {}
      }
    }
    figma.ui.postMessage({ type: "NODE_DATA", data: data });
    return;
  }

  if (msg.type === "SCAN_FRAME") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "SCAN_RESULTS", error: "Select a Frame or Group to scan." });
      return;
    }
    const frameNode = selection[0];
    if (frameNode.type === "TEXT" || frameNode.type === "VECTOR") {
      figma.ui.postMessage({ type: "SCAN_RESULTS", error: "Select a Frame or Group — not an individual element." });
      return;
    }

    figma.ui.postMessage({ type: "SCAN_PROGRESS", message: "Scanning frame…" });

    // Pre-collect ALL text nodes on the page exactly once.
    // This prevents O(n×m) repeated findAll() calls inside gatherContext → findSpatiallyNearbyText.
    const allTextNodes = figma.currentPage.findAllWithCriteria({ types: ["TEXT"] });

    // Collect candidates with depth limit (maxDepth=5) — synchronous but cheap because
    // we only score specs per node (no further traversals during collection phase).
    const candidates = await collectScanCandidates(frameNode, allTextNodes, 5);
    const scanResults = [];
    let totalHigh = 0, totalMed = 0, totalLow = 0, totalManual = 0;

    // Process candidates in chunks, yielding to the event loop every 20 items
    // so Figma's UI thread stays responsive on large frames.
    for (let i = 0; i < candidates.length; i++) {
      const { node, spec, ctx } = candidates[i];
      const detection   = detectComponent(ctx, node);
      const auditResult = detection.spec ? await auditNode(node, detection.spec, ctx) : { issues: [], auditLog: [] };
      const issues      = auditResult.issues;

      // Two-layer messaging for batch scan (static titles + explanations; no per-row AI titles)
      if (issues.length > 0) {
        ctx.componentType = detection.role || (detection.spec && detection.spec.role) || ctx.nodeType;
        await enrichIssuesWithTitlesAndExplanations(issues, node, ctx, null);
      }

      const high   = issues.filter(function(iss) { return iss.severity === "HIGH";   }).length;
      const med    = issues.filter(function(iss) { return iss.severity === "MED";    }).length;
      const low    = issues.filter(function(iss) { return iss.severity === "LOW";    }).length;
      const manual = issues.filter(function(iss) { return iss.severity === "MANUAL"; }).length;
      totalHigh   += high;
      totalMed    += med;
      totalLow    += low;
      totalManual += manual;

      scanResults.push({
        nodeId:   node.id,
        nodeName: node.name,
        role:     detection.role || spec.role,
        issues:   issues,
        high:     high,
        med:      med,
        low:      low,
        manual:   manual,
      });

      // Yield every 20 nodes + show progress in Figma's notification bar
      if (i % 20 === 0 && i > 0) {
        figma.notify("Scanning… " + i + " / " + candidates.length, { timeout: 800 });
        await new Promise(function(r) { setTimeout(r, 0); });
      }
    }

    scanResults.sort(function(a, b) {
      return (b.high * 100 + b.med * 10 + b.low) - (a.high * 100 + a.med * 10 + a.low);
    });

    figma.ui.postMessage({
      type:      "SCAN_RESULTS",
      frameId:   frameNode.id,
      frameName: frameNode.name,
      results:   scanResults,
      summary: {
        total:  scanResults.length,
        high:   totalHigh,
        med:    totalMed,
        low:    totalLow,
        manual: totalManual,
      },
    });
    return;
  }

  if (msg.type === "ASK_ANSWER") {
    const rootNode = await getNodeById(msg.rootNodeId);
    if (!rootNode) {
      figma.ui.postMessage({ type: "ERROR", message: "Selection changed. Please re-run analysis." });
      return;
    }
    const val = (msg.answer.toLowerCase().includes("yes") || msg.answer.includes("rating"))
      ? "radio-group (star-rating)"
      : "radio-group";
    rootNode.setPluginData("a11y.v1.componentType", val);
    figma.ui.postMessage({ type: "ASK_ANSWER_SAVED", questionId: msg.questionId, answer: msg.answer });
    return;
  }

  if (msg.type === "ANALYZE_SELECTION" || msg.type === "RESCAN_NODE") {
    let rootNode;
    if (msg.type === "RESCAN_NODE") {
      const target = await getNodeById(msg.nodeId);
      if (!target) {
        figma.ui.postMessage({ type: "ERROR", message: "Layer not found." });
        return;
      }
      try { figma.currentPage.selection = [target]; } catch (_e) { /* read-only */ }
      rootNode = getSemanticRoot(target);
    } else {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.ui.postMessage({ type: "ERROR", message: "No layer selected. Select a component first." });
        return;
      }
      rootNode = getSemanticRoot(selection[0]);
    }

    if (isA11yGeneratedLayer(rootNode)) {
      notifyScanSkipped(rootNode);
      return;
    }

    await saveA11ySnapshot(rootNode);

    try {
      const bytes = await exportPreviewNode(rootNode);
      figma.ui.postMessage({
        type:      "UPDATE_PREVIEW",
        ok:        true,
        nodeId:    rootNode.id,
        imageData: figma.base64Encode(bytes),
      });
    } catch (_e) { /* preview is optional */ }

    const ctx          = await gatherContext(rootNode);
    let detection      = detectComponent(ctx, rootNode);
    ctx.competitorRole = detection.competitorRole || null;

    // Competition tiebreak: when top two types are within 3 points, Vision picks the winner
    if (detection.needsVisionTiebreak) {
      const tieKey = await figma.clientStorage.getAsync("openai-api-key");
      if (tieKey) {
        figma.ui.postMessage({ type: "AI_LOADING", phase: "vision" });
        try {
          const visionResult = await classifyWithVision(rootNode, tieKey);
          const visionSpec   = findSpecByRoleHint(visionResult.role);
          if (visionSpec) {
            detection = Object.assign({}, detection, {
              role:               visionSpec.role,
              spec:               visionSpec,
              reasoning:          "Vision tiebreak vs " + (detection.competitorRole || "?") + ": " +
                                  (visionResult.reasoning || visionSpec.role),
              detectionPath:      "vision-tiebreak",
              confidence:         visionResult.confidence || "MED",
              needsVisionTiebreak: false,
            });
          }
        } catch (_tieErr) { /* keep spec-engine winner */ }
      }
    }

    const auditResult  = detection.spec ? await auditNode(rootNode, detection.spec, ctx) : { issues: [], auditLog: [] };
    const issues       = auditResult.issues;
    const auditLog     = auditResult.auditLog;
    const pendingDesignerCount = countDesignerPendingIssues(issues);

    // Two-layer issue messaging:
    //   LAYER 1 — designer-friendly title (AI when available, static fallback otherwise)
    //   LAYER 2 — "Why it matters" explanation (always static, no AI)
    // We attach both directly on each issue object before sending to the UI.
    if (issues.length > 0) {
      const apiKeyForTitles = await figma.clientStorage.getAsync("openai-api-key");
      ctx.componentType = (detection.role || (detection.spec && detection.spec.role) || ctx.nodeType);
      await enrichIssuesWithTitlesAndExplanations(issues, rootNode, ctx, apiKeyForTitles);
    }

    refreshDevModeAnnotations(rootNode);
    persistCodegenHandoffFields(rootNode, detection.spec, issues);

    // Phase B: generate spec-aware suggestions (rename + plugin data)
    // For non-spec components the rule engine's suggestions are used as before.
    const suggestions = detection.spec
      ? generateSuggestions(rootNode, detection.spec, ctx, issues)
      : (detection.suggestions || []);

    const resultPayload = {
      role:          detection.role,
      confidence:    detection.confidence,
      reasoning:     detection.reasoning,
      suggestions:   suggestions,
      askQuestions:  detection.askQuestions,
      issues:        issues,
      auditLog:      auditLog,
      signalDetails: detection.signalDetails || [],
      signalScore:   detection.signalScore   || 0,
      detectionPath: detection.detectionPath || "rule-engine",
      rankedScores:  detection.rankedScores  || [],
      competitorRole: detection.competitorRole || null,
    };

    // HIGH, or MED with spec → show result directly without AI
    if (detection.confidence === "HIGH" || (detection.confidence === "MED" && detection.spec)) {
      figma.ui.postMessage({
        type:     "ANALYSIS_RESULTS",
        nodeId:   rootNode.id,
        nodeName: rootNode.name,
        nodeType: rootNode.type,
        result:   resultPayload,
        usedSpec: !!detection.spec,
        pendingDesignerCount: pendingDesignerCount,
      });
      return;
    }

    // MED/LOW without spec → try AI
    const apiKey = await figma.clientStorage.getAsync("openai-api-key");
    if (!apiKey) {
      figma.ui.postMessage({
        type:     "ANALYSIS_RESULTS",
        nodeId:   rootNode.id,
        nodeName: rootNode.name,
        nodeType: rootNode.type,
        result:   resultPayload,
        noApiKey: true,
        usedSpec: !!detection.spec,
        pendingDesignerCount: pendingDesignerCount,
      });
      return;
    }

    figma.ui.postMessage({ type: "AI_LOADING", phase: "text" });

    try {
      const aiResult        = await classifyWithAI(ctx, apiKey);
      let finalIssues       = issues;
      let finalAuditLog     = auditLog;
      let activeSpec        = detection.spec;
      let detectionPath     = "text-ai";
      let finalSuggestions  = detection.spec
        ? suggestions
        : (aiResult.suggestions || []);
      const roleUnknown     = !aiResult.role || String(aiResult.role).toLowerCase() === "unknown";
      let specFromText      = findSpecByRoleHint(aiResult.role);

      if (specFromText && !roleUnknown) {
        const audited = await runSpecsForType(aiResult.role, rootNode, ctx);
        finalIssues   = audited.issues;
        finalAuditLog = audited.auditLog;
        activeSpec    = audited.spec;
        if (activeSpec) aiResult.role = activeSpec.role;
        finalSuggestions = generateSuggestions(rootNode, activeSpec, ctx, finalIssues);
      } else {
        figma.ui.postMessage({ type: "AI_LOADING", phase: "vision" });
        const visionResult = await classifyWithVision(rootNode, apiKey);
        const visionUnknown = !visionResult.role || String(visionResult.role).toLowerCase() === "unknown";
        const specFromVision = findSpecByRoleHint(visionResult.role);

        if (specFromVision && !visionUnknown) {
          const audited = await runSpecsForType(visionResult.role, rootNode, ctx);
          finalIssues   = audited.issues;
          finalAuditLog = audited.auditLog;
          activeSpec    = audited.spec;
          aiResult.role = activeSpec.role;
          aiResult.confidence = visionResult.confidence || "MED";
          aiResult.reasoning = "Vision: " + (visionResult.reasoning || activeSpec.role);
          detectionPath = "vision-ai";
          finalSuggestions = generateSuggestions(rootNode, activeSpec, ctx, finalIssues);
        }
      }

      if (finalIssues.length > 0) {
        ctx.componentType = (activeSpec && activeSpec.role) || aiResult.role || ctx.nodeType;
        await enrichIssuesWithTitlesAndExplanations(finalIssues, rootNode, ctx, apiKey);
        await enrichIssueFixMeta(finalIssues, rootNode);
      }
      const pendingAfterAi = countDesignerPendingIssues(finalIssues);

      const estimatedTokens = Math.round(JSON.stringify(ctx).length / 4) +
        (detectionPath === "vision-ai" ? 900 : 200);
      figma.ui.postMessage({
        type:     "ANALYSIS_RESULTS",
        nodeId:   rootNode.id,
        nodeName: rootNode.name,
        nodeType: rootNode.type,
        result:   Object.assign({}, aiResult, {
          issues:        finalIssues,
          auditLog:      finalAuditLog,
          suggestions:   finalSuggestions,
          askQuestions:  aiResult.askQuestions || detection.askQuestions,
          detectionPath: detectionPath,
          signalDetails: detection.signalDetails || [],
          signalScore:   detection.signalScore || 0,
        }),
        usedAI:     true,
        usedVision: detectionPath === "vision-ai",
        pendingDesignerCount: pendingAfterAi,
        estimatedTokens,
        usedSpec:   !!activeSpec,
      });
    } catch (e) {
      figma.ui.postMessage({
        type:     "ANALYSIS_RESULTS",
        nodeId:   rootNode.id,
        nodeName: rootNode.name,
        nodeType: rootNode.type,
        result:   resultPayload,
        aiError:  String(e),
        usedSpec: !!detection.spec,
        pendingDesignerCount: pendingDesignerCount,
      });
    }
  }
};

// ─── Dev Mode Codegen — ARIA handoff in Code tab ─────────────────────────────
if (typeof figma.codegen !== "undefined" && figma.codegen && figma.codegen.on) {
  figma.codegen.on("generate", async function(event) {
    const node = event && event.node;
    if (!node) return [];
    return buildCodegenResults(node);
  });
}

exposeDebugApi();
