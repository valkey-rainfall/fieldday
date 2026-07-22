/* fieldday SVG renderer — JS port of the Python reference (render.py).
 *
 * Renders layout objects (the shape produced by layout.js computeLayouts,
 * optionally hand-annotated with title/extras/note) as themeable SVG.
 * Kept line-faithful to render.py so both implementations produce the
 * same geometry; the JS geometry tests mirror the pytest invariants.
 *
 * ES module, zero dependencies; works in browsers and Node >= 14.
 */

export const CHAR_W = 0.62; // monospace width/em estimate

/** Standard jemalloc small/large size class for an n-byte request
 *  (64-bit, default config). Illustrative: builds can differ. */
export function jemallocSizeClass(n) {
  if (n <= 8) return 8;
  if (n <= 16) return 16;
  if (n <= 128) return Math.ceil(n / 16) * 16;
  const group = 1 << (32 - Math.clz32(n - 1));
  const spacing = group / 8;
  return Math.ceil(n / spacing) * spacing;
}
const SEP_GAP_BITS = 16;    // visual gap (2 'bytes') before a separate allocation bar

// Default: light scheme matching the valkey.io blog.
export const DEFAULT_THEME = {
  "background": "#ffffff",
  "text": "#002a3a",
  "muted": "#666666",
  "field-fill": "#6983ff",
  "field-text": "#ffffff",
  "padding-fill": "#f5f7f7",
  "padding-stroke": "#b9c2cc",
  "field-border": "#30176e",
  "highlight": "#1e8e3e",
  "font": "'Fira Mono', Consolas, Menlo, Monaco, 'Courier New', monospace",
};

export const THEMES = {
  valkey: {},
  light: {},
  dark: {
    "background": "#1a1a2e", "text": "#e0e0e0", "muted": "#8a8a9a",
    "field-fill": "#7fb3e0", "field-text": "#16213e",
    "padding-fill": "#2a2a3e", "padding-stroke": "#555568",
    "field-border": "#444444", "highlight": "#e0b97f",
    "font": "ui-monospace, SFMono-Regular, 'Cascadia Code', monospace",
  },
};

export function defaultOptions() {
  return {
    pxPerByte: 15.0,
    barHeight: 56,
    fontSize: 15,          // inline labels
    calloutFontSize: 12,
    ruler: true,           // byte ruler below the bar
    rulerStep: 8,
    cacheLine: 64,         // heavy tick every N bytes (0 disables)
    jemallocSlack: false,  // show size-class round-up waste per allocation
    paddingCallout: false, // opt-in "N of M bytes are padding" line
    title: null,           // null = struct title or "struct NAME"
    showBitWidths: true,   // ":12" suffix on bitfield labels
    theme: {},
    transparent: false,    // skip background rect
    responsive: false,     // fluid width (100% up to natural size)
    extraCss: "",          // user CSS appended inside the <style> block
    cornerRadius: 4,
    margin: 24,
  };
}

// ---------------------------------------------------------------- segments

function paddingBytes(sl) {
  return sl.fields.reduce((n, f) => n + (f.is_padding ? f.size : 0), 0);
}

