/* fieldday web app: live editor -> layout.js -> render.js -> inline SVG. */

import { computeLayouts, LayoutError } from "./layout.js";
import { renderStruct, THEMES } from "./render.js";

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
  "stub directive": `//@ stub robj 16 8
struct entry {
    robj *obj;
    uint32_t hash;
    struct entry *next;
};`,
};

let layouts = [];          // last successful computeLayouts result
let currentSvgs = [];      // [{name, svg}] from last render

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
    extras.push({ label: parts[0], bytes, kind });
  }
  return extras;
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
  };
}

function annotate(sl, isSelected) {
  // annotations apply to the selected struct only (single-struct: always)
  if (!isSelected) return sl;
  const copy = { ...sl };
  const title = $("title").value.trim();
  const note = $("note").value.trim();
  if (title) copy.title = title;
  if (note) copy.note = note;
  copy.extras = parseExtras($("extras").value);
  return copy;
}

function rerender() {
  const err = $("error");
  const preview = $("preview");
  try {
    layouts = computeLayouts($("snippet").value);
    updateStructPicker();
    const sel = selectedStructIndex();
    const opts = options();
    currentSvgs = layouts.map((sl, i) => ({
      name: sl.name,
      svg: renderStruct(annotate(sl, i === sel), opts),
    }));
    preview.innerHTML = currentSvgs.map((s) => s.svg).join("\n");
    err.hidden = true;
  } catch (e) {
    if (!(e instanceof LayoutError)) console.error(e);
    err.textContent = e.message;
    err.hidden = false;
    // keep last good preview visible
  }
}

function download(name, mime, content) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function layoutJson() {
  const sel = selectedStructIndex();
  const structs = layouts.map((sl, i) => annotate(sl, i === sel));
  return JSON.stringify({ structs }, null, 2) + "\n";
}

// --- wire up ---

const exWrap = $("examples");
for (const [name, code] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "secondary";
  b.textContent = name;
  b.addEventListener("click", () => {
    $("snippet").value = code;
    rerender();
  });
  exWrap.appendChild(b);
}

let timer = null;
function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(rerender, 200);
}

$("snippet").addEventListener("input", scheduleRender);
$("extras").addEventListener("input", scheduleRender);
for (const id of ["theme", "ppb", "ruler", "padcallout", "transparent",
                  "responsive", "title", "note", "structpick"]) {
  $(id).addEventListener("change", rerender);
  $(id).addEventListener("input", scheduleRender);
}

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

$("snippet").value = EXAMPLES["client (padding demo)"];
rerender();
