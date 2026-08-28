import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] || "local/dist/quantum/chunk-network-entanglement-preview.html");
const html = readFileSync(target, "utf8");

const required = [
  "width:min(260px,calc(100% - 40px));",
  "min-height:82px;",
  "max-height:min(180px,calc(100vh - 190px));",
  "padding:8px 10px;",
  "width:min(320px,calc(100% - 300px));",
  "height:min(31vh,280px);",
  "max-height:calc(100vh - 300px);",
  "font:8px/1.38 \"IBM Plex Mono\",Consolas,monospace;",
  ".trace header span:last-child { display:none; }",
  ".details { right:11px; bottom:11px; width:calc(100% - 22px); min-height:82px; max-height:106px; padding:8px 10px; }",
  ".trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }"
];

const forbidden = [
  "width:min(350px,calc(100% - 40px));",
  "width:min(470px,calc(100% - 410px));",
  "height:min(56vh,540px);",
  "font:10px/1.55 \"IBM Plex Mono\",Consolas,monospace;"
];

for (const contract of required) {
  assert.ok(html.includes(contract), `missing compact quantum layout contract: ${contract}`);
}
for (const regression of forbidden) {
  assert.ok(!html.includes(regression), `regressed quantum layout contract found: ${regression}`);
}

console.log(`Phase 5.9 compact quantum build contract PASS: ${target}`);