function segmentsFromLayout(sl, opts) {
  const relabel = sl.relabel || {};
  let segs = [];
  for (const f of sl.fields) {
    // manual relabel: custom label used verbatim; '' hides the label
    const custom = f.is_padding ? undefined : relabel[f.name];
    if (f.bit_offset !== undefined && f.bit_offset !== null) {
      let label = f.name;
      if (opts.showBitWidths && f.bit_width) label = `${f.name}:${f.bit_width}`;
      if (custom !== undefined) label = custom;
      segs.push({ label, startBits: f.bit_offset, widthBits: f.bit_width || 0,
                  isBitfield: true });
    } else if (f.size === 0 && !f.is_padding) {
      // flexible array member: nominal 1-byte box dangling past the end
      const label = custom !== undefined ? custom : f.name + "[]";
      segs.push({ label, startBits: f.offset * 8, widthBits: 8,
                  isFlex: true });
    } else {
      let name = (f.is_pointer && !f.name.startsWith("*")) ? "*" + f.name : f.name;
      if (custom !== undefined) name = custom;
      segs.push({ label: f.is_padding ? "padding-fill" : name,
                  startBits: f.offset * 8, widthBits: f.size * 8,
                  isPadding: !!f.is_padding,
                  dividersBits: (f.dividers || []).map((d) => d * 8) });
    }
  }
  // fill sub-byte gaps (bitfield allocation-unit padding) with hatched
  // padding at bit precision -- the layout model's pad fields are byte-
  // granular, so leftover bits after the last bitfield in a unit would
  // otherwise render as blank canvas
  segs.sort((a, b) => a.startBits - b.startBits);
  const filled = [];
  let cursorBits = 0;
  for (const g of segs) {
    if (g.startBits > cursorBits) {
      filled.push({ label: "", startBits: cursorBits,
                    widthBits: g.startBits - cursorBits, isPadding: true });
    }
    filled.push(g);
    cursorBits = Math.max(cursorBits, g.startBits + g.widthBits);
  }
  if (sl.size * 8 > cursorBits) {
    filled.push({ label: "", startBits: cursorBits,
                  widthBits: sl.size * 8 - cursorBits, isPadding: true });
  }
  segs = filled;

  // hand-annotated companion allocations
  let cursor = Math.max(sl.size * 8, ...segs.map((g) => g.startBits + g.widthBits));
  for (const extra of sl.extras || []) {
    const kind = extra.kind || "embedded";
    const widthBits = Math.trunc(extra.bytes) * 8;
    if (kind === "separate") cursor += SEP_GAP_BITS;
    segs.push({ label: extra.label, startBits: cursor, widthBits,
                isExtra: true, extraKind: kind,
                dividersBits: (extra.dividers || []).map((d) => d * 8) });
    cursor += widthBits;
  }

  // jemalloc round-up slack, appended at the end of each allocation.
  // A flexible array member makes the real allocation size unknowable
  // from the diagram, so slack is skipped for that case.
  if (opts.jemallocSlack && !segs.some((g) => g.isFlex)) {
    const bounds = [];
    let cur = [0, sl.size * 8];
    for (const g of segs) {
      if (g.isExtra && g.extraKind === "separate") {
        bounds.push(cur);
        cur = [g.startBits, g.startBits + g.widthBits];
      } else {
        cur[1] = Math.max(cur[1], g.startBits + g.widthBits);
      }
    }
    bounds.push(cur);

    let cumBits = 0;
    const slackBoxes = [];
    for (const [aStart, aEnd] of bounds) {
      for (const g of segs) {
        if (aStart <= g.startBits && g.startBits < Math.max(aEnd, aStart + 1)) {
          g.startBits += cumBits;
        }
      }
      const used = Math.trunc((aEnd - aStart) / 8);
      const klass = jemallocSizeClass(used);
      const slack = klass - used;
      if (slack) {
        slackBoxes.push({ label: `+${slack}B (${klass}B class)`,
                          startBits: aEnd + cumBits, widthBits: slack * 8,
                          isSlack: true });
        cumBits += slack * 8;
      }
    }
    segs.push(...slackBoxes);
    segs.sort((a, b) => a.startBits - b.startBits);
  }
  return segs;
}

// ---------------------------------------------------------------- callouts

function textW(s, size) { return s.length * size * CHAR_W; }

