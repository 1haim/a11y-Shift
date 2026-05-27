# fixNonComponentElement — Full Implementation Briefing

## Purpose
When a WCAG check identifies an interactive element that is a plain Frame/Group instead of a Figma Component, this function:
1. Creates a proper Figma component with ALL required state variants, placed far from the viewport (x+4000)
2. Replaces the original node in place with a Default-state instance
3. Tags the instance with plugin data
4. Never breaks the visual layout

---

## 3-Path Decision Tree

auditNode finds NON_COMPONENT_ELEMENT on `node`
│
├── node has no children (leaf) OR is a simple icon/text node
│   └── PATH A: AUTO — create component directly from node's visual
│
├── node has uniform children (all same classifyNode type, e.g. a list of buttons)
│   └── PATH B: PLUGIN — loop each child, call fixNonComponentElement on each child
│
└── node is complex (mixed children, form, dialog, etc.)
    └── PATH C: FIGMA AI — send targeted prompt with nodeId + child nodeIds

---

## Complete Implementation

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function isA11yGeneratedLayer(node) {
  return node.name.startsWith("_a11y_") || node.name.startsWith("A11y/");
}

async function getCleanComponentBaseName(node) {
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    if (main?.parent?.type === "COMPONENT_SET") return main.parent.name;
    if (main) return main.name.split("=")[0].split("/")[0].trim();
  }
  return node.name.split("=")[0].split("/")[0].trim();
}

// ─────────────────────────────────────────────
// SEMANTIC COMPONENT DESCRIPTIONS (per type)
// ─────────────────────────────────────────────

const COMPONENT_SEMANTIC_DESC = {
  button: `Role: button\nStates: Default | Hover | Focus | Disabled\nHTML element: <button type="button">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/button/`,
  textField: `Role: textbox\nStates: Default | Hover | Focus | Disabled | Error\nRequired: True | False\nHTML element: <input type="text">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/`,
  checkbox: `Role: checkbox\nStates: Default | Hover | Focus | Disabled\nChecked: True | False\nHTML element: <input type="checkbox">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/`,
  "radio-group": `Role: radiogroup > radio\nStates: Default | Hover | Focus | Disabled\nSelected: True | False\nHTML element: <fieldset><legend> + <input type="radio">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/radio/`,
  select: `Role: combobox > listbox > option\nStates: Default | Hover | Focus | Disabled\nOpen: True | False\nHTML element: <select> or custom combobox\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/`,
  modal: `Role: dialog\nStates: Default (open)\nHTML element: <dialog> or role="dialog"\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/`,
  tabs: `Role: tablist > tab + tabpanel\nStates: Default\nTab states: Selected True | False, State Default | Hover | Focus | Disabled\nHTML element: role="tablist" / role="tab" / role="tabpanel"\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/`,
  slider: `Role: slider\nStates: Default | Hover | Focus | Disabled\nARIA attributes: aria-valuemin, aria-valuemax, aria-valuenow\nHTML element: <input type="range"> or role="slider"\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/slider/`,
  "star-rating": `Role: radiogroup > radio (one per star)\nStates: Default | Hover | Focus | Disabled\nValue: 1 | 2 | 3 | 4 | 5\nARIA: visually-hidden labels per star\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/radio/`,
  toggle: `Role: switch\nStates: Default | Hover | Focus | Disabled\nChecked: True | False\nHTML element: <button role="switch" aria-checked="true|false">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/switch/`,
  accordion: `Role: button (trigger) + region (panel)\nStates: Default | Hover | Focus | Disabled\nExpanded: True | False\nHTML element: <button aria-expanded> + <div role="region">\nARIA pattern: https://www.w3.org/WAI/ARIA/apg/patterns/accordion/`,
};

// ─────────────────────────────────────────────
// STATE VARIANTS PER TYPE
// ─────────────────────────────────────────────

