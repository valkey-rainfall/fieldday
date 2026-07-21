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
const SEP_GAP_BITS = 16;    // visual gap (2 'bytes') before a separate allocation bar

// Default: light scheme matching the valkey.io blog.
export const DEFAULT_THEME = {
  "bg": "#ffffff",
  "text": "#002a3a",
  "muted": "#666666",
  "field": "#6983ff",
  "field-text": "#ffffff",
  "pad": "#f5f7f7",
  "pad-stroke": "#b9c2cc",
  "border": "#30176e",
  "accent": "#1e8e3e",
  "font": "'Fira Mono', Consolas, Menlo, Monaco, 'Courier New', monospace",
};

export const THEMES = {
  valkey: {},
  light: {},
  dark: {
    "bg": "#1a1a2e", "text": "#e0e0e0", "muted": "#8a8a9a",
    "field": "#7fb3e0", "field-text": "#16213e",
    "pad": "#2a2a3e", "pad-stroke": "#555568",
    "border": "#444444", "accent": "#e0b97f",
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
    paddingCallout: true,  // "N of M bytes are padding" line
    title: null,           // null = struct title or "struct NAME"
    showBitWidths: true,   // ":12" suffix on bitfield labels
    theme: {},
    transparent: false,    // skip background rect
    responsive: false,     // fluid width (100% up to natural size)
    cornerRadius: 4,
    margin: 24,
  };
}

// ---------------------------------------------------------------- segments

function paddingBytes(sl) {
  return sl.fields.reduce((n, f) => n + (f.is_padding ? f.size : 0), 0);
}

