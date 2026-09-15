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
  "width:min(280px,calc(100% - 300px));",
  "max-width:280px;",
  "height:min(34vh,280px);",
  "max-height:calc(100vh - 210px);",
  "font:7px/1.3 \"IBM Plex Mono\",Consolas,monospace;",
  ".trace header span:last-child { display:none; }",
  "h1 { font-size:13px; line-height:1.15; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  "width:min(42vw,160px); height:min(15vh,96px); max-height:min(15vh,96px);",
  "font-size:5.5px; line-height:1.12; opacity:.72; pointer-events:none;",
  "left:auto; right:4px; bottom:4px; width:min(58vw,220px);",
  "min-height:0; max-height:50px; padding:3px 5px; overflow:hidden;"
];

const forbidden = [
  "width:min(350px,calc(100% - 40px));",
  "width:min(470px,calc(100% - 410px));",
  "width:min(320px,calc(100% - 300px));",
  "height:min(56vh,540px);",
  "font:10px/1.55 \"IBM Plex Mono\",Consolas,monospace;",
  ".trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }"
];

for (const contract of required) {
  assert.ok(html.includes(contract), `missing compact quantum layout contract: ${contract}`);
}
for (const regression of forbidden) {
  assert.ok(!html.includes(regression), `regressed quantum layout contract found: ${regression}`);
}

console.log(`Phase 5.9 compact quantum build contract PASS: ${target}`);
// CI trigger after Git-data fast-forward; no runtime effect.