const COMPONENT_VARIANTS = {
  button:        ["State=Default", "State=Hover", "State=Focus", "State=Disabled"],
  textField:     ["State=Default", "State=Hover", "State=Focus", "State=Disabled", "State=Error"],
  checkbox:      ["State=Default,Checked=False", "State=Default,Checked=True", "State=Focus,Checked=False", "State=Focus,Checked=True", "State=Disabled,Checked=False"],
  "radio-group": ["State=Default,Selected=False", "State=Default,Selected=True", "State=Focus,Selected=False", "State=Focus,Selected=True", "State=Disabled,Selected=False"],
  select:        ["State=Default,Open=False", "State=Focus,Open=False", "State=Default,Open=True", "State=Disabled,Open=False"],
  modal:         ["State=Default"],
  tabs:          ["State=Default"],
  slider:        ["State=Default", "State=Hover", "State=Focus", "State=Disabled"],
  "star-rating": ["State=Default,Value=1", "State=Default,Value=2", "State=Default,Value=3", "State=Default,Value=4", "State=Default,Value=5", "State=Focus,Value=3"],
  toggle:        ["State=Default,Checked=False", "State=Default,Checked=True", "State=Focus,Checked=False", "State=Focus,Checked=True", "State=Disabled,Checked=False"],
  accordion:     ["State=Default,Expanded=False", "State=Default,Expanded=True", "State=Focus,Expanded=False", "State=Focus,Expanded=True", "State=Disabled,Expanded=False"],
};

// ─────────────────────────────────────────────
// SEMANTIC LAYER BUILDERS (per type)
// ─────────────────────────────────────────────

async function buildButtonComponent(node, variantName) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Medium" });

  const comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = "HORIZONTAL";
  comp.primaryAxisAlignItems = "CENTER";
  comp.counterAxisAlignItems = "CENTER";
  comp.paddingTop = 12;
  comp.paddingBottom = 12;
  comp.paddingLeft = 24;
  comp.paddingRight = 24;
  comp.itemSpacing = 8;
  comp.cornerRadius = 8;
  comp.resize(node.width || 120, node.height || 44);

  const isDisabled = variantName.includes("Disabled");
  const fills = node.fills && node.fills.length ? node.fills : [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }];
  comp.fills = isDisabled ? fills.map(f => ({ ...f, opacity: (f.opacity || 1) * 0.38 })) : fills;

  if (variantName.includes("Focus")) {
    comp.strokes = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }];
    comp.strokeWeight = 2;
    comp.strokeAlign = "OUTSIDE";
  }

  const label = figma.createText();
  label.name = "label";
  label.fontName = { family: "Inter", style: "Medium" };
  label.fontSize = 14;
  label.characters = extractLabelText(node) || "Button";
  label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: isDisabled ? 0.38 : 1 }];
  comp.appendChild(label);

  return comp;
}

async function buildTextFieldComponent(node, variantName) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });

  const comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = "VERTICAL";
  comp.primaryAxisSizingMode = "AUTO";
  comp.counterAxisSizingMode = "FIXED";
  comp.resize(node.width || 280, comp.height);
  comp.itemSpacing = 4;
  comp.fills = [];

  const labelText = figma.createText();
  labelText.name = "label";
  labelText.fontName = { family: "Inter", style: "Regular" };
  labelText.fontSize = 14;
  labelText.characters = extractLabelText(node) || "Label";
  labelText.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 } }];
  comp.appendChild(labelText);

  const inputWrapper = figma.createFrame();
  inputWrapper.name = "input-wrapper";
  inputWrapper.layoutMode = "HORIZONTAL";
  inputWrapper.primaryAxisSizingMode = "FIXED";
  inputWrapper.counterAxisSizingMode = "AUTO";
  inputWrapper.resize(node.width || 280, 44);
  inputWrapper.paddingLeft = 12;
  inputWrapper.paddingRight = 12;
  inputWrapper.paddingTop = 10;
  inputWrapper.paddingBottom = 10;
  inputWrapper.cornerRadius = 8;
  inputWrapper.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

  const isError = variantName.includes("Error");
  const isFocus = variantName.includes("Focus");
  const borderColor = isError
    ? { r: 0.8, g: 0.1, b: 0.1 }
    : isFocus
      ? { r: 0.2, g: 0.4, b: 1 }
      : { r: 0.7, g: 0.7, b: 0.7 };
  inputWrapper.strokes = [{ type: "SOLID", color: borderColor }];
  inputWrapper.strokeWeight = isFocus ? 2 : 1;
  inputWrapper.strokeAlign = "INSIDE";

  const inputInner = figma.createFrame();
  inputInner.name = "input";
  inputInner.layoutGrow = 1;
  inputInner.fills = [];
  inputInner.resize(100, 24);
  inputWrapper.appendChild(inputInner);
  comp.appendChild(inputWrapper);

  const hintText = figma.createText();
  hintText.name = isError ? "error-text" : "hint-text";
  hintText.fontName = { family: "Inter", style: "Regular" };
  hintText.fontSize = 12;
  hintText.characters = isError ? "Error message" : "Hint text";
  hintText.fills = [{ type: "SOLID", color: isError ? { r: 0.8, g: 0.1, b: 0.1 } : { r: 0.5, g: 0.5, b: 0.5 } }];
  comp.appendChild(hintText);

  return comp;
}

