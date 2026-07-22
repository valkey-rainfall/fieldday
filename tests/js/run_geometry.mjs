#!/usr/bin/env node
/* Geometry invariant tests for the JS renderer — mirrors tests/test_render.py.
 * Run: node tests/js/run_geometry.mjs */

import { computeLayouts } from "../../docs/layout.js";
import { renderStruct } from "../../docs/render.js";

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function render(snippet, opts = {}) {
  return renderStruct(computeLayouts(snippet)[0], opts);
}

function rects(svg) {
  const out = [];
  const re = /<rect class="(fd-field|fd-pad)" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)"/g;
  for (const m of svg.matchAll(re)) out.push([parseFloat(m[2]), parseFloat(m[4])]);
  return out;
}

function leaderSegments(svg) {
  const segs = [];
  const pre = /<path class="fd-leader" d="M (-?[\d.]+) (-?[\d.]+) V (-?[\d.]+) H (-?[\d.]+) V (-?[\d.]+)"/g;
  for (const m of svg.matchAll(pre)) {
    const [x1, y1, ey, tx, by] = m.slice(1).map(parseFloat);
    segs.push([[x1, y1, x1, ey], [x1, ey, tx, ey], [tx, ey, tx, by]]);
  }
  const lre = /<line class="fd-leader" x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g;
  for (const m of svg.matchAll(lre)) {
    const [x1, y1, x2, y2] = m.slice(1).map(parseFloat);
    segs.push([[x1, y1, x2, y2]]);
  }
  return segs;
}

function calloutLabels(svg) {
  const out = [];
  const re = /<text class="fd-callout" x="(-?[\d.]+)" y="(-?[\d.]+)" font-size="(\d+)"[^>]*>([^<]+)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    const x = parseFloat(m[1]), size = parseInt(m[3], 10), text = m[4];
    const w = text.length * size * 0.62;
    out.push([x - w / 2, x + w / 2, text]);
  }
  return out;
}

function segsIntersect(a, b, eps = 0.01) {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const aVert = Math.abs(ax1 - ax2) < eps, bVert = Math.abs(bx1 - bx2) < eps;
  if (aVert === bVert) {
    let lo1, hi1, lo2, hi2;
    if (aVert) {
      if (Math.abs(ax1 - bx1) > eps) return false;
      [lo1, hi1] = [Math.min(ay1, ay2), Math.max(ay1, ay2)];
      [lo2, hi2] = [Math.min(by1, by2), Math.max(by1, by2)];
    } else {
      if (Math.abs(ay1 - by1) > eps) return false;
      [lo1, hi1] = [Math.min(ax1, ax2), Math.max(ax1, ax2)];
      [lo2, hi2] = [Math.min(bx1, bx2), Math.max(bx1, bx2)];
    }
    return hi1 - eps > lo2 && hi2 - eps > lo1;
  }
  let v = a, h = b;
  if (bVert) { v = b; h = a; }
  const [vx, vy1, , vy2] = v;
  const [hx1, hy, hx2] = [h[0], h[1], h[2]];
  const [lo, hi] = [Math.min(vy1, vy2), Math.max(vy1, vy2)];
  const [xlo, xhi] = [Math.min(hx1, hx2), Math.max(hx1, hx2)];
  return xlo + eps < vx && vx < xhi - eps && lo + eps < hy && hy < hi - eps;
}

const NASTY = {
  adjacent_bytes: `struct s { uint64_t a; uint8_t resp; uint8_t argc; uint8_t vers;
                   uint8_t mode; void *p; };`,
  clustered_right: `struct s { uint64_t a; uint64_t b; uint64_t c;
                    uint8_t x; uint8_t y; uint8_t z; uint8_t w; };`,
  clustered_left: `struct s { uint8_t x; uint8_t y; uint8_t z; uint8_t w;
                   uint64_t a; uint64_t b; uint64_t c; };`,
  bitfield_swarm: `struct s { unsigned alpha : 3; unsigned beta : 2; unsigned gamma : 5;
                   unsigned delta : 6; uint64_t tail; };`,
  two_runs: `struct s { uint8_t aa; uint8_t bb; uint64_t mid;
             uint16_t cc; uint16_t dd; uint64_t end_; };`,
};

// bar tiling
check("segments_tile_bar", () => {
  const svg = render("struct s { char c; long l; short h; };",
                     { pxPerByte: 10, margin: 20 });
  const boxes = rects(svg).sort((a, b) => a[0] - b[0]);
  let cursor = boxes[0][0];
  for (const [x, w] of boxes) {
    assert(Math.abs(x - cursor) < 0.05, `gap/overlap at x=${x}`);
    cursor = x + w;
  }
  assert(Math.abs(cursor - boxes[0][0] - 24 * 10) < 0.05, "bar width != struct size");
});

for (const [name, snip] of Object.entries(NASTY)) {
  check(`labels_no_overlap[${name}]`, () => {
    const spans = calloutLabels(render(snip)).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      assert(spans[i - 1][1] <= spans[i][0] + 0.05,
             `'${spans[i - 1][2]}' overlaps '${spans[i][2]}'`);
    }
  });
  check(`labels_on_canvas[${name}]`, () => {
    for (const [left, , text] of calloutLabels(render(snip))) {
      assert(left >= 0, `label '${text}' off-canvas (x=${left})`);
    }
  });
  check(`leaders_no_cross[${name}]`, () => {
    const leaders = leaderSegments(render(snip));
    for (let i = 0; i < leaders.length; i++) {
      for (let j = i + 1; j < leaders.length; j++) {
        for (const sa of leaders[i]) for (const sb of leaders[j]) {
          assert(!segsIntersect(sa, sb), `leader ${i} crosses leader ${j}`);
        }
      }
    }
  });
  check(`nonvacuous[${name}]`, () => {
    assert(calloutLabels(render(snip)).length >= 2, "expected callouts, got <2");
  });
}

