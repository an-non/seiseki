import fs from "node:fs";

const file = process.argv[2] || "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

function replaceExact(oldText, newText, label) {
  if (html.includes(newText)) return;
  if (!html.includes(oldText)) throw new Error(`${label} marker not found`);
  html = html.replace(oldText, newText);
}

replaceExact(
`      font:9px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
`      font:8px/1.38 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
"desktop trace text size"
);

replaceExact(
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 5px; color:var(--cyan); }`,
`    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 4px; color:var(--cyan); font-size:8px; line-height:1.2; }`,
"desktop trace header size"
);

replaceExact(
`    .details h2 { margin:0 0 4px; color:var(--ink); font-size:12px; line-height:1.25; }
    .details p { margin:0; color:var(--sub); font-size:10px; line-height:1.45; }
    .details .generated { color:var(--ink); font-size:10.5px; line-height:1.45; }
    .details .result { margin-top:5px; color:var(--cyan); font:9px/1.4 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:68px 1fr; gap:3px 7px; margin:7px 0 0; font-size:9.5px; }`,
`    .details h2 { margin:0 0 3px; color:var(--ink); font-size:10px; line-height:1.2; }
    .details p { margin:0; color:var(--sub); font-size:8.5px; line-height:1.35; }
    .details .generated { color:var(--ink); font-size:9px; line-height:1.35; }
    .details .result { margin-top:4px; color:var(--cyan); font:7.5px/1.3 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:62px 1fr; gap:2px 6px; margin:6px 0 0; font-size:8px; }`,
"desktop details text size"
);

replaceExact(
`    .provenance { position:fixed; z-index:7; left:24px; top:136px; max-width:min(620px,calc(100vw - 36px)); padding:8px 11px; border:1px solid var(--rule); border-radius:9px; background:var(--panel); color:var(--sub); font-size:11px; line-height:1.45; backdrop-filter:blur(12px); }`,
`    .provenance { position:fixed; z-index:7; left:24px; top:136px; max-width:min(620px,calc(100vw - 36px)); padding:7px 10px; border:1px solid var(--rule); border-radius:9px; background:var(--panel); color:var(--sub); font-size:9px; line-height:1.35; backdrop-filter:blur(12px); }`,
"desktop provenance text size"
);

replaceExact(
`      font:11px/1.6 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
`      font:9px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;`,
"desktop status text size"
);

replaceExact(
`        font-size:7px; line-height:1.22; opacity:.74; pointer-events:none;
        -webkit-overflow-scrolling:touch;`,
`        font-size:6.5px; line-height:1.18; opacity:.74; pointer-events:none;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;`,
"mobile trace text size"
);

replaceExact(
`      .trace header { margin:0 0 2px; font-size:7px; line-height:1.1; }`,
`      .trace header { margin:0 0 1px; font-size:6.5px; line-height:1.05; }`,
"mobile trace header size"
);

replaceExact(
`      .details h2 { margin:0 0 2px; font-size:9.5px; line-height:1.15; }
      .details p, .details .generated { font-size:8px; line-height:1.2; }
      .details .result { margin-top:2px; font-size:7px; line-height:1.15; }`,
`      .details h2 { margin:0 0 1px; font-size:8px; line-height:1.1; }
      .details p, .details .generated { font-size:6.8px; line-height:1.15; }
      .details .result { margin-top:1px; font-size:6.2px; line-height:1.1; }`,
"mobile details text size"
);

replaceExact(
`        font-size:8px; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`,
`        font-size:7px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`,
"mobile provenance text size"
);

replaceExact(
`        if (traceEntries.length > 24) traceEntries.shift();`,
`        if (traceEntries.length > 48) traceEntries.shift();`,
"trace history retention"
);

replaceExact(
`    function appendTrace(item, action) {
      traceState.textContent = "";
      traceSequence += 1;
      traceGeneration += 1;
      traceQueue.length = 0;
      traceEntries.push(formatTrace(item, action, traceSequence));
      if (traceEntries.length > 48) traceEntries.shift();
      renderTraceHistory();
    }`,
`    function appendTrace(item, action) {
      traceState.textContent = "";
      traceSequence += 1;
      traceGeneration += 1;
      traceQueue.length = 0;
      traceTyping = false;
      traceQueue.push(formatTrace(item, action, traceSequence));
      void processTraceQueue(traceGeneration);
    }`,
"restore typewriter trace"
);

const markers = [
  'font:8px/1.38 ui-monospace',
  'font-size:6.5px; line-height:1.18;',
  'scrollbar-width:none;',
  '.trace::-webkit-scrollbar { display:none; }',
  'traceEntries.slice(-48)',
  'if (traceEntries.length > 48) traceEntries.shift();',
  'traceQueue.push(formatTrace(item, action, traceSequence));',
  'void processTraceQueue(traceGeneration);',
  'for (const character of entry)',
  'activeEntry += character;',
  'requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });',
  'font-size:8.5px; line-height:1.35;',
  'font-size:6.8px; line-height:1.15;'
];

const missing = markers.filter(marker => !html.includes(marker));
if (missing.length) throw new Error(`trace/typewriter verification failed: ${missing.join(" | ")}`);

fs.writeFileSync(file, html);
console.log(`typewriter trace + hidden scrollbars + smaller text applied: ${file}`);
