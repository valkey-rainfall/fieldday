/* fieldday web app: live editor -> layout.js -> render.js -> inline SVG. */

import { computeLayouts, LayoutError } from "./layout.js";
import { renderStruct, THEMES, DEFAULT_THEME } from "./render.js";
import { makeEditor } from "./editor.js";

const $ = (id) => document.getElementById(id);

const EXAMPLES = {
  "client (padding demo)": `struct client {
    uint64_t id;
    int fd;
    uint8_t resp;
    sds name;
    unsigned flags : 12;
    unsigned paused : 1;
    void *conn;
};`,
  "Valkey robj 9.1": `/* Valkey 9.1 string object header (server.h) */
struct robj {
    unsigned type : 4;
    unsigned encoding : 4;
    unsigned lru : 24;
    unsigned hasexpire : 1;
    unsigned hasembkey : 1;
    unsigned hasembval : 1;
    unsigned refcount : 29;
    void *val_ptr;
};`,
  "Valkey zskiplistNode": `/* element in a separate sds allocation (pre-9.1) */
typedef struct zskiplistNode {
    sds ele;
    double score;
    struct zskiplistNode *backward;
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;
    } level[];
} zskiplistNode;`,
  "composite struct (subdivisions)": `struct inner {
    long a;
    int b;
    short c;
};
struct outer {
    int values[5];
    struct inner nested;
    struct tagged { void *p; uint32_t n; } inline_def;
    char tag;
};`,
  "stub directive": `//@ stub robj 16 8
struct entry {
    robj *obj;
    uint32_t hash;
    struct entry *next;
};`,
  "extras: embedded + separate": `/* companion allocations via the Annotations panel:
   embedded items continue an allocation (and its ruler);
   a separate item starts its own allocation and ruler */
struct node {
    double score;
    struct node *next;
    uint32_t hash;
};`,
};

const EXAMPLE_ANNOTATIONS = {
  "extras: embedded + separate": {
    node: {
      title: "node + out-of-line element (2 allocations)",
      note: "24B node + 20B element = 44 bytes in 2 allocations",
      extras: [
        "inline tag | 4 | embedded",
        "element sds hdr | 4 | separate",
        "element bytes (16B) | 16 | embedded",
      ].join("\n"),
      relabel: "",
    },
  },
};

function themeCssTemplate(themeName) {
  const t = { ...DEFAULT_THEME, ...(THEMES[themeName] || {}) };
  const lines = Object.entries(t)
    .map(([k, v]) => `  --fd-${k}: ${v};`).join("\n");
  return `:root {\n${lines}\n}`;
}

let lastCssTemplate = "";

function syncCssBox() {
  const box = $("customcss");
  const tpl = themeCssTemplate($("theme").value);
  // don't clobber user edits: only replace if untouched or still a template
  if (!box.value.trim() || box.value === lastCssTemplate) box.value = tpl;
  lastCssTemplate = tpl;
}

let layouts = [];          // last successful computeLayouts result
let currentSvgs = [];      // [{name, svg}] from last render
let annStore = {};         // struct name -> {title, note, extras, relabel}
let annCurrent = null;     // struct name currently shown in the fields

function saveAnnFields() {
  if (annCurrent === null) return;
  annStore[annCurrent] = {
    title: $("title").value,
    note: $("note").value,
    extras: $("extras").value,
    relabel: $("relabel").value,
    arrows: $("arrows").value,
  };
}

function loadAnnFields(name) {
  const a = annStore[name] || { title: "", note: "", extras: "", relabel: "", arrows: "" };
  $("title").value = a.title;
  $("note").value = a.note;
  $("extras").value = a.extras;
  $("relabel").value = a.relabel;
  $("arrows").value = a.arrows || "";
  annCurrent = name;
}

