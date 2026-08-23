import fs from "node:fs";

const file = "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

const mustContain = [
  'const count = Math.max(240, Math.min(5000',
  'generatePrototypeCandidates(topics, { uniqueCount:count, duplicateCount })',
  'const raycaster = new THREE.Raycaster();',
  'renderer.domElement.addEventListener("click"',
  'controls.maxDistance = Math.max(170, displayRadiusBounds.max * 2.5);',
  'OBSERVATION TRACE',
  'const relationLines = makeLineSegments(initialPalette.relation, colorTheme === "dark" ? .18 : .27);',
  'const relationGlowMaterial = new LineMaterial({'
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
  '"IBM Plex Mono",Consolas,monospace',
  'ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace'
);

const mobileCss = `@media (max-width:700px) {
      html, body { font-size:16px; -webkit-text-size-adjust:100%; }
      #scene, #scene canvas { touch-action:none; }
      header { top:6px; left:8px; right:8px; }
      h1 { font-size:15px; line-height:1.2; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .legend { max-width:calc(100vw - 16px); gap:4px 8px; margin-top:3px; font-size:8.5px; line-height:1.15; }
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
        font-size:10px; line-height:1; white-space:nowrap; border-radius:5px;
      }
      .controls .observe { flex-basis:30px; min-width:30px; width:30px; font-size:16px; }
      .controls .divider { flex:0 0 1px; height:14px; margin:0 1px; }
      .provenance {
        left:4px; right:4px; top:81px; max-width:none; padding:4px 5px;
        font-size:8px; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        pointer-events:none; border-radius:6px;
      }
      .status { display:none; }
      .trace {
        display:block; left:1px; right:auto; bottom:96px;
        width:min(58vw,240px); height:min(13vh,105px); max-height:min(13vh,105px);
        overflow:hidden; padding:0 1px; border:0; border-radius:0;
        background:transparent; box-shadow:none; backdrop-filter:none;
        font-size:7px; line-height:1.2; opacity:.72; pointer-events:none;
      }
      .trace header { margin:0 0 1px; font-size:7px; line-height:1.1; }
      .trace header span:last-child { display:none; }
      .trace pre { max-height:calc(13vh - 16px); overflow:hidden; }
      .details {
        left:6px; right:6px; bottom:6px; width:calc(100% - 12px);
        min-height:0; max-height:86px; padding:6px 8px; overflow:auto;
        border-radius:8px; -webkit-overflow-scrolling:touch;
      }
      .details h2 { margin:0 0 2px; font-size:10px; line-height:1.2; }
      .details p, .details .generated { font-size:8.5px; line-height:1.25; }
      .details .result { margin-top:2px; font-size:7.5px; line-height:1.2; }
      .details dl { display:none; }
      .loading { max-width:calc(100vw - 24px); text-align:center; font-size:10px; }
    }`;

const mobilePattern = /@media \(max-width:700px\) \{[\s\S]*?\n    \}\n  <\/style>/;
if (!mobilePattern.test(html)) throw new Error("mobile CSS block not found");
html = html.replace(mobilePattern, `${mobileCss}\n  </style>`);

html = html.replace(
  'const count = Math.max(240, Math.min(5000, Number.isFinite(requested) && requested > 0 ? requested : 5000));',
  'const count = Math.max(240, Math.min(10000, Number.isFinite(requested) && requested > 0 ? requested : 10000));'
);
html = html.replace(
  'const observationSeed = searchParams.get("seed") || "prototype-5000";',
  'const observationSeed = searchParams.get("seed") || "prototype-10000";'
);
html = html.replace('<p>5,000件の観測投影</p>', '<p>10,000件の観測投影</p>');

html = html.replace(
  'const camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, 600);',
  'const camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, 1800);'
);
html = html.replace(
  'controls.maxDistance = Math.max(170, displayRadiusBounds.max * 2.5);',
  `const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * .5);\n    const fitAllDistance = displayRadiusBounds.max / Math.tan(verticalHalfFov) / Math.min(1, Math.max(.35, camera.aspect));\n    controls.maxDistance = Math.max(220, fitAllDistance * 1.18);`
);

const oldRelationBlock = `    const relationLines = makeLineSegments(initialPalette.relation, colorTheme === "dark" ? .18 : .27);
    scene.add(relationLines);
    const relationGlowMaterial = new LineMaterial({
      color:initialPalette.relation,
      linewidth:1.55,
      transparent:true,
      opacity:colorTheme === "dark" ? .04 : .04,
      depthWrite:false,
      worldUnits:false,
      alphaToCoverage:true,
      blending:colorTheme === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog:false,
      toneMapped:false
    });
    relationGlowMaterial.resolution.set(innerWidth, innerHeight);
    const relationGlowLines = new LineSegments2(new LineSegmentsGeometry(), relationGlowMaterial);
    relationGlowLines.renderOrder = -1;
    scene.add(relationGlowLines);`;

