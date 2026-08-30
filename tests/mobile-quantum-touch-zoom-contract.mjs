import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const target = resolve(process.argv[2] || "local/chunk-network-entanglement-preview.html");
const isBuilt = process.argv.includes("--built");

function readTree(path) {
  if (!statSync(path).isDirectory()) return readFileSync(path, "utf8");
  const chunks = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) chunks.push(readTree(child));
    else if ([".html", ".js", ".mjs", ".css"].includes(extname(child))) chunks.push(readFileSync(child, "utf8"));
  }
  return chunks.join("\n");
}

const text = readTree(target);

const sourceRequired = [
  "mobile-quantum-touch-zoom-20260830",
  "const isCompactViewport = matchMedia(\"(max-width:700px)\").matches;",
  "isCompactViewport ? 150 : 92",
  "isCompactViewport ? 480 : 220",
  "isCompactViewport ? 5.2 : 3.1",
  "const coarsePointer = matchMedia(\"(pointer: coarse)\").matches;",
  "function hitFromScreenProximity(event)",
  "const radius = coarsePointer || event.pointerType === \"touch\" ? 28 : 10;",
  "function hitAtEvent(event)",
  "renderer.domElement.addEventListener(\"pointerdown\", event =>",
  "renderer.domElement.addEventListener(\"pointerup\", event =>",
  "const movementLimit = down.pointerType === \"touch\" ? 14 : 6;",
  "activateSelection(hitAtEvent(event));"
];

const builtRequired = [
  "(max-width:700px)",
  "(pointer: coarse)",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "pointerType",
  "touch"
];

for (const contract of (isBuilt ? builtRequired : sourceRequired)) {
  assert.ok(text.includes(contract), `missing mobile quantum ${isBuilt ? "bundle" : "source"} contract: ${contract}`);
}

const forbidden = [
  'renderer.domElement.addEventListener("click", () => {\n      if (!hovered) return;',
  "controls.maxDistance = Math.max(170, displayRadiusBounds.max * 2.5);"
];

for (const regression of forbidden) {
  assert.ok(!text.includes(regression), `mobile quantum regression still present: ${regression}`);
}

console.log(`Mobile quantum touch/zoom ${isBuilt ? "bundle" : "source"} contract PASS: ${target}`);