// options and annotations
check("transparent_skips_bg", () => {
  assert(!render("struct s { long a; };", { transparent: true }).includes('class="fd-bg"'), "bg present");
});
check("theme_override_baked", () => {
  assert(render("struct s { long a; };", { theme: { field: "#123456" } }).includes("#123456"), "theme color missing");
});
check("css_variables_present", () => {
  assert(render("struct s { long a; };").includes("var(--fd-field,"), "css vars missing");
});
check("padding_callout_opt_in", () => {
  assert(!render("struct s { char c; long l; };").includes("bytes are padding"), "callout not opt-in");
  assert(render("struct s { char c; long l; };", { paddingCallout: true })
    .includes("bytes are padding"), "opt-in callout missing");
});
check("cache_line_ticks", () => {
  const svg = render("struct s { char big[130]; };", { pxPerByte: 4 });
  const n = (svg.split("</style>")[1].match(/class="fd-cline"/g) || []).length;
  assert(n === 2, `expected 2 cache-line ticks, got ${n}`);
});
check("embedded_after_separate_joins_that_allocation", () => {
  const sl = computeLayouts("struct s { long a; };")[0];
  sl.extras = [
    { label: "e1", bytes: 5, kind: "embedded" },
    { label: "s1", bytes: 5, kind: "separate" },
    { label: "e2", bytes: 7, kind: "embedded" },
  ];
  const svg = renderStruct(sl);
  const labels = [...svg.matchAll(/class="fd-rlbl"[^>]*>(\d+)</g)].map((m) => parseInt(m[1], 10));
  assert(Math.max(...labels) === 13, `expected max 13, got ${Math.max(...labels)}`);
  assert(labels.includes(12), "separate allocation should end at 12");
  assert(labels.filter((x) => x === 0).length === 2, "expected two 0-origin rulers");
});
check("responsive_dims", () => {
  const svg = render("struct s { long a; };", { responsive: true });
  assert(svg.includes("width:100%;max-width:"), "responsive style missing");
});
check("extras_and_note", () => {
  const sl = computeLayouts("struct s { long a; };")[0];
  sl.extras = [{ label: "elem (16B)", bytes: 16, kind: "embedded" },
               { label: "sds", bytes: 16, kind: "separate" }];
  sl.note = "51 bytes total";
  sl.title = "Hand title";
  const svg = renderStruct(sl);
  assert(svg.includes('class="fd-extra"'), "extra missing");
  assert(svg.includes('class="fd-plus"'), "+ missing");
  assert(svg.includes("51 bytes total"), "note missing");
  assert(svg.includes("Hand title"), "title missing");
});
check("ruler_continues_over_embedded", () => {
  const sl = computeLayouts("struct s { long a; };")[0];
  sl.extras = [{ label: "e", bytes: 16, kind: "embedded" }];
  const svg = renderStruct(sl);
  const labels = [...svg.matchAll(/class="fd-rlbl"[^>]*>(\d+)</g)].map((m) => parseInt(m[1], 10));
  assert(Math.max(...labels) === 24, `expected 24, got ${Math.max(...labels)}`);
});
check("separate_extra_own_ruler", () => {
  const sl = computeLayouts("struct s { long a; };")[0];
  sl.extras = [{ label: "s", bytes: 16, kind: "separate" }];
  const svg = renderStruct(sl);
  const labels = [...svg.matchAll(/class="fd-rlbl"[^>]*>(\d+)</g)].map((m) => parseInt(m[1], 10));
  assert(Math.max(...labels) === 16, `expected 16, got ${Math.max(...labels)}`);
  assert(labels.filter((x) => x === 0).length === 2, "expected two 0-origin rulers");
});
check("array_dividers_drawn", () => {
  const svg = renderStruct(computeLayouts("struct s { int x[5]; int tail; };")[0]);
  const n = (svg.match(/class="fd-subdiv"/g) || []).length;
  assert(n === 4, `expected 4 subdividers, got ${n}`);
});
check("extra_css_appended", () => {
  const svg = renderStruct(computeLayouts("struct s { long a; };")[0],
                           { extraCss: ".fd-field { fill: pink; }" });
  assert(svg.includes(".fd-field { fill: pink; }"), "custom css missing");
});


check("relabel_and_hide", () => {
  const sl = computeLayouts("struct s { long a; long b; unsigned f : 4; };")[0];
  sl.relabel = { a: "cool label", b: "", f: "flags!" };
  const svg = renderStruct(sl);
  assert(svg.includes("cool label") && svg.includes("flags!"), "custom labels missing");
  assert(!svg.includes(">b<") && !svg.includes(">f:4<"), "hidden/original labels leaked");
});

check("bitfield_unit_padding_tiled", () => {
  // sub-byte gap after the last bitfield in a unit must be hatched, not blank
  const svg = renderStruct(computeLayouts(
    "struct s { uint64_t a; unsigned f : 12; unsigned p : 1; void *q; };")[0],
    { pxPerByte: 16, margin: 20 });
  const boxes = [];
  const re = /<rect class="(?:fd-field|fd-pad)" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)"/g;
  for (const m of svg.matchAll(re)) boxes.push([parseFloat(m[1]), parseFloat(m[3])]);
  boxes.sort((a, b) => a[0] - b[0]);
  let cursor = boxes[0][0];
  for (const [x, w] of boxes) {
    assert(Math.abs(x - cursor) < 0.11, `blank gap at x=${x} (cursor ${cursor})`);
    cursor = x + w;
  }
  assert(Math.abs(cursor - boxes[0][0] - 24 * 16) < 0.11, "bar does not span struct");
});

console.log(`geometry: ${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