function parseExtras(text) {
  const extras = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    const bytes = parseInt(parts[1], 10);
    if (!parts[0] || !Number.isFinite(bytes) || bytes <= 0) {
      throw new LayoutError(
        `bad extras line: '${line}' (expected: label | bytes | embedded/separate)`);
    }
    const kind = (parts[2] || "embedded").toLowerCase();
    if (kind !== "embedded" && kind !== "separate") {
      throw new LayoutError(`bad extras kind '${parts[2]}' (embedded or separate)`);
    }
    const extra = { label: parts[0], bytes, kind };
    if (parts[3]) {
      extra.dividers = parts[3].split(",").map((d) => parseInt(d.trim(), 10));
      if (extra.dividers.some((d) => !Number.isFinite(d) || d <= 0 || d >= bytes)) {
        throw new LayoutError(
          `bad extras dividers '${parts[3]}' (comma-separated byte offsets within the item)`);
      }
    }
    extras.push(extra);
  }
  return extras;
}

function parseRelabel(text) {
  const relabel = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.indexOf("|");
    if (bar < 0) throw new LayoutError(
      `bad relabel line: '${line}' (expected: member | new label, empty label hides)`);
    const member = line.slice(0, bar).trim();
    if (!member) throw new LayoutError(`bad relabel line: '${line}' (missing member name)`);
    relabel[member] = line.slice(bar + 1).trim();
  }
  return relabel;
}

function parseArrows(text) {
  const arrows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new LayoutError(
        `bad arrow line: '${line}' (expected: from member | to member/extra [| byte offset])`);
    }
    const arrow = { from: parts[0], to: parts[1] };
    if (parts[2]) {
      const off = parseFloat(parts[2]);
      if (!Number.isFinite(off) || off < 0) {
        throw new LayoutError(`bad arrow offset '${parts[2]}' (bytes into the target)`);
      }
      arrow.to_offset = off;
    }
    arrows.push(arrow);
  }
  return arrows;
}

function selectedStructIndex() {
  const pick = $("structpick");
  const i = parseInt(pick.value, 10);
  return Number.isFinite(i) && i >= 0 && i < layouts.length ? i : 0;
}

function updateStructPicker() {
  const wrap = $("structpick-wrap");
  const pick = $("structpick");
  if (layouts.length <= 1) {
    wrap.hidden = true;
    return;
  }
  const prev = pick.value;
  pick.innerHTML = "";
  layouts.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = s.name;
    pick.appendChild(o);
  });
  if ([...pick.options].some((o) => o.value === prev)) pick.value = prev;
  wrap.hidden = false;
}

function options() {
  return {
    theme: THEMES[$("theme").value] || {},
    pxPerByte: Math.min(60, Math.max(2, parseFloat($("ppb").value) || 15)),
    ruler: $("ruler").checked,
    paddingCallout: $("padcallout").checked,
    transparent: $("transparent").checked,
    responsive: $("responsive").checked,
    extraCss: $("customcss").value,
  };
}

function annotate(sl) {
  // each struct carries its own annotations (annStore, keyed by name)
  const a = annStore[sl.name];
  if (!a) return sl;
  const copy = { ...sl };
  if (a.title && a.title.trim()) copy.title = a.title.trim();
  if (a.note && a.note.trim()) copy.note = a.note.trim();
  copy.extras = parseExtras(a.extras || "");
  copy.relabel = parseRelabel(a.relabel || "");
  copy.arrows = parseArrows(a.arrows || "");
  return copy;
}

let mode = "c";  // source of truth: "c" (snippet) | "json" (layout JSON)

function annotatedStructs() {
  return layouts.map((sl) => annotate(sl));
}

function rerender() {
  const err = $("error");
  const preview = $("preview");
  try {
    let structs;
    if (mode === "c") {
      layouts = computeLayouts(cEditor.get());
      updateStructPicker();
      const curName = layouts[selectedStructIndex()]?.name;
      if (curName !== annCurrent) loadAnnFields(curName);
      structs = annotatedStructs();
      // keep the JSON pane a live read-only view of the annotated layout
      jsonEditor.set(JSON.stringify({ structs }, null, 2));
    } else {
      const data = JSON.parse(jsonEditor.get());
      if (!data || !Array.isArray(data.structs)) {
        throw new LayoutError("layout JSON must be an object with a 'structs' array");
      }
      structs = data.structs;
      layouts = structs;
      updateStructPicker();
    }
    const opts = options();
    currentSvgs = structs.map((sl) => ({
      name: sl.name,
      svg: renderStruct(sl, opts),
    }));
    preview.innerHTML = currentSvgs.map((s) => s.svg).join("\n");
    err.hidden = true;
  } catch (e) {
    if (!(e instanceof LayoutError) && !(e instanceof SyntaxError)) console.error(e);
    err.textContent = e.message;
    err.hidden = false;
    // keep last good preview visible
  }
}