function planLabels(segs, opts, x0) {
  const ppb = opts.pxPerByte;
  const inline = [];
  const callouts = [];
  for (const seg of segs) {
    const w = seg.widthBits / 8 * ppb;
    if (seg.isPadding) {
      inline.push([seg, textW("padding-fill", opts.fontSize) + 8 <= w ? "padding-fill" : ""]);
      continue;
    }
    if (!seg.label || textW(seg.label, opts.fontSize) + 8 <= w) {
      inline.push([seg, seg.label]);
    } else {
      const cx = x0 + (seg.startBits + seg.widthBits / 2) / 8 * ppb;
      callouts.push({ seg, labelX: cx, width: textW(seg.label, opts.calloutFontSize),
                      targetX: cx, elbowY: 0 });
    }
  }

  // declutter: greedy left-to-right shift, then re-center each run
  const gap = 10;
  const runs = [];
  for (const c of callouts) {
    const last = runs.length ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
    if (last && c.labelX - c.width / 2 < last.labelX + last.width / 2 + gap) {
      c.labelX = last.labelX + last.width / 2 + gap + c.width / 2;
      runs[runs.length - 1].push(c);
    } else {
      runs.push([c]);
    }
  }
  for (const run of runs) {
    if (run.length > 1) {
      const drift = run.reduce((a, c) => a + c.labelX - c.targetX, 0) / run.length;
      for (const c of run) c.labelX -= drift;
    }
  }

  // clamp runs onto the canvas and restore inter-run ordering
  let prevEnd = x0;
  for (const run of runs) {
    const left = run[0].labelX - run[0].width / 2;
    const need = Math.max(x0, prevEnd + (prevEnd > x0 ? gap : 0));
    if (left < need) {
      const shift = need - left;
      for (const c of run) c.labelX += shift;
    }
    prevEnd = run[run.length - 1].labelX + run[run.length - 1].width / 2;
  }
  return [inline, callouts, runs];
}

function assignElbows(runs, barTop, step = 8.0) {
  for (const run of runs) {
    const joggers = run.filter((c) => Math.abs(c.labelX - c.targetX) > 0.5);
    joggers.forEach((c, level) => {
      c.elbowY = (barTop - 8) - (joggers.length - 1 - level) * step;
    });
  }
}

// ---------------------------------------------------------------- svg emit

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Match Python's f"{x:.1f}" (round-half-even) so both renderers emit
// byte-identical geometry.
function f1(x) {
  const v = x * 10;
  let r = Math.round(v);
  if (Math.abs(v - Math.floor(v) - 0.5) < 1e-9) r = 2 * Math.round(v / 2);
  const out = r / 10;
  return (Object.is(out, -0) ? 0 : out).toFixed(1);
}

function styleBlock(theme, extraCss = "") {
  const t = { ...DEFAULT_THEME, ...theme };
  const tail = extraCss.trim() ? "\n" + extraCss.trim() : "";
  return `<style>
  .fd-background      { fill: var(--fd-background, ${t["background"]}); }
  .fd-title   { fill: var(--fd-text, ${t["text"]}); }
  .fd-field-box   { fill: var(--fd-field-fill, ${t["field-fill"]}); stroke: var(--fd-field-border, ${t["field-border"]}); stroke-width: 1; }
  .fd-padding-box     { fill: url(#fd-hatch); stroke: var(--fd-padding-stroke, ${t["padding-stroke"]}); stroke-width: 1; }
  .fd-flexible-array    { fill: none; stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; stroke-dasharray: 4 3; }
  .fd-extra-box   { fill: var(--fd-field-fill, ${t["field-fill"]}); fill-opacity: 0.55; stroke: var(--fd-field-border, ${t["field-border"]}); stroke-width: 1; stroke-dasharray: 5 3; }
  .fd-slack-box   { fill: var(--fd-muted, ${t["muted"]}); fill-opacity: 0.10; stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; stroke-dasharray: 2 3; }
  .fd-slack-label { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-allocation-plus    { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-field-label   { fill: var(--fd-field-text, ${t["field-text"]}); }
  .fd-padding-label  { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-callout-label { fill: var(--fd-text, ${t["text"]}); }
  .fd-leader-line  { stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; fill: none; }
  .fd-ruler-line   { stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; }
  .fd-cache-line   { stroke: var(--fd-text, ${t["text"]}); stroke-width: 3; stroke-dasharray: 7 4; opacity: 0.8; }
  .fd-cache-line-label    { fill: var(--fd-text, ${t["text"]}); }
  .fd-pointer-arrow  { stroke: var(--fd-text, ${t["text"]}); stroke-width: 1.5; fill: none; }
  .fd-pointer-head   { fill: var(--fd-text, ${t["text"]}); }
  .fd-ruler-label    { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-note  { fill: var(--fd-highlight, ${t["highlight"]}); }
  .fd-note-plain { fill: var(--fd-text, ${t["text"]}); }
  text        { font-family: var(--fd-font, ${t["font"]}); }
  .fd-hatch-background { fill: var(--fd-padding-fill, ${t["padding-fill"]}); }
  .fd-hatch-lines { stroke: var(--fd-padding-stroke, ${t["padding-stroke"]}); stroke-width: 1.5; }
  .fd-subdivision-line  { stroke: var(--fd-field-text, ${t["field-text"]}); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.45; }${tail}
</style>`;
}

