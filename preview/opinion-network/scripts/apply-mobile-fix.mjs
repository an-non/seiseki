import fs from "node:fs";

const file = "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

const mustContain = [
  'const count = Math.max(240, Math.min(5000',
  'generatePrototypeCandidates(topics, { uniqueCount:count, duplicateCount })',
  'const raycaster = new THREE.Raycaster();',
  'renderer.domElement.addEventListener("click"',
  'OBSERVATION TRACE'
];
for (const marker of mustContain) {
  if (!html.includes(marker)) throw new Error(`required marker missing: ${marker}`);
}

html = html.replace(
  'font-family:"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif;',
  'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",sans-serif;'
);
html = html.replace(
  'font-family:"Shippori Mincho","Yu Mincho","Noto Serif JP",serif;',
  'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",sans-serif;'
);
html = html.replaceAll(
  'font:11px/1.6 "IBM Plex Mono",Consolas,monospace;',
  'font:11px/1.6 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;'
);
html = html.replaceAll(
  'font:8px/1.38 "IBM Plex Mono",Consolas,monospace;',
  'font:8px/1.38 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;'
);

const mobileCss = `@media (max-width:700px) {
      html, body { font-size:16px; -webkit-text-size-adjust:100%; }
      #scene, #scene canvas { touch-action:none; }
      header { top:10px; left:12px; right:12px; }
      h1 { font-size:17px; line-height:1.25; letter-spacing:.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .legend { max-width:calc(100vw - 24px); gap:5px 10px; margin-top:5px; font-size:10px; line-height:1.25; }
      .controls {
        top:59px; left:8px; right:8px; width:calc(100% - 16px); max-width:none;
        display:flex; flex-wrap:nowrap; gap:2px; padding:3px;
        overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch;
        scrollbar-width:none; border-radius:8px;
      }
      .controls::-webkit-scrollbar { display:none; }
      .controls button {
        flex:0 0 auto; min-width:44px; height:34px; padding:0 7px;
        font-size:12px; line-height:1; white-space:nowrap; border-radius:6px;
      }
      .controls .observe { flex-basis:36px; min-width:36px; width:36px; font-size:18px; }
      .controls .divider { flex:0 0 1px; margin:0 2px; }
      .provenance {
        left:8px; right:8px; top:101px; max-width:none; padding:6px 8px;
        font-size:9px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        pointer-events:none;
      }
      .status { display:none; }
      .trace { display:none; }
      .details {
        left:8px; right:8px; bottom:8px; width:calc(100% - 16px);
        min-height:0; max-height:88px; padding:7px 9px; overflow:auto;
        border-radius:9px; -webkit-overflow-scrolling:touch;
      }
      .details h2 { margin:0 0 2px; font-size:11px; line-height:1.25; }
      .details p, .details .generated { font-size:9px; line-height:1.3; }
      .details .result { margin-top:3px; font-size:8px; line-height:1.25; }
      .details dl { display:none; }
      .loading { max-width:calc(100vw - 32px); text-align:center; font-size:11px; }
    }`;

const mobilePattern = /@media \(max-width:700px\) \{[\s\S]*?\n    \}\n  <\/style>/;
if (!mobilePattern.test(html)) throw new Error("mobile CSS block not found");
html = html.replace(mobilePattern, `${mobileCss}\n  </style>`);

const oldClick = `    renderer.domElement.addEventListener("pointermove", setPointer);
    renderer.domElement.addEventListener("pointerleave", () => {
      pointer.set(2, 2);
      pointerDirty = true;
    });
    renderer.domElement.addEventListener("click", () => {
      if (!hovered) return;
      selected = { ...hovered };
      if (selected.type === "root") observeAll();
      else if (selected.type === "entanglement") observeGroup(selected.id);
      else {
        refreshSelection();
        if (selected.type === "opinion") appendTrace(selected, "SELECT NODE");
      }
      triggerRelationGlow();
    });`;

const newClick = `    renderer.domElement.addEventListener("pointermove", setPointer);
    renderer.domElement.addEventListener("pointerleave", () => {
      pointer.set(2, 2);
      pointerDirty = true;
    });
    renderer.domElement.addEventListener("click", (event) => {
      /* iPhone/Safari has no hover before a normal tap. Resolve the hit from the
         actual tap coordinates instead of depending on the previous pointermove. */
      setPointer(event);
      hovered = hitFromPointer();
      pointerDirty = false;
      if (!hovered) return;
      selected = { ...hovered };
      if (selected.type === "root") observeAll();
      else if (selected.type === "entanglement") observeGroup(selected.id);
      else {
        refreshSelection();
        if (selected.type === "opinion") appendTrace(selected, "SELECT NODE");
      }
      triggerRelationGlow();
    });`;

if (!html.includes(oldClick)) throw new Error("click handler block not found");
html = html.replace(oldClick, newClick);

if (!html.includes('const count = Math.max(240, Math.min(5000')) throw new Error("5000-node generation changed unexpectedly");
if (!html.includes('setPointer(event);\n      hovered = hitFromPointer();')) throw new Error("tap raycast fix missing");
if (!html.includes('.trace { display:none; }')) throw new Error("mobile trace rule missing");

fs.writeFileSync(file, html);
console.log(`mobile quantum fix applied: ${Buffer.byteLength(html)} bytes`);
