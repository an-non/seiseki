import fs from "node:fs";

const file = process.argv[2] || "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

function replaceExact(oldText, newText, label) {
  if (html.includes(newText)) return;
  if (!html.includes(oldText)) throw new Error(`${label} marker not found`);
  html = html.replace(oldText, newText);
}

replaceExact(
`      font-size:25px;`,
`      font-size:21px;`,
"desktop title size"
);
replaceExact(
`    .legend { display:flex; flex-wrap:wrap; gap:11px; margin-top:8px; color:var(--sub); font-size:11px; }`,
`    .legend { display:flex; flex-wrap:wrap; gap:9px; margin-top:6px; color:var(--sub); font-size:9px; }`,
"desktop legend size"
);
replaceExact(
`      cursor:pointer;`,
`      cursor:pointer;
      font-size:12px;`,
"desktop control text size"
);
replaceExact(
`    .provenance { position:fixed; z-index:7; left:24px; top:136px; max-width:min(620px,calc(100vw - 36px)); padding:7px 10px; border:1px solid var(--rule); border-radius:9px; background:var(--panel); color:var(--sub); font-size:9px; line-height:1.35; backdrop-filter:blur(12px); }`,
`    .provenance { position:fixed; z-index:7; left:24px; top:136px; max-width:min(560px,calc(100vw - 36px)); padding:6px 9px; border:1px solid var(--rule); border-radius:8px; background:var(--panel); color:var(--sub); font-size:8px; line-height:1.28; backdrop-filter:blur(12px); }`,
"desktop provenance density"
);
replaceExact(
`      font:9px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
`      font:8px/1.35 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
"desktop status density"
);
replaceExact(
`      width:min(300px,calc(100% - 32px));
      min-height:0;
      max-height:min(176px,calc(100vh - 190px));
      overflow:auto;
      padding:9px 11px;`,
`      width:min(240px,calc(100% - 28px));
      min-height:0;
      max-height:min(132px,calc(100vh - 190px));
      overflow:auto;
      padding:6px 8px;`,
"desktop details footprint"
);
replaceExact(
`    .details h2 { margin:0 0 3px; color:var(--ink); font-size:10px; line-height:1.2; }
    .details p { margin:0; color:var(--sub); font-size:8.5px; line-height:1.35; }
    .details .generated { color:var(--ink); font-size:9px; line-height:1.35; }
    .details .result { margin-top:4px; color:var(--cyan); font:7.5px/1.3 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:62px 1fr; gap:2px 6px; margin:6px 0 0; font-size:8px; }`,
`    .details h2 { margin:0 0 2px; color:var(--ink); font-size:9px; line-height:1.15; }
    .details p { margin:0; color:var(--sub); font-size:7.5px; line-height:1.25; }
    .details .generated { color:var(--ink); font-size:8px; line-height:1.25; }
    .details .result { margin-top:3px; color:var(--cyan); font:6.8px/1.2 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:56px 1fr; gap:2px 5px; margin:5px 0 0; font-size:7px; }`,
"desktop details text density"
);
replaceExact(
`      width:min(340px,calc(100% - 340px));
      max-width:340px;
      height:min(46vh,410px);
      max-height:calc(100vh - 210px);`,
`      width:min(280px,calc(100% - 300px));
      max-width:280px;
      height:min(34vh,280px);
      max-height:calc(100vh - 210px);`,
"desktop trace footprint"
);
replaceExact(
`      font:8px/1.38 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
`      font:7px/1.3 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
"desktop trace text density"
);
replaceExact(
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 4px; color:var(--cyan); font-size:8px; line-height:1.2; }`,
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 3px; color:var(--cyan); font-size:7px; line-height:1.15; }`,
"desktop trace header density"
);
replaceExact(
`      h1 { font-size:15px; line-height:1.2; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`,
`      h1 { font-size:13px; line-height:1.15; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`,
"mobile title density"
);
replaceExact(
`      .legend { max-width:calc(100vw - 16px); gap:4px 8px; margin-top:3px; font-size:8.5px; line-height:1.15; }`,
`      .legend { max-width:calc(100vw - 16px); gap:3px 6px; margin-top:2px; font-size:7.2px; line-height:1.1; }`,
"mobile legend density"
);
replaceExact(
`        font-size:10px; line-height:1; white-space:nowrap; border-radius:5px;`,
`        font-size:9px; line-height:1; white-space:nowrap; border-radius:5px;`,
"mobile control text density"
);
replaceExact(
`        font-size:7px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`,
`        font-size:6.5px; line-height:1.05; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`,
"mobile provenance density"
);
replaceExact(
`        display:block; left:2px; right:auto; bottom:92px;
        width:min(54vw,220px); height:min(24vh,168px); max-height:min(24vh,168px);
        overflow-y:auto; overflow-x:hidden; padding:0 2px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:6.5px; line-height:1.18; opacity:.74; pointer-events:none;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;`,
`        display:block; left:2px; right:auto; bottom:60px;
        width:min(42vw,160px); height:min(15vh,96px); max-height:min(15vh,96px);
        overflow-y:auto; overflow-x:hidden; padding:0 1px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:5.5px; line-height:1.12; opacity:.72; pointer-events:none;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;`,
"mobile trace footprint"
);
replaceExact(
`      .trace header { margin:0 0 1px; font-size:6.5px; line-height:1.05; }`,
`      .trace header { margin:0 0 1px; font-size:5.5px; line-height:1; }`,
"mobile trace header density"
);
replaceExact(
`      .details {
        left:6px; right:6px; bottom:6px; width:calc(100% - 12px);
        min-height:0; max-height:76px; padding:5px 7px; overflow:auto;
        border-radius:8px; -webkit-overflow-scrolling:touch;
      }`,
`      .details {
        left:auto; right:4px; bottom:4px; width:min(58vw,220px);
        min-height:0; max-height:50px; padding:3px 5px; overflow:hidden;
        border-radius:6px; pointer-events:none;
      }`,
"mobile details footprint"
);
replaceExact(
`      .details h2 { margin:0 0 1px; font-size:8px; line-height:1.1; }
      .details p, .details .generated { font-size:6.8px; line-height:1.15; }
      .details .result { margin-top:1px; font-size:6.2px; line-height:1.1; }`,
`      .details h2 { margin:0 0 1px; font-size:7px; line-height:1.05; }
      .details p, .details .generated { font-size:5.8px; line-height:1.08; }
      .details .result { margin-top:1px; font-size:5.4px; line-height:1.05; }`,
"mobile details text density"
);
replaceExact(
`      .loading { max-width:calc(100vw - 24px); text-align:center; font-size:10px; }`,
`      .loading { max-width:calc(100vw - 24px); text-align:center; font-size:8.5px; }`,
"mobile loading text density"
);

const markers = [
  'font:7px/1.3 ui-monospace',
  'width:min(280px,calc(100% - 300px));',
  'width:min(240px,calc(100% - 28px));',
  'width:min(42vw,160px); height:min(15vh,96px);',
  'width:min(58vw,220px);',
  'font-size:5.5px; line-height:1.12;',
  'pointer-events:none;',
  'traceQueue.push(formatTrace(item, action, traceSequence));',
  'void processTraceQueue();',
  '.trace::-webkit-scrollbar { display:none; }'
];
const missing = markers.filter(marker => !html.includes(marker));
if (missing.length) throw new Error(`compact density verification failed: ${missing.join(" | ")}`);

fs.writeFileSync(file, html);
console.log(`compact web/mobile quantum overlays applied: ${file}`);