const HATCH = '<defs><pattern id="fd-hatch" width="6" height="6" ' +
  'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
  '<rect class="fd-hatch-background" width="6" height="6"/>' +
  '<line class="fd-hatch-lines" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>';

function textEl(x, y, s, size, cls, anchor = "middle", weight = "600") {
  return `<text class="${cls}" x="${f1(x)}" y="${f1(y)}" font-size="${size}" ` +
    `font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;
}

/** Render one struct layout object to an SVG string.
 *  `sl` is one element of computeLayouts() output, optionally carrying
 *  `title`, `extras` [{label, bytes, kind}], and `note` annotations. */
export function renderStruct(sl, userOpts = {}) {
  const opts = { ...defaultOptions(), ...userOpts };
  const ppb = opts.pxPerByte;
  const m = opts.margin;
  const x0 = m;
  const segs = segmentsFromLayout(sl, opts);
  const endBits = Math.max(sl.size * 8, ...segs.map((g) => g.startBits + g.widthBits));
  const totalPx = endBits / 8 * ppb;

  const [inline, callouts, runs] = planLabels(segs, opts, x0);

  const title = opts.title !== null && opts.title !== undefined
    ? opts.title : (sl.title || `struct ${sl.name}`);
  let cy = m + 4;
  const parts = [];
  if (title) {
    parts.push(textEl(x0, cy + 10, title, 15, "fd-title", "start", "700"));
    cy += 30;
  }
  let calloutY = 0;
  if (callouts.length) {
    calloutY = cy + opts.calloutFontSize;
    const maxJog = Math.max(0, ...runs.map(
      (run) => run.filter((c) => Math.abs(c.labelX - c.targetX) > 0.5).length));
    cy = calloutY + 14 + 8 * maxJog;
  }
  const barTop = cy;
  assignElbows(runs, barTop);

  // group segments into allocations: the struct plus its embedded
  // extras form allocation 0; each separate extra starts a new
  // allocation that includes any embedded extras following it
  const allocs = [];
  {
    let curStart = 0, curEnd = sl.size * 8;
    for (const g of segs) {
      if (g.isExtra && g.extraKind === "separate") {
        allocs.push([curStart, curEnd]);
        curStart = g.startBits;
        curEnd = g.startBits + g.widthBits;
      } else {
        curEnd = Math.max(curEnd, g.startBits + g.widthBits);
      }
    }
    allocs.push([curStart, curEnd]);
  }

  // bar segments
  for (const seg of segs) {
    const x = x0 + seg.startBits / 8 * ppb;
    const w = seg.widthBits / 8 * ppb;
    let cls;
    if (seg.isSlack) cls = "fd-slack-box";
    else if (seg.isPadding) cls = "fd-padding-box";
    else if (seg.isFlex) cls = "fd-flexible-array";
    else if (seg.isExtra) {
      cls = "fd-extra-box";
      if (seg.extraKind === "separate") {
        const gapPx = SEP_GAP_BITS / 8 * ppb;
        parts.push(textEl(x - gapPx / 2, barTop + opts.barHeight / 2 + 5,
                          "+", 17, "fd-allocation-plus", "middle", "700"));
      }
    } else cls = "fd-field-box";
    parts.push(`<rect class="${cls}" x="${f1(x)}" y="${f1(barTop)}" ` +
      `width="${f1(w)}" height="${opts.barHeight}" rx="${opts.cornerRadius}"/>`);
    for (const db of seg.dividersBits || []) {
      const dx = x + db / 8 * ppb;
      parts.push(`<line class="fd-subdivision-line" x1="${f1(dx)}" y1="${f1(barTop + 3)}" ` +
        `x2="${f1(dx)}" y2="${f1(barTop + opts.barHeight - 3)}"/>`);
    }
  }
  // cache-line boundaries: bold dashed rules cutting through the bar
  // (and down to the ruler when present), per allocation
  if (opts.cacheLine) {
    const ruleBottom = barTop + opts.barHeight + (opts.ruler ? 8 + 9 : 0);
    for (const [aStart, aEnd] of allocs) {
      const nBytes = Math.trunc((aEnd - aStart) / 8);
      for (let b = opts.cacheLine; b <= nBytes; b += opts.cacheLine) {
        const x = x0 + aStart / 8 * ppb + b * ppb;
        parts.push(`<line class="fd-cache-line" x1="${f1(x)}" y1="${f1(barTop - 4)}" ` +
          `x2="${f1(x)}" y2="${f1(ruleBottom)}"/>`);
      }
    }
  }

  for (const [seg, txt] of inline) {
    if (!txt) continue;
    const x = x0 + (seg.startBits + seg.widthBits / 2) / 8 * ppb;
    const cls = seg.isSlack ? "fd-slack-label"
      : seg.isPadding ? "fd-padding-label"
      : seg.isExtra ? "fd-callout-label" : "fd-field-label";
    parts.push(textEl(x, barTop + opts.barHeight / 2 + 5, txt,
                      opts.fontSize, cls, "middle", "700"));
  }

  // callouts + leaders
  for (const c of callouts) {
    parts.push(textEl(c.labelX, calloutY, c.seg.label, opts.calloutFontSize, "fd-callout-label"));
    const top = calloutY + 4;
    if (c.elbowY > 0) {
      parts.push(`<path class="fd-leader-line" d="M ${f1(c.labelX)} ${f1(top)} ` +
        `V ${f1(c.elbowY)} H ${f1(c.targetX)} V ${f1(barTop - 1)}"/>`);
    } else {
      parts.push(`<line class="fd-leader-line" x1="${f1(c.labelX)}" y1="${f1(top)}" ` +
        `x2="${f1(c.labelX)}" y2="${f1(barTop - 1)}"/>`);
    }
  }

  cy = barTop + opts.barHeight;

  // byte rulers: the main allocation ruler continues across embedded
  // extras (same allocation); each separate extra gets its own ruler
  // restarting at 0 (it is its own allocation).
  if (opts.ruler) {
    const ry = cy + 8;
    const drawRuler = (startBits, endBits, labelBase) => {
      const rx1 = x0 + startBits / 8 * ppb;
      const rx2 = x0 + endBits / 8 * ppb;
      const nBytes = Math.trunc((endBits - startBits) / 8);
      parts.push(`<line class="fd-ruler-line" x1="${f1(rx1)}" y1="${ry}" x2="${f1(rx2)}" y2="${ry}"/>`);
      const tick = (b, cls, tlen, lblcls, weight) => {
        const x = rx1 + b * ppb;
        parts.push(`<line class="${cls}" x1="${f1(x)}" y1="${ry}" x2="${f1(x)}" y2="${ry + tlen}"/>`);
        parts.push(textEl(x, ry + 20, String(labelBase + b), 11, lblcls, "middle", weight));
      };
      const cl = opts.cacheLine;
      for (let b = 0; b <= nBytes; b += opts.rulerStep) {
        if (!(cl && b && b % cl === 0)) tick(b, "fd-ruler-line", 6, "fd-ruler-label", "600");
      }
      if (nBytes % opts.rulerStep !== 0 && !(cl && nBytes % cl === 0)) {
        tick(nBytes, "fd-ruler-line", 6, "fd-ruler-label", "600");
      }
      // cache-line boundaries: bold label; the rule itself is the
      // full-height overlay drawn through the bar
      if (cl) {
        for (let b = cl; b <= nBytes; b += cl) {
          const x = rx1 + b * ppb;
          parts.push(textEl(x, ry + 20, String(labelBase + b), 12, "fd-cache-line-label", "middle", "700"));
        }
      }
    };
    for (const [aStart, aEnd] of allocs) drawRuler(aStart, aEnd, 0);
    cy = ry + 26;
  }

  // pointer arrows: from a member's box down below the ruler, across,
  // and up into the start of the target member/extra (arrowhead up)
  if (sl.arrows && sl.arrows.length) {
    const centers = {};
    const starts = {};
    for (const f of sl.fields) {
      if (!f.is_padding) centers[f.name] = x0 + (f.offset + Math.max(f.size, 1) / 2) * ppb;
    }
    for (const g of segs) {
      if (g.isExtra) {
        centers[g.label] = x0 + (g.startBits + g.widthBits / 2) / 8 * ppb;
        starts[g.label] = x0 + g.startBits / 8 * ppb;
      } else if (!g.isPadding) {
        const base = g.label.replace(/^\*/, "").split(":")[0].replace(/\[\]$/, "");
        if (!(base in starts)) starts[base] = x0 + g.startBits / 8 * ppb;
      }
    }
    const barBottom = barTop + opts.barHeight;
    const lane0 = cy + 10;
    sl.arrows.forEach((arrow, i) => {
      const src = arrow.from, dst = arrow.to;
      const fx = centers[src];
      let tx = dst in starts ? starts[dst] : centers[dst];
      if (fx === undefined || tx === undefined) {
        throw new Error(`arrow endpoint not found: '${src}' -> '${dst}' ` +
          "(use a member name or an extra's label)");
      }
      if ("to_offset" in arrow && dst in starts) {
        // exact byte offset within the target (e.g. past an sds header)
        tx = starts[dst] + Number(arrow.to_offset) * ppb;
      } else if (dst in starts) {
        tx += 5;
      }
      const lane = lane0 + i * 13;
      parts.push(`<path class="fd-pointer-arrow" d="M ${f1(fx)} ${f1(barBottom + 2)} ` +
        `V ${f1(lane)} H ${f1(tx)} V ${f1(barBottom + 8)}"/>`);
      parts.push(`<polygon class="fd-pointer-head" points="` +
        `${f1(tx - 4)},${f1(barBottom + 8)} ${f1(tx + 4)},${f1(barBottom + 8)} ` +
        `${f1(tx)},${f1(barBottom + 1)}"/>`);
    });
    cy = lane0 + (sl.arrows.length - 1) * 13 + 8;
  }

  // padding callout
  const padB = paddingBytes(sl);
  if (opts.paddingCallout && padB) {
    cy += 18;
    // match Python round() (half-even)
    const v = padB * 100 / sl.size;
    let pct = Math.round(v);
    if (Math.abs(v - Math.trunc(v) - 0.5) < 1e-9) pct = 2 * Math.round(v / 2);
    parts.push(textEl(x0, cy, `\u25bc ${padB} of ${sl.size} bytes are padding (${pct}%)`,
                      13, "fd-note", "start", "700"));
  }

  // hand-annotated note: neutral by default; the savings style opts into
  // the green decrease glyph (only right when the note describes a saving)
  if (sl.note) {
    cy += 18;
    if (sl.note_style === "savings") {
      parts.push(textEl(x0, cy, `\u25bc ${sl.note}`, 13, "fd-note", "start", "700"));
    } else {
      parts.push(textEl(x0, cy, sl.note, 13, "fd-note-plain", "start", "600"));
    }
  }

  // canvas must fit callout labels and title, not just the bar
  let contentRight = x0 + totalPx;
  for (const c of callouts) contentRight = Math.max(contentRight, c.labelX + c.width / 2);
  if (title) contentRight = Math.max(contentRight, x0 + textW(title, 15));
  const width = Math.trunc(contentRight + m);
  const height = Math.trunc(cy + m / 2);
  const bg = opts.transparent ? "" : '<rect class="fd-background" width="100%" height="100%" rx="8"/>\n';
  const dims = opts.responsive
    ? `style="width:100%;max-width:${width}px;height:auto"`
    : `width="${width}" height="${height}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `${dims}>\n${styleBlock(opts.theme, opts.extraCss)}\n${bg}${HATCH}\n` + parts.join("\n") + "\n</svg>";
}
