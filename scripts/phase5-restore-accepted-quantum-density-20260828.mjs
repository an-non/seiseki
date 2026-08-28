import assert from "node:assert/strict";
import fs from "node:fs";

const htmlPath = "local/chunk-network-entanglement-preview.html";
const contractPath = "tests/phase5-quantum-compact-contract.mjs";
let html = fs.readFileSync(htmlPath, "utf8");
let contract = fs.readFileSync(contractPath, "utf8");

function replaceExact(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`${label} marker not found`);
  return source.replace(oldText, newText);
}

html = replaceExact(
  html,
`      width:min(320px,calc(100% - 300px));
      height:min(31vh,280px);
      max-height:calc(100vh - 300px);
      overflow:auto;
      scrollbar-width:none;`,
`      width:min(280px,calc(100% - 300px));
      max-width:280px;
      height:min(34vh,280px);
      max-height:calc(100vh - 210px);
      overflow-y:auto;
      overflow-x:hidden;
      scrollbar-width:none;`,
  "desktop trace footprint"
);
html = replaceExact(
  html,
`      font:8px/1.38 "IBM Plex Mono",Consolas,monospace;`,
`      font:7px/1.3 "IBM Plex Mono",Consolas,monospace;`,
  "desktop trace density"
);
html = replaceExact(
  html,
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 4px; color:var(--cyan); font-size:8px; line-height:1.35; }`,
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 3px; color:var(--cyan); font-size:7px; line-height:1.15; }`,
  "desktop trace header density"
);
html = replaceExact(
  html,
`    .trace pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }`,
`    .trace pre { margin:0; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }`,
  "trace wrapping"
);

html = replaceExact(
  html,
`    @media (max-width:700px) {
      header { top:14px; left:15px; right:15px; }
      h1 { font-size:20px; }
      .legend { max-width:280px; gap:6px 10px; }
      .controls { top:82px; left:14px; max-width:calc(100% - 28px); overflow-x:auto; }
      .controls button { min-width:43px; padding:0 7px; }
      .status { top:auto; right:13px; bottom:148px; font-size:9px; line-height:1.45; }
      .status .optional { display:none; }
      .details { right:11px; bottom:11px; width:calc(100% - 22px); min-height:82px; max-height:106px; padding:8px 10px; }
      .trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }
    }`,
`    @media (max-width:700px) {
      html, body { font-size:16px; -webkit-text-size-adjust:100%; }
      #scene, #scene canvas { touch-action:none; }
      header { top:6px; left:8px; right:8px; }
      h1 { font-size:13px; line-height:1.15; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .legend { max-width:calc(100vw - 16px); gap:3px 6px; margin-top:2px; font-size:7.2px; line-height:1.1; }
      .legend .dot { width:6px; height:6px; }
      .legend .ring { width:8px; height:8px; }
      .controls {
        top:48px; left:4px; right:4px; width:calc(100% - 8px); max-width:none;
        display:flex; flex-wrap:nowrap; gap:1px; padding:2px;
        overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch;
        scrollbar-width:none; border-radius:6px;
      }
      .controls::-webkit-scrollbar { display:none; }
      .controls button {
        flex:0 0 auto; min-width:38px; height:28px; padding:0 5px;
        font-size:9px; line-height:1; white-space:nowrap; border-radius:5px;
      }
      .controls .observe { flex-basis:30px; min-width:30px; width:30px; font-size:16px; }
      .controls .divider { flex:0 0 1px; height:14px; margin:0 1px; }
      .status { display:none; }
      .trace {
        display:block; left:2px; right:auto; bottom:60px;
        width:min(42vw,160px); height:min(15vh,96px); max-height:min(15vh,96px);
        overflow-y:auto; overflow-x:hidden; padding:0 1px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:5.5px; line-height:1.12; opacity:.72; pointer-events:none;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;
      }
      .trace header { margin:0 0 1px; font-size:5.5px; line-height:1; }
      .trace header span:last-child { display:none; }
      .trace pre { max-height:none; overflow:visible; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
      .details {
        left:auto; right:4px; bottom:4px; width:min(58vw,220px);
        min-height:0; max-height:50px; padding:3px 5px; overflow:hidden;
        border-radius:6px; pointer-events:none;
      }
      .details h2 { margin:0 0 1px; font-size:7px; line-height:1.05; }
      .details p, .details .generated { font-size:5.8px; line-height:1.08; }
      .details .result { margin-top:1px; font-size:5.4px; line-height:1.05; }
      .details dl { display:none; }
      .loading { max-width:calc(100vw - 24px); text-align:center; font-size:8.5px; }
    }`,
  "accepted mobile quantum density"
);

