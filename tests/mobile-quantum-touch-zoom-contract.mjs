import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] || "local/chunk-network-entanglement-preview.html");
const html = readFileSync(target, "utf8");

const required = [
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

for (const contract of required) {
  assert.ok(html.includes(contract), `missing mobile quantum interaction contract: ${contract}`);
}

const forbidden = [
  'renderer.domElement.addEventListener("click", () => {\n      if (!hovered) return;',
  "controls.maxDistance = Math.max(170, displayRadiusBounds.max * 2.5);"
];

for (const regression of forbidden) {
  assert.ok(!html.includes(regression), `mobile quantum regression still present: ${regression}`);
}

console.log(`Mobile quantum touch/zoom contract PASS: ${target}`);
