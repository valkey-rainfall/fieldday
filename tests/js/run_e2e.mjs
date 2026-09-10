#!/usr/bin/env node
/* End-to-end check in a real headless browser.
 *
 * Serves docs/ locally, loads the app in Chromium, and asserts:
 *   1. the page boots with zero console errors,
 *   2. the default example renders SVG previews into #preview,
 *   3. the in-browser engine (layout.js + render.js, executed by the
 *      browser) produces SVG byte-identical to a reference file generated
 *      by the Python CLI for the same snippet + options.
 *
 * Usage: node tests/js/run_e2e.mjs <playwright-core-dir> <chromium-exe> <py-ref-svg>
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const [pwDir, chromiumExe, pyRefPath] = process.argv.slice(2);
if (!pwDir || !chromiumExe || !pyRefPath) {
  console.error("usage: run_e2e.mjs <playwright-core-dir> <chromium-exe> <py-ref-svg>");
  process.exit(2);
}
const { chromium } = await import(join(pwDir, "index.mjs"));

const DOCS = resolve("docs");
const MIME = { ".html": "text/html", ".js": "text/javascript",
               ".css": "text/css", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = join(DOCS, path);
  if (!file.startsWith(DOCS) || !existsSync(file)) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

const SNIPPET = readFileSync("/tmp/e2e_client.c", "utf8");
const pyRef = readFileSync(pyRefPath, "utf8");

let failures = [];
const browser = await chromium.launch({ executablePath: chromiumExe });
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForSelector("#preview svg", { timeout: 10000 });

  // 1. no console errors on boot
  if (consoleErrors.length) failures.push("console errors: " + consoleErrors.join(" | "));

  // 2. default example rendered
  const svgCount = await page.$$eval("#preview svg", (els) => els.length);
  if (svgCount < 1) failures.push("no svg in #preview");

  // 3. in-browser engine output == Python CLI reference (byte-identical)
  const browserSvg = await page.evaluate(async (snippet) => {
    const { computeLayouts } = await import("./layout.js");
    const { renderStruct } = await import("./render.js");
    return renderStruct(computeLayouts(snippet)[0], {});
  }, SNIPPET);
  if (browserSvg !== pyRef) {
    const g = browserSvg.split("\n"), w = pyRef.split("\n");
    let k = 0;
    while (k < Math.min(g.length, w.length) && g[k] === w[k]) k++;
    failures.push(`browser svg != python ref at line ${k + 1}:\n  py: ${w[k]}\n  js: ${g[k]}`);
  }

  // 4. error panel behaves: unknown type shows actionable message
  await page.evaluate(() => window.fieldday.setSnippet("struct p { wat w; };"));
  await page.waitForFunction(
    () => !document.getElementById("error").hidden, null, { timeout: 5000 });
  const errText = await page.$eval("#error", (el) => el.textContent);
  if (!errText.includes("stub wat")) failures.push("error panel missing stub hint: " + errText);

  // 5. JSON mode: editing the layout JSON directly drives the render
  const jsonModeOk = await page.evaluate(() => {
    window.fieldday.setSnippet("struct p { long a; };");
    window.fieldday.setMode("json");
    window.fieldday.setJson(JSON.stringify({ structs: [{
      name: "handmade", size: 16, align: 8,
      title: "from the JSON pane",
      fields: [{ name: "x", offset: 0, size: 8 }, { name: "y", offset: 8, size: 8 }],
    }] }));
    const svg = document.getElementById("preview").innerHTML;
    return window.fieldday.getMode() === "json" && svg.includes("from the JSON pane");
  });
  if (!jsonModeOk) failures.push("JSON mode did not render hand-edited layout");

  // 6. roles textarea + bare checkbox drive the render (and bare greys the
  //    controls it overrides). Step 5 left the JSON pane dirty, so leaving
  //    JSON mode asks for confirmation -- accept it.
  page.on("dialog", (d) => d.accept());
  const rolesBareOk = await page.evaluate(async () => {
    window.fieldday.setMode("c");
    window.fieldday.setSnippet("struct p { char *ptr; long n; double d; };");
    const set = (id, v, ev) => {
      const el = document.getElementById(id);
      el[typeof v === "boolean" ? "checked" : "value"] = v;
      el.dispatchEvent(new Event(ev, { bubbles: true }));
    };
    const settle = () => new Promise((r) => setTimeout(r, 350));
    set("roles", "n | overhead\nd | data", "input");
    await settle();
    const preview = document.getElementById("preview");
    const roled = preview.innerHTML.includes('class="fd-role-pointer"') &&
      preview.innerHTML.includes('class="fd-role-overhead"') &&
      preview.innerHTML.includes('class="fd-role-data"') &&
      preview.innerHTML.includes("<text");
    set("bare", true, "change");
    await settle();
    const body = preview.innerHTML.split("</style>")[1] || "";
    const bare = !body.includes("<text") && !body.includes('class="fd-ruler-line"') &&
      body.includes('class="fd-role-overhead"') && document.getElementById("ruler").disabled;
    set("bare", false, "change");
    await settle();
    const restored = !document.getElementById("ruler").disabled &&
      preview.innerHTML.includes('class="fd-ruler-line"');
    set("roles", "n | wat", "input");
    await settle();
    const badRole = !document.getElementById("error").hidden &&
      document.getElementById("error").textContent.includes("bad role 'wat'");
    return { roled, bare, restored, badRole };
  });
  for (const [k, v] of Object.entries(rolesBareOk)) {
    if (!v) failures.push(`roles/bare UI check failed: ${k}`);
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log("e2e: 6 checks passed (boot, render, python parity, error panel, json mode, roles/bare controls)");
