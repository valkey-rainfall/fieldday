#!/usr/bin/env bash
# Renderer parity: Python and JS must emit byte-identical SVG for the same
# layout + options. Run from repo root: tests/js/run_parity.sh [python]
set -euo pipefail
cd "$(dirname "$0")/../.."
PY="${1:-.venv/bin/python}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

node --input-type=module -e "
import { renderStruct } from './docs/render.js';
import { readFileSync, writeFileSync } from 'node:fs';
for (const f of ['robj_90', 'robj_91']) {
  const d = JSON.parse(readFileSync('gallery/valkey-9.1-drafts/' + f + '.json', 'utf8'));
  writeFileSync('$TMP/js_' + f + '.svg', renderStruct(d.structs[0], { pxPerByte: 10 }));
}
const pair594 = JSON.parse(readFileSync('gallery/valkey-9.1-memory-blog/embstr_pair.json', 'utf8'));
pair594.structs.forEach((s, i) => writeFileSync('$TMP/js_e594_' + i + '.svg', renderStruct(s, { pxPerByte: 14 })));
const slackFix = JSON.parse(readFileSync('tests/fixtures/slack_demo.json', 'utf8'));
writeFileSync('$TMP/js_slack.svg', renderStruct(slackFix.structs[0], { pxPerByte: 12, jemallocSlack: true }));
const pair = JSON.parse(readFileSync('gallery/valkey-9.1-drafts/zslnode_pair.json', 'utf8'));
pair.structs.forEach((s, i) => writeFileSync('$TMP/js_zsl' + i + '.svg', renderStruct(s, { pxPerByte: 10 })));
// low px/byte: exercises auto ruler step + divider suppression
const fbt = JSON.parse(readFileSync('tests/fixtures/fbtree_nodes.json', 'utf8'));
writeFileSync('$TMP/js_fbt_leaf.svg', renderStruct(fbt.structs[0], { pxPerByte: 1.3 }));
writeFileSync('$TMP/js_fbt_inner.svg', renderStruct(fbt.structs[1], { pxPerByte: 0.33, cacheLine: 0 }));
"

"$PY" - <<EOF
import sys
sys.path.insert(0, "src")
from fieldday.cli import layouts_from_json
from fieldday.render import RenderOptions, render_struct
for f in ("robj_90", "robj_91"):
    sl = layouts_from_json(open(f"gallery/valkey-9.1-drafts/{f}.json").read())[0]
    open(f"$TMP/py_{f}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=10)))
for i, sl in enumerate(layouts_from_json(open("gallery/valkey-9.1-drafts/zslnode_pair.json").read())):
    open(f"$TMP/py_zsl{i}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=10)))
for i, sl in enumerate(layouts_from_json(open("gallery/valkey-9.1-memory-blog/embstr_pair.json").read())):
    open(f"$TMP/py_e594_{i}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=14)))
sl = layouts_from_json(open("tests/fixtures/slack_demo.json").read())[0]
open("$TMP/py_slack.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=12, jemalloc_slack=True)))
fbt = layouts_from_json(open("tests/fixtures/fbtree_nodes.json").read())
open("$TMP/py_fbt_leaf.svg", "w").write(render_struct(fbt[0], RenderOptions(px_per_byte=1.3)))
open("$TMP/py_fbt_inner.svg", "w").write(render_struct(fbt[1], RenderOptions(px_per_byte=0.33, cache_line=0)))
EOF

fail=0
for p in robj_90 robj_91 zsl0 zsl1 e594_0 e594_1 slack fbt_leaf fbt_inner; do
  if cmp -s "$TMP/py_$p.svg" "$TMP/js_$p.svg"; then
    echo "parity $p: identical"
  else
    echo "parity $p: DIFFERS"
    diff "$TMP/py_$p.svg" "$TMP/js_$p.svg" | head -8
    fail=1
  fi
done
exit $fail