async function buildCheckboxComponent(node, variantName) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });

  const comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = "HORIZONTAL";
  comp.counterAxisAlignItems = "CENTER";
  comp.itemSpacing = 8;
  comp.primaryAxisSizingMode = "AUTO";
  comp.counterAxisSizingMode = "AUTO";
  comp.fills = [];

  const isChecked = variantName.includes("Checked=True");
  const isFocus = variantName.includes("Focus");
  const isDisabled = variantName.includes("Disabled");

  const box = figma.createFrame();
  box.name = "checkbox-box";
  box.resize(20, 20);
  box.cornerRadius = 4;
  box.fills = isChecked
    ? [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }]
    : [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  box.strokes = [{ type: "SOLID", color: isChecked ? { r: 0.2, g: 0.4, b: 1 } : { r: 0.7, g: 0.7, b: 0.7 } }];
  box.strokeWeight = 2;
  box.strokeAlign = "INSIDE";
  if (isFocus) {
    box.effects = [{ type: "DROP_SHADOW", color: { r: 0.2, g: 0.4, b: 1, a: 0.4 }, offset: { x: 0, y: 0 }, radius: 4, spread: 2, visible: true, blendMode: "NORMAL" }];
  }
  if (isDisabled) box.opacity = 0.38;
  comp.appendChild(box);

  const label = figma.createText();
  label.name = "label";
  label.fontName = { family: "Inter", style: "Regular" };
  label.fontSize = 14;
  label.characters = extractLabelText(node) || "Checkbox label";
  label.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 }, opacity: isDisabled ? 0.38 : 1 }];
  comp.appendChild(label);

  return comp;
}

async function buildToggleComponent(node, variantName) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });

  const comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = "HORIZONTAL";
  comp.counterAxisAlignItems = "CENTER";
  comp.itemSpacing = 8;
  comp.fills = [];

  const isChecked = variantName.includes("Checked=True");
  const isFocus = variantName.includes("Focus");
  const isDisabled = variantName.includes("Disabled");

  const track = figma.createFrame();
  track.name = "track";
  track.resize(44, 24);
  track.cornerRadius = 12;
  track.fills = [{ type: "SOLID", color: isChecked ? { r: 0.2, g: 0.4, b: 1 } : { r: 0.7, g: 0.7, b: 0.7 } }];
  if (isDisabled) track.opacity = 0.38;
  if (isFocus) {
    track.strokes = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }];
    track.strokeWeight = 2;
    track.strokeAlign = "OUTSIDE";
  }

  const thumb = figma.createFrame();
  thumb.name = "thumb";
  thumb.resize(20, 20);
  thumb.cornerRadius = 10;
  thumb.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  thumb.x = isChecked ? 22 : 2;
  thumb.y = 2;
  track.appendChild(thumb);
  comp.appendChild(track);

  const label = figma.createText();
  label.name = "label";
  label.fontName = { family: "Inter", style: "Regular" };
  label.fontSize = 14;
  label.characters = extractLabelText(node) || "Toggle label";
  label.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 }, opacity: isDisabled ? 0.38 : 1 }];
  comp.appendChild(label);

  return comp;
}