const newRelationBlock = `    /* Keep the original readable relation line, and add one very wide, very low-energy
       additive mist layer on exactly the same geometry. A single relation barely glows;
       dense crossings accumulate into a soft haze without washing out the nodes. */
    const relationMistProfile = Object.freeze({
      referenceNodeDiameter:.32,
      worldWidth:.48,
      opacityDark:.012,
      opacityLight:.009,
      colorScaleDark:.55,
      colorScaleLight:.42
    });
    const relationLines = makeLineSegments(initialPalette.relation, colorTheme === "dark" ? .18 : .27);
    scene.add(relationLines);
    const relationMistMaterial = new LineMaterial({
      color:new THREE.Color(initialPalette.relation).multiplyScalar(
        colorTheme === "dark" ? relationMistProfile.colorScaleDark : relationMistProfile.colorScaleLight
      ),
      linewidth:relationMistProfile.worldWidth,
      transparent:true,
      opacity:colorTheme === "dark" ? relationMistProfile.opacityDark : relationMistProfile.opacityLight,
      depthWrite:false,
      worldUnits:true,
      alphaToCoverage:true,
      blending:THREE.AdditiveBlending,
      fog:false,
      toneMapped:false
    });
    relationMistMaterial.resolution.set(innerWidth, innerHeight);
    const relationMistLines = new LineSegments2(new LineSegmentsGeometry(), relationMistMaterial);
    relationMistLines.renderOrder = -1;
    scene.add(relationMistLines);`;

if (!html.includes(oldRelationBlock)) throw new Error("relation glow block not found");
html = html.replace(oldRelationBlock, newRelationBlock);

html = html.replace(
  `      relationGlowLines.geometry.dispose();\n      relationGlowLines.geometry = new LineSegmentsGeometry();\n      updateRelationPositions();`,
  `      relationMistLines.geometry.dispose();\n      relationMistLines.geometry = new LineSegmentsGeometry();\n      updateRelationPositions();`
);
html = html.replace(
  `      if (glowPositions.length) relationGlowLines.geometry.setPositions(glowPositions);`,
  `      if (glowPositions.length) relationMistLines.geometry.setPositions(glowPositions);`
);

html = html.replace(
  `      relationLines.material.color.set(palette.relation);\n      relationLines.material.opacity = colorTheme === "dark" ? .18 : .27;\n      relationGlowMaterial.color.set(palette.relation);\n      relationGlowMaterial.opacity = .04;\n      relationGlowMaterial.blending = colorTheme === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;\n      relationGlowMaterial.needsUpdate = true;`,
  `      relationLines.material.color.set(palette.relation);\n      relationLines.material.opacity = colorTheme === "dark" ? .18 : .27;\n      relationMistMaterial.color.copy(new THREE.Color(palette.relation).multiplyScalar(\n        colorTheme === "dark" ? relationMistProfile.colorScaleDark : relationMistProfile.colorScaleLight\n      ));\n      relationMistMaterial.opacity = colorTheme === "dark" ? relationMistProfile.opacityDark : relationMistProfile.opacityLight;\n      relationMistMaterial.blending = THREE.AdditiveBlending;\n      relationMistMaterial.needsUpdate = true;`
);

html = html.replace(
  `      relationGlowMaterial.resolution.set(innerWidth, innerHeight);`,
  `      relationMistMaterial.resolution.set(innerWidth, innerHeight);`
);

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

if (!html.includes('const count = Math.max(240, Math.min(10000')) throw new Error("10000-node generation missing");
if (!html.includes('requested : 10000')) throw new Error("10000-node default missing");
if (!html.includes('prototype-10000')) throw new Error("10000 seed missing");
if (!html.includes('10,000件の観測投影')) throw new Error("10000 label missing");
if (!html.includes('const nodeCountScale = Math.cbrt(Math.max(1, model.nodes.length) / 5000);')) throw new Error("existing node scale missing");
if (!html.includes('displayRadiusBounds = Object.freeze({ min:14 * displayScale, max:72 * displayScale })')) throw new Error("existing radius scale missing");
if (!html.includes('setPointer(event);\n      hovered = hitFromPointer();')) throw new Error("tap raycast fix missing");
if (!html.includes('const fitAllDistance = displayRadiusBounds.max')) throw new Error("fit-all zoom fix missing");
if (!html.includes('const relationMistProfile = Object.freeze')) throw new Error("relation mist profile missing");
if (!html.includes('worldWidth:.48')) throw new Error("relation mist width missing");
if (!html.includes('opacityDark:.012')) throw new Error("relation mist opacity missing");
if (!html.includes('const relationMistMaterial = new LineMaterial')) throw new Error("relation mist material missing");
if (!html.includes('relationMistLines.geometry.setPositions(glowPositions)')) throw new Error("shared relation mist geometry missing");
if (html.includes('relationGlowOuterMaterial')) throw new Error("strong outer glow still present");
if (!html.includes('background:transparent; box-shadow:none; backdrop-filter:none;')) throw new Error("transparent trace style missing");
if (html.includes('"IBM Plex Mono",Consolas,monospace')) throw new Error("legacy mono font remains");

fs.writeFileSync(file, html);
console.log(`mobile quantum 10000-node relation-mist fix applied: ${Buffer.byteLength(html)} bytes`);