function setMode(m) {
  if (m === mode) return;
  if (m === "c" && jsonDirty &&
      !window.confirm("Switch back to C mode? Your JSON edits will be replaced by the layout generated from the C snippet.")) {
    return;
  }
  mode = m;
  jsonDirty = false;
  cEditor.setReadOnly(m === "json");
  jsonEditor.setReadOnly(m === "c");
  $("annotations-fieldset").disabled = m === "json";
  $("mode-toggle").textContent = m === "c" ? "Edit JSON directly" : "Back to C snippet";
  $("json-status").textContent = m === "c"
    ? "read-only view of the generated layout — click to edit"
    : "JSON is now the source of truth; the C snippet is locked";
  rerender();
}

function download(name, mime, content) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function layoutJson() {
  if (mode === "json") return jsonEditor.get().trimEnd() + "\n";
  return JSON.stringify({ structs: annotatedStructs() }, null, 2) + "\n";
}

// --- wire up ---

const exWrap = $("examples");
for (const [name, code] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "secondary";
  b.textContent = name;
  b.addEventListener("click", () => {
    if (mode !== "c") setMode("c");
    cEditor.set(code);
    annStore = { ...(EXAMPLE_ANNOTATIONS[name] || {}) };
    annCurrent = null;
    rerender();
  });
  exWrap.appendChild(b);
}

let timer = null;
function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(rerender, 200);
}

$("customcss").addEventListener("input", scheduleRender);
$("mode-toggle").addEventListener("click", () =>
  setMode(mode === "c" ? "json" : "c"));
$("theme").addEventListener("change", () => { syncCssBox(); rerender(); });
for (const id of ["theme", "ppb", "ruler", "padcallout", "transparent",
                  "responsive"]) {
  $(id).addEventListener("change", rerender);
  $(id).addEventListener("input", scheduleRender);
}
for (const id of ["title", "note", "extras", "relabel", "arrows"]) {
  $(id).addEventListener("input", () => { saveAnnFields(); scheduleRender(); });
}
$("structpick").addEventListener("change", () => {
  loadAnnFields(layouts[selectedStructIndex()]?.name ?? null);
  rerender();
});

$("dl-svg").addEventListener("click", () => {
  if (!currentSvgs.length) return;
  const sel = selectedStructIndex();
  const { name, svg } = currentSvgs[Math.min(sel, currentSvgs.length - 1)];
  download(`${name}.svg`, "image/svg+xml", svg);
});
$("dl-json").addEventListener("click", () => {
  if (!layouts.length) return;
  download("layout.json", "application/json", layoutJson());
});

let jsonDirty = false;
const cEditor = makeEditor({
  parent: $("snippet-editor"), lang: "c",
  doc: EXAMPLES["client (padding demo)"],
  onChange: () => { if (mode === "c") scheduleRender(); },
});
const jsonEditor = makeEditor({
  parent: $("json-editor"), lang: "json", readOnly: true,
  onChange: () => { if (mode === "json") { jsonDirty = true; scheduleRender(); } },
});
jsonEditor.setReadOnly(true);

// scripting/test hook
window.fieldday = {
  setSnippet: (t) => { if (mode !== "c") setMode("c"); cEditor.set(t); rerender(); },
  getSnippet: () => cEditor.get(),
  setJson: (t) => { jsonEditor.set(t); jsonDirty = true; rerender(); },
  getJson: () => jsonEditor.get(),
  setMode,
  getMode: () => mode,
};

syncCssBox();
rerender();