async function buildAccordionComponent(node, variantName) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Medium" });

  const comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = "VERTICAL";
  comp.primaryAxisSizingMode = "AUTO";
  comp.counterAxisSizingMode = "FIXED";
  comp.resize(node.width || 400, comp.height);
  comp.fills = [];

  const isExpanded = variantName.includes("Expanded=True");
  const isFocus = variantName.includes("Focus");
  const isDisabled = variantName.includes("Disabled");

  const trigger = figma.createFrame();
  trigger.name = "trigger";
  trigger.layoutMode = "HORIZONTAL";
  trigger.primaryAxisSizingMode = "FIXED";
  trigger.counterAxisSizingMode = "AUTO";
  trigger.resize(node.width || 400, 52);
  trigger.primaryAxisAlignItems = "SPACE_BETWEEN";
  trigger.counterAxisAlignItems = "CENTER";
  trigger.paddingLeft = 16;
  trigger.paddingRight = 16;
  trigger.paddingTop = 14;
  trigger.paddingBottom = 14;
  trigger.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  trigger.strokes = [{ type: "SOLID", color: isFocus ? { r: 0.2, g: 0.4, b: 1 } : { r: 0.9, g: 0.9, b: 0.9 } }];
  trigger.strokeWeight = isFocus ? 2 : 1;
  trigger.strokeAlign = "INSIDE";
  if (isDisabled) trigger.opacity = 0.38;

  const itemLabel = figma.createText();
  itemLabel.name = "item-label";
  itemLabel.fontName = { family: "Inter", style: "Medium" };
  itemLabel.fontSize = 14;
  itemLabel.characters = extractLabelText(node) || "Accordion item";
  itemLabel.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 } }];
  trigger.appendChild(itemLabel);

  const chevron = figma.createFrame();
  chevron.name = "chevron-icon";
  chevron.resize(24, 24);
  chevron.fills = [];
  chevron.rotation = isExpanded ? 180 : 0;
  trigger.appendChild(chevron);

  comp.appendChild(trigger);

  const panel = figma.createFrame();
  panel.name = "panel";
  panel.layoutMode = "VERTICAL";
  panel.primaryAxisSizingMode = "AUTO";
  panel.counterAxisSizingMode = "FIXED";
  panel.resize(node.width || 400, panel.height);
  panel.paddingLeft = 16;
  panel.paddingRight = 16;
  panel.paddingTop = 12;
  panel.paddingBottom = 12;
  panel.fills = [{ type: "SOLID", color: { r: 0.97, g: 0.97, b: 0.97 } }];
  panel.visible = isExpanded;

  const panelContent = figma.createText();
  panelContent.name = "content";
  panelContent.fontName = { family: "Inter", style: "Regular" };
  panelContent.fontSize = 14;
  panelContent.characters = "Panel content";
  panelContent.fills = [{ type: "SOLID", color: { r: 0.3, g: 0.3, b: 0.3 } }];
  panel.appendChild(panelContent);

  comp.appendChild(panel);
  return comp;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function extractLabelText(node) {
  if (node.type === "TEXT") return node.characters;
  if ("children" in node) {
    for (const child of node.children) {
      const text = extractLabelText(child);
      if (text) return text;
    }
  }
  return null;
}

function isUniformChildren(node, classifyFn) {
  if (!("children" in node) || node.children.length < 2) return false;
  const firstType = classifyFn(node.children[0]);
  return node.children.every(c => classifyFn(c) === firstType && firstType !== "unknown");
}

// ─────────────────────────────────────────────
// COMPONENT SET BUILDER
// ─────────────────────────────────────────────

async function buildComponentSet(node, componentType) {
  const baseName = await getCleanComponentBaseName(node);
  const variants = COMPONENT_VARIANTS[componentType] || COMPONENT_VARIANTS.button;

  const components = [];
  for (const variantName of variants) {
    let comp;
    const fullName = `${baseName}/${variantName}`;
    switch (componentType) {
      case "button":    comp = await buildButtonComponent(node, fullName); break;
      case "textField": comp = await buildTextFieldComponent(node, fullName); break;
      case "checkbox":  comp = await buildCheckboxComponent(node, fullName); break;
      case "toggle":    comp = await buildToggleComponent(node, fullName); break;
      case "accordion": comp = await buildAccordionComponent(node, fullName); break;
      default:          comp = await buildButtonComponent(node, fullName); break;
      // TODO: add radio-group, select, modal, tabs, slider, star-rating builders
    }
    components.push(comp);
  }

  const OFFSET_X = 4000;
  const baseX = node.absoluteTransform[0][2];
  const baseY = node.absoluteTransform[1][2];
  components.forEach((comp, i) => {
    comp.x = baseX + OFFSET_X + (i * (node.width + 40));
    comp.y = baseY;
    figma.currentPage.appendChild(comp);
  });

  const componentSet = figma.combineAsVariants(components, figma.currentPage);
  componentSet.name = baseName;
  componentSet.description = COMPONENT_SEMANTIC_DESC[componentType] || "";

  return componentSet;
}

// ─────────────────────────────────────────────
// MAIN ENTRY: fixNonComponentElement
// ─────────────────────────────────────────────