function segmentsFromLayout(sl, opts) {
  const segs = [];
  for (const f of sl.fields) {
    if (f.bit_offset !== undefined && f.bit_offset !== null) {
      let label = f.name;
      if (opts.showBitWidths && f.bit_width) label = `${f.name}:${f.bit_width}`;
      segs.push({ label, startBits: f.bit_offset, widthBits: f.bit_width || 0,
                  isBitfield: true });
    } else if (f.size === 0 && !f.is_padding) {
      // flexible array member: nominal 1-byte box dangling past the end
      segs.push({ label: f.name + "[]", startBits: f.offset * 8, widthBits: 8,
                  isFlex: true });
    } else {
      const name = (f.is_pointer && !f.name.startsWith("*")) ? "*" + f.name : f.name;
      segs.push({ label: f.is_padding ? "pad" : name,
                  startBits: f.offset * 8, widthBits: f.size * 8,
                  isPadding: !!f.is_padding });
    }
  }
  // hand-annotated companion allocations
  let cursor = Math.max(sl.size * 8, ...segs.map((g) => g.startBits + g.widthBits));
  for (const extra of sl.extras || []) {
    const kind = extra.kind || "embedded";
    const widthBits = Math.trunc(extra.bytes) * 8;
    if (kind === "separate") cursor += SEP_GAP_BITS;
    segs.push({ label: extra.label, startBits: cursor, widthBits,
                isExtra: true, extraKind: kind });
    cursor += widthBits;
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
      inline.push([seg, textW("pad", opts.fontSize) + 8 <= w ? "pad" : ""]);
      continue;
    }
    if (textW(seg.label, opts.fontSize) + 8 <= w) {
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

function styleBlock(theme) {
  const t = { ...DEFAULT_THEME, ...theme };
  return `<style>
  .fd-bg      { fill: var(--fd-bg, ${t["bg"]}); }
  .fd-title   { fill: var(--fd-text, ${t["text"]}); }
  .fd-field   { fill: var(--fd-field, ${t["field"]}); stroke: var(--fd-border, ${t["border"]}); stroke-width: 1; }
  .fd-pad     { fill: url(#fd-hatch); stroke: var(--fd-pad-stroke, ${t["pad-stroke"]}); stroke-width: 1; }
  .fd-flex    { fill: none; stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; stroke-dasharray: 4 3; }
  .fd-extra   { fill: var(--fd-field, ${t["field"]}); fill-opacity: 0.55; stroke: var(--fd-border, ${t["border"]}); stroke-width: 1; stroke-dasharray: 5 3; }
  .fd-plus    { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-label   { fill: var(--fd-field-text, ${t["field-text"]}); }
  .fd-padlbl  { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-callout { fill: var(--fd-text, ${t["text"]}); }
  .fd-leader  { stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; fill: none; }
  .fd-ruler   { stroke: var(--fd-muted, ${t["muted"]}); stroke-width: 1; }
  .fd-rlbl    { fill: var(--fd-muted, ${t["muted"]}); }
  .fd-accent  { fill: var(--fd-accent, ${t["accent"]}); }
  text        { font-family: var(--fd-font, ${t["font"]}); }
  .fd-hatchbg { fill: var(--fd-pad, ${t["pad"]}); }
  .fd-hatchln { stroke: var(--fd-pad-stroke, ${t["pad-stroke"]}); stroke-width: 1.5; }
</style>`;
}

const HATCH = '<defs><pattern id="fd-hatch" width="6" height="6" ' +
  'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
  '<rect class="fd-hatchbg" width="6" height="6"/>' +
  '<line class="fd-hatchln" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>';

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

  // bar segments
  for (const seg of segs) {
    const x = x0 + seg.startBits / 8 * ppb;
    const w = seg.widthBits / 8 * ppb;
    let cls;
    if (seg.isPadding) cls = "fd-pad";
    else if (seg.isFlex) cls = "fd-flex";
    else if (seg.isExtra) {
      cls = "fd-extra";
      if (seg.extraKind === "separate") {
        const gapPx = SEP_GAP_BITS / 8 * ppb;
        parts.push(textEl(x - gapPx / 2, barTop + opts.barHeight / 2 + 5,
                          "+", 17, "fd-plus", "middle", "700"));
      }
    } else cls = "fd-field";
    parts.push(`<rect class="${cls}" x="${f1(x)}" y="${f1(barTop)}" ` +
      `width="${f1(w)}" height="${opts.barHeight}" rx="${opts.cornerRadius}"/>`);
  }
  for (const [seg, txt] of inline) {
    if (!txt) continue;
    const x = x0 + (seg.startBits + seg.widthBits / 2) / 8 * ppb;
    const cls = seg.isPadding ? "fd-padlbl" : (seg.isExtra ? "fd-callout" : "fd-label");
    parts.push(textEl(x, barTop + opts.barHeight / 2 + 5, txt,
                      opts.fontSize, cls, "middle", "700"));
  }

  // callouts + leaders
  for (const c of callouts) {
    parts.push(textEl(c.labelX, calloutY, c.seg.label, opts.calloutFontSize, "fd-callout"));
    const top = calloutY + 4;
    if (c.elbowY > 0) {
      parts.push(`<path class="fd-leader" d="M ${f1(c.labelX)} ${f1(top)} ` +
        `V ${f1(c.elbowY)} H ${f1(c.targetX)} V ${f1(barTop - 1)}"/>`);
    } else {
      parts.push(`<line class="fd-leader" x1="${f1(c.labelX)}" y1="${f1(top)}" ` +
        `x2="${f1(c.labelX)}" y2="${f1(barTop - 1)}"/>`);
    }
  }

  cy = barTop + opts.barHeight;

  // byte ruler
  if (opts.ruler) {
    const ry = cy + 8;
    parts.push(`<line class="fd-ruler" x1="${x0}" y1="${ry}" x2="${f1(x0 + totalPx)}" y2="${ry}"/>`);
    for (let b = 0; b <= sl.size; b += opts.rulerStep) {
      const x = x0 + b * ppb;
      parts.push(`<line class="fd-ruler" x1="${f1(x)}" y1="${ry}" x2="${f1(x)}" y2="${ry + 6}"/>`);
      parts.push(textEl(x, ry + 20, String(b), 11, "fd-rlbl"));
    }
    if (sl.size % opts.rulerStep !== 0) {
      const x = x0 + sl.size * ppb;
      parts.push(`<line class="fd-ruler" x1="${f1(x)}" y1="${ry}" x2="${f1(x)}" y2="${ry + 6}"/>`);
      parts.push(textEl(x, ry + 20, String(sl.size), 11, "fd-rlbl"));
    }
    cy = ry + 26;
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
                      13, "fd-accent", "start", "700"));
  }

  // hand-annotated note
  if (sl.note) {
    cy += 18;
    parts.push(textEl(x0, cy, `\u25bc ${sl.note}`, 13, "fd-accent", "start", "700"));
  }

  // canvas must fit callout labels and title, not just the bar
  let contentRight = x0 + totalPx;
  for (const c of callouts) contentRight = Math.max(contentRight, c.labelX + c.width / 2);
  if (title) contentRight = Math.max(contentRight, x0 + textW(title, 15));
  const width = Math.trunc(contentRight + m);
  const height = Math.trunc(cy + m / 2);
  const bg = opts.transparent ? "" : '<rect class="fd-bg" width="100%" height="100%" rx="8"/>\n';
  const dims = opts.responsive
    ? `style="width:100%;max-width:${width}px;height:auto"`
    : `width="${width}" height="${height}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `${dims}>\n${styleBlock(opts.theme)}\n${bg}${HATCH}\n` + parts.join("\n") + "\n</svg>";
}