const oldRequired = `const required = [
  "width:min(260px,calc(100% - 40px));",
  "min-height:82px;",
  "max-height:min(180px,calc(100vh - 190px));",
  "padding:8px 10px;",
  "width:min(320px,calc(100% - 300px));",
  "height:min(31vh,280px);",
  "max-height:calc(100vh - 300px);",
  "font:8px/1.38 \\\"IBM Plex Mono\\\",Consolas,monospace;",
  ".trace header span:last-child { display:none; }",
  ".details { right:11px; bottom:11px; width:calc(100% - 22px); min-height:82px; max-height:106px; padding:8px 10px; }",
  ".trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }"
];`;
const newRequired = `const required = [
  "width:min(260px,calc(100% - 40px));",
  "min-height:82px;",
  "max-height:min(180px,calc(100vh - 190px));",
  "padding:8px 10px;",
  "width:min(280px,calc(100% - 300px));",
  "max-width:280px;",
  "height:min(34vh,280px);",
  "max-height:calc(100vh - 210px);",
  "font:7px/1.3 \\\"IBM Plex Mono\\\",Consolas,monospace;",
  ".trace header span:last-child { display:none; }",
  "h1 { font-size:13px; line-height:1.15; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  "width:min(42vw,160px); height:min(15vh,96px); max-height:min(15vh,96px);",
  "font-size:5.5px; line-height:1.12; opacity:.72; pointer-events:none;",
  "left:auto; right:4px; bottom:4px; width:min(58vw,220px);",
  "min-height:0; max-height:50px; padding:3px 5px; overflow:hidden;"
];`;
contract = replaceExact(contract, oldRequired, newRequired, "compact contract required markers");

const oldForbidden = `const forbidden = [
  "width:min(350px,calc(100% - 40px));",
  "width:min(470px,calc(100% - 410px));",
  "height:min(56vh,540px);",
  "font:10px/1.55 \\\"IBM Plex Mono\\\",Consolas,monospace;"
];`;
const newForbidden = `const forbidden = [
  "width:min(350px,calc(100% - 40px));",
  "width:min(470px,calc(100% - 410px));",
  "width:min(320px,calc(100% - 300px));",
  "height:min(56vh,540px);",
  "font:10px/1.55 \\\"IBM Plex Mono\\\",Consolas,monospace;",
  ".trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }"
];`;
contract = replaceExact(contract, oldForbidden, newForbidden, "compact contract forbidden markers");

for (const marker of [
  'font-family:"Zen Kaku Gothic New"',
  'font-family:"Shippori Mincho"',
  'font:7px/1.3 "IBM Plex Mono",Consolas,monospace;',
  'const maxPersistentRelations = 1400;',
  'width:min(42vw,160px); height:min(15vh,96px);',
  'width:min(58vw,220px);'
]) assert.ok(html.includes(marker), `restored source marker missing: ${marker}`);

for (const regression of [
  'width:min(320px,calc(100% - 300px));',
  '.trace { left:11px; bottom:151px; width:calc(100% - 22px); height:min(38vh,300px); max-height:min(38vh,300px); padding:8px 10px; }'
]) assert.ok(!html.includes(regression), `old density marker remains: ${regression}`);

fs.writeFileSync(htmlPath, html);
fs.writeFileSync(contractPath, contract);
console.log("Accepted 2026-08-24 web trace/mobile quantum density restored without changing quantum logic.");