async function fixNonComponentElement(node, componentType) {
  if (isA11yGeneratedLayer(node)) return { success: false, reason: "skipped_a11y_layer" };

  const parent = node.parent;
  if (!parent) return { success: false, reason: "no_parent" };

  const nodeIndex = parent.children.indexOf(node);

  // PATH B: uniform children — componentize each child
  if (isUniformChildren(node, classifyNode)) {
    const results = [];
    for (const child of [...node.children]) {
      const childType = classifyNode(child);
      if (childType !== "unknown") {
        const result = await fixNonComponentElement(child, childType);
        results.push(result);
      }
    }
    return { success: true, path: "B", childResults: results };
  }

  // PATH C: complex node — return FIGMA_AI prompt
  const isComplex = "children" in node && node.children.length > 3;
  if (isComplex && componentType !== "button" && componentType !== "toggle" && componentType !== "checkbox") {
    const childIds = "children" in node
      ? node.children.slice(0, 8).map(c => `${c.name} (id: ${c.id})`).join(", ")
      : "";
    return {
      success: false,
      path: "C",
      figmaAiPrompt: `Node "${node.name}" (id: ${node.id}) is a ${node.type}, not a component.
Convert it to a Figma component named "${await getCleanComponentBaseName(node)}" with variants for these states: ${(COMPONENT_VARIANTS[componentType] || []).join(", ")}.
Children to preserve as slots: ${childIds}.
The component must satisfy the ARIA ${componentType} pattern: ${COMPONENT_SEMANTIC_DESC[componentType]?.split("\n")[0]}.
Place the component set at x+4000 from its current position. Replace the original with a Default-state instance in the same position.`
    };
  }

  // PATH A: leaf or simple node — build component set
  try {
    const componentSet = await buildComponentSet(node, componentType);
    const defaultComp = componentSet.children.find(c => c.name.includes("Default")) || componentSet.children[0];

    const instance = defaultComp.createInstance();
    instance.x = node.x;
    instance.y = node.y;
    instance.resize(node.width, node.height);

    instance.setSharedPluginData("a11y", "role", componentType);
    instance.setSharedPluginData("a11y", "componentized", "true");
    instance.setSharedPluginData("a11y", "componentSetId", componentSet.id);

    parent.insertChild(nodeIndex, instance);
    node.remove();

    figma.commitUndo();

    return {
      success: true,
      path: "A",
      componentSetId: componentSet.id,
      instanceId: instance.id,
    };
  } catch (err) {
    return { success: false, path: "A", error: String(err) };
  }
}

// ─────────────────────────────────────────────
// INTEGRATION IN AUTO_FIX_HANDLERS
// ─────────────────────────────────────────────

AUTO_FIX_HANDLERS["NON_COMPONENT_ELEMENT"] = async (node, issue) => {
  const componentType = issue.detectedType || classifyNode(node) || "button";
  const result = await fixNonComponentElement(node, componentType);

  if (result.path === "C") {
    return {
      type: "FIGMA_AI",
      prompt: result.figmaAiPrompt,
      nodeId: node.id,
    };
  }

  return result;
};

// ─────────────────────────────────────────────
// INTEGRATION IN UI THREAD (ui.html)
// ─────────────────────────────────────────────
// When AUTO_FIX_HANDLERS["NON_COMPONENT_ELEMENT"] returns { type: "FIGMA_AI", prompt }:
// 1. Show the "Waiting for Figma AI" blue card
// 2. Post the prompt to Figma AI via the plugin's AI consent flow
// 3. On completion, re-scan the node to verify it is now a component/instance

// ─────────────────────────────────────────────
// SEMANTIC RULES CHECKLIST — verify before shipping
// ─────────────────────────────────────────────
// [ ] All created components placed at x+4000, never in the user's working canvas area
// [ ] Instance placed at exact x/y/width/height of the original node
// [ ] Original node removed after instance is inserted at same index
// [ ] All variants listed in COMPONENT_VARIANTS are built
// [ ] Component description set from COMPONENT_SEMANTIC_DESC
// [ ] Instance tagged with setSharedPluginData("a11y", ...)
// [ ] figma.commitUndo() called once after the full operation
// [ ] isA11yGeneratedLayer() checked at entry to prevent self-scan loops
// [ ] All text nodes load Inter font before characters are set
// [ ] Layer names follow semantic naming table (label, input, hint-text, error-text, etc.)
// [ ] Auto-layout direction is VERTICAL for form fields, HORIZONTAL for inline controls
// [ ] Focus variants include visible focus ring (stroke or effect)
// [ ] Disabled variants reduce opacity to 0.38 on affected children
// [ ] Icon-only controls have visually-hidden-label child