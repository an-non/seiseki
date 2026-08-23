import fs from "node:fs";
import { pathToFileURL } from "node:url";

const file = "preview/opinion-network/public/chunk-network-entanglement-preview.html";
let html = fs.readFileSync(file, "utf8");

const stableBlock = `    const relationLines = makeLineSegments(initialPalette.relation, colorTheme === "dark" ? .18 : .27);
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

const relationExperimentBlock = /    \/\*[\s\S]*?relationMist[\s\S]*?    scene\.add\(relationMistLines\);/u;
if (!relationExperimentBlock.test(html)) throw new Error("relation mist experiment block not found");
html = html.replace(relationExperimentBlock, stableBlock);

html = html.replaceAll("relationMistLines", "relationGlowLines");
html = html.replaceAll("relationMistMaterial", "relationGlowMaterial");

html = html.replace(
  /      relationGlowMaterial\.color\.copy\(new THREE\.Color\(palette\.relation\)\.multiplyScalar\([\s\S]*?      relationGlowMaterial\.needsUpdate = true;/u,
  `      relationGlowMaterial.color.set(palette.relation);
      relationGlowMaterial.opacity = .04;
      relationGlowMaterial.blending = colorTheme === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;
      relationGlowMaterial.needsUpdate = true;`
);

html = html.replace(/      relationGlowMaterial\.opacity = relationMistOpacity\(\);\n/g, "");
html = html.replace(/    function relationMistOpacity\(\) \{[\s\S]*?    \}\n/u, "");
html = html.replace(/    const relationMistProfile = Object\.freeze\(\{[\s\S]*?    \}\);\n/u, "");

if (html.includes("relationMist")) throw new Error("relation mist experiment still present");
if (!html.includes("linewidth:1.55")) throw new Error("stable relation glow width missing");
if (!html.includes("opacity:colorTheme === \"dark\" ? .04 : .04")) throw new Error("stable relation glow opacity missing");
if (!html.includes("worldUnits:false")) throw new Error("stable pixel-space relation glow missing");

fs.writeFileSync(file, html);

/* The prototype sentence lattice has 6,048 literal combinations (24 topics x
   6 statements x 7 targets x 6 lenses). The UI intentionally renders 10,000
   synthetic observation nodes, so treating the lattice size as a hard node
   ceiling crashes initialization. Cycle the lattice and add a deterministic
   synthetic-series suffix only after the first full lattice; this keeps every
   generated text unique for deduplication while preserving topic/group logic. */
const engineFile = "preview/opinion-network/public/quantum-entanglement-engine.mjs";
let engine = fs.readFileSync(engineFile, "utf8");
const oldCapacity = '  const capacity = topics.length * statements.length * targets.length * lenses.length;\n  if (uniqueCount > capacity) throw new RangeError(`uniqueCount must be ${capacity} or less`);';
const newCapacity = '  const baseCapacity = topics.length * statements.length * targets.length * lenses.length;\n  const maximumSyntheticCount = 50000;\n  if (uniqueCount > maximumSyntheticCount) throw new RangeError(`uniqueCount must be ${maximumSyntheticCount} or less`);';
if (engine.includes(oldCapacity)) engine = engine.replace(oldCapacity, newCapacity);
if (!engine.includes("const baseCapacity = topics.length * statements.length * targets.length * lenses.length")) {
  throw new Error("10000-node base-capacity patch was not applied");
}

const oldCursor = '  for (let index = 0; index < uniqueCount; index += 1) {\n    let cursor = index;';
const newCursor = '  for (let index = 0; index < uniqueCount; index += 1) {\n    const variantIndex = Math.floor(index / baseCapacity);\n    let cursor = index % baseCapacity;';
if (engine.includes(oldCursor)) engine = engine.replace(oldCursor, newCursor);
if (!engine.includes("const variantIndex = Math.floor(index / baseCapacity)")) {
  throw new Error("10000-node variant-index patch was not applied");
}

const oldText = '      text: `${topic.label}について、${targets[targetIndex]}を対象に${lenses[lensIndex]}の観点から${statements[statementIndex]}。`,';
const newText = '      text: `${topic.label}について、${targets[targetIndex]}を対象に${lenses[lensIndex]}の観点から${statements[statementIndex]}。${variantIndex ? ` 合成系列${variantIndex + 1}。` : ""}`,';
if (engine.includes(oldText)) engine = engine.replace(oldText, newText);
if (!engine.includes("合成系列${variantIndex + 1}")) throw new Error("10000-node uniqueness suffix patch was not applied");
if (engine.includes("uniqueCount must be ${capacity} or less")) throw new Error("old 6048 hard cap still present");

fs.writeFileSync(engineFile, engine);

const moduleUrl = pathToFileURL(engineFile).href + `?verify=${Date.now()}`;
const quantum = await import(moduleUrl);
const topics = Array.from({ length: 24 }, (_, index) => ({
  id: `verify-topic-${index}`,
  label: `検証トピック${index}`,
  categoryId: `verify-category-${Math.floor(index / 4)}`
}));
const generated = quantum.generatePrototypeCandidates(topics, { uniqueCount: 10000, duplicateCount: 0 });
const unique = quantum.deduplicateNodes(generated);
if (generated.length !== 10000 || unique.length !== 10000) {
  throw new Error(`10000-node generator verification failed: generated=${generated.length}, unique=${unique.length}`);
}

console.log("stable relation glow restored; 10000 unique synthetic quantum nodes verified");
