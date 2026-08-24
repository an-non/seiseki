import fs from "node:fs";

const file = process.argv[2] || "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!html.includes(oldText)) throw new Error(`${label} marker not found`);
  html = html.replace(oldText, newText);
}

replaceOnce(
`    .details {
      position:fixed;
      z-index:8;
      right:20px;
      bottom:20px;
      width:min(350px,calc(100% - 40px));
      min-height:112px;
      max-height:min(260px,calc(100vh - 190px));
      overflow:auto;
      padding:14px 15px;
      border:1px solid var(--rule);
      border-radius:6px;
      background:var(--panel);
      box-shadow:var(--panel-shadow);
      backdrop-filter:blur(10px);
    }
    .details h2 { margin:0 0 7px; color:var(--ink); font-size:13px; }
    .details p { margin:0; color:var(--sub); font-size:11px; line-height:1.7; }
    .details .generated { color:var(--ink); font-size:12px; }
    .details .result { margin-top:8px; color:var(--cyan); font:10px/1.55 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:76px 1fr; gap:4px 8px; margin:10px 0 0; font-size:11px; }`,
`    .details {
      position:fixed;
      z-index:8;
      right:16px;
      bottom:16px;
      width:min(300px,calc(100% - 32px));
      min-height:0;
      max-height:min(176px,calc(100vh - 190px));
      overflow:auto;
      padding:9px 11px;
      border:1px solid var(--rule);
      border-radius:6px;
      background:var(--panel);
      box-shadow:var(--panel-shadow);
      backdrop-filter:blur(10px);
    }
    .details h2 { margin:0 0 4px; color:var(--ink); font-size:12px; line-height:1.25; }
    .details p { margin:0; color:var(--sub); font-size:10px; line-height:1.45; }
    .details .generated { color:var(--ink); font-size:10.5px; line-height:1.45; }
    .details .result { margin-top:5px; color:var(--cyan); font:9px/1.4 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
    .details dl { display:grid; grid-template-columns:68px 1fr; gap:3px 7px; margin:7px 0 0; font-size:9.5px; }`,
"desktop details compact"
);

replaceOnce(
`    .trace {
      position:fixed;
      z-index:7;
      left:20px;
      bottom:20px;
      width:min(470px,calc(100% - 410px));
      height:min(56vh,540px);
      max-height:calc(100vh - 210px);
      overflow:auto;
      scrollbar-width:none;
      padding:2px 0;
      border:0;
      background:transparent;
      box-shadow:none;
      color:var(--trace);
      font:10px/1.55 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
      text-shadow:none;
    }
    .trace header { position:static; display:flex; justify-content:space-between; margin:0 0 7px; color:var(--cyan); }
    .trace header span:last-child { color:var(--sub); }
    .trace pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }`,
`    .trace {
      position:fixed;
      z-index:7;
      left:16px;
      bottom:16px;
      width:min(340px,calc(100% - 340px));
      max-width:340px;
      height:min(46vh,410px);
      max-height:calc(100vh - 210px);
      overflow-y:auto;
      overflow-x:hidden;
      scrollbar-width:none;
      padding:2px 0;
      border:0;
      background:transparent;
      box-shadow:none;
      color:var(--trace);
      font:9px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
      text-shadow:none;
    }
    .trace header { position:static; display:flex; justify-content:flex-start; margin:0 0 5px; color:var(--cyan); }
    .trace header span:last-child { display:none; }
    .trace pre { margin:0; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }`,
"desktop trace compact"
);

replaceOnce(
`      .trace {
        display:block; left:1px; right:auto; bottom:96px;
        width:min(58vw,240px); height:min(13vh,105px); max-height:min(13vh,105px);
        overflow:hidden; padding:0 1px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:7px; line-height:1.2; opacity:.72; pointer-events:none;
      }
      .trace header { margin:0 0 1px; font-size:7px; line-height:1.1; }
      .trace header span:last-child { display:none; }
      .trace pre { max-height:calc(13vh - 16px); overflow:hidden; }`,
`      .trace {
        display:block; left:2px; right:auto; bottom:92px;
        width:min(54vw,220px); height:min(24vh,168px); max-height:min(24vh,168px);
        overflow-y:auto; overflow-x:hidden; padding:0 2px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:7px; line-height:1.22; opacity:.74; pointer-events:none;
        -webkit-overflow-scrolling:touch;
      }
      .trace header { margin:0 0 2px; font-size:7px; line-height:1.1; }
      .trace header span:last-child { display:none; }
      .trace pre { max-height:none; overflow:visible; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }`,
"mobile trace scroll"
);

replaceOnce(
`      .details {
        left:6px; right:6px; bottom:6px; width:calc(100% - 12px);
        min-height:0; max-height:86px; padding:6px 8px; overflow:auto;
        border-radius:8px; -webkit-overflow-scrolling:touch;
      }
      .details h2 { margin:0 0 2px; font-size:10px; line-height:1.2; }
      .details p, .details .generated { font-size:8.5px; line-height:1.25; }
      .details .result { margin-top:2px; font-size:7.5px; line-height:1.2; }`,
`      .details {
        left:6px; right:6px; bottom:6px; width:calc(100% - 12px);
        min-height:0; max-height:76px; padding:5px 7px; overflow:auto;
        border-radius:8px; -webkit-overflow-scrolling:touch;
      }
      .details h2 { margin:0 0 2px; font-size:9.5px; line-height:1.15; }
      .details p, .details .generated { font-size:8px; line-height:1.2; }
      .details .result { margin-top:2px; font-size:7px; line-height:1.15; }`,
"mobile details compact"
);

replaceOnce(
`    function renderTraceHistory(activeEntry = "") {
      const completed = activeEntry ? traceEntries.slice(-23) : traceEntries.slice(-24);
      traceOutput.textContent = [...completed, activeEntry].filter(Boolean).join("\\n\\n");
      requestAnimationFrame(() => {
        const container = traceOutput.parentElement;
        container.scrollTop = container.scrollHeight;
      });
    }`,
`    function renderTraceHistory(activeEntry = "") {
      const completed = activeEntry ? traceEntries.slice(-47) : traceEntries.slice(-48);
      traceOutput.textContent = [...completed, activeEntry].filter(Boolean).join("\\n\\n");
      requestAnimationFrame(() => {
        const container = traceOutput.parentElement;
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
      });
    }`,
"trace history scrolling"
);

replaceOnce(
`    function appendTrace(item, action) {
      traceState.textContent = \`EPOCH \${epoch}\`;
      traceSequence += 1;
      traceGeneration += 1;
      traceQueue.length = 0;
      traceQueue.push(formatTrace(item, action, traceSequence));
      void processTraceQueue(traceGeneration);
    }`,
`    function appendTrace(item, action) {
      traceState.textContent = "";
      traceSequence += 1;
      traceGeneration += 1;
      traceQueue.length = 0;
      traceEntries.push(formatTrace(item, action, traceSequence));
      if (traceEntries.length > 48) traceEntries.shift();
      renderTraceHistory();
    }`,
"trace append accumulation"
);

for (const marker of [
  '.trace header span:last-child { display:none; }',
  'width:min(340px,calc(100% - 340px));',
  'width:min(54vw,220px); height:min(24vh,168px);',
  'max-height:76px;',
  'traceEntries.slice(-48)',
  'traceEntries.push(formatTrace(item, action, traceSequence));',
  'traceState.textContent = "";'
]) {
  if (!html.includes(marker)) throw new Error(`trace/layout verification failed: ${marker}`);
}

fs.writeFileSync(file, html);
console.log(`compact trace layout + accumulating auto-scroll restored: ${file}`);
