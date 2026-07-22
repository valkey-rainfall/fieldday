#!/usr/bin/env node
/* Cross-validation runner: the JS layout engine must reproduce every
 * compiler-generated golden vector exactly. Run: node tests/js/run_vectors.mjs */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeLayouts, LayoutError } from "../../docs/layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "..", "vectors.json"), "utf8"));

let pass = 0, fail = 0;
const failures = [];

for (const vec of data.vectors) {
  let got;
  try {
    got = computeLayouts(vec.snippet);
  } catch (e) {
    fail++;
    failures.push(`${vec.name}: threw ${e instanceof LayoutError ? "LayoutError" : "Error"}: ${e.message}`);
    continue;
  }
  const want = vec.expected;
  const gotJson = JSON.stringify(got, null, 1);
  const wantJson = JSON.stringify(want, null, 1);
  if (gotJson === wantJson) {
    pass++;
  } else {
    fail++;
    // find first differing line for a compact report
    const g = gotJson.split("\n"), w = wantJson.split("\n");
    let k = 0;
    while (k < Math.min(g.length, w.length) && g[k] === w[k]) k++;
    failures.push(`${vec.name}: mismatch at line ${k + 1}\n  want: ${w[k] ?? "<end>"}\n  got:  ${g[k] ?? "<end>"}`);
  }
}

// error-path checks (not in vectors: they assert throwing behavior)
const ERROR_CASES = [
  ["unknown type", "struct p { wat w; };", /Unknown type 'wat'/],
  ["no structs", "int x;", /unsupported top-level|No struct/],
  ["undefined struct ref", "struct p { struct nope n; };", /unknown struct type/],
];
for (const [name, snippet, re] of ERROR_CASES) {
  try {
    computeLayouts(snippet);
    fail++;
    failures.push(`error-case '${name}': expected throw, got success`);
  } catch (e) {
    if (re.test(e.message)) pass++;
    else { fail++; failures.push(`error-case '${name}': wrong message: ${e.message}`); }
  }
}

console.log(`vectors: ${pass} passed, ${fail} failed (abi ${data.abi})`);
if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
