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
  const d = JSON.parse(readFileSync('examples/blog91/' + f + '.json', 'utf8'));
  writeFileSync('$TMP/js_' + f + '.svg', renderStruct(d.structs[0], { pxPerByte: 10 }));
}
const pair594 = JSON.parse(readFileSync('examples/blog594/embstr_pair.json', 'utf8'));
pair594.structs.forEach((s, i) => writeFileSync('$TMP/js_e594_' + i + '.svg', renderStruct(s, { pxPerByte: 14 })));
const pair = JSON.parse(readFileSync('examples/blog91/zslnode_pair.json', 'utf8'));
pair.structs.forEach((s, i) => writeFileSync('$TMP/js_zsl' + i + '.svg', renderStruct(s, { pxPerByte: 10 })));
"

"$PY" - <<EOF
import sys
sys.path.insert(0, "src")
from fieldday.cli import layouts_from_json
from fieldday.render import RenderOptions, render_struct
for f in ("robj_90", "robj_91"):
    sl = layouts_from_json(open(f"examples/blog91/{f}.json").read())[0]
    open(f"$TMP/py_{f}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=10)))
for i, sl in enumerate(layouts_from_json(open("examples/blog91/zslnode_pair.json").read())):
    open(f"$TMP/py_zsl{i}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=10)))
for i, sl in enumerate(layouts_from_json(open("examples/blog594/embstr_pair.json").read())):
    open(f"$TMP/py_e594_{i}.svg", "w").write(render_struct(sl, RenderOptions(px_per_byte=14)))
EOF

fail=0
for p in robj_90 robj_91 zsl0 zsl1 e594_0 e594_1; do
  if cmp -s "$TMP/py_$p.svg" "$TMP/js_$p.svg"; then
    echo "parity $p: identical"
  else
    echo "parity $p: DIFFERS"
    diff "$TMP/py_$p.svg" "$TMP/js_$p.svg" | head -8
    fail=1
  fi
done
exit $fail
