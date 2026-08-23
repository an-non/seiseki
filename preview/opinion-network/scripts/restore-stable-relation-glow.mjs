import fs from "node:fs";

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
console.log("stable relation glow restored; experiment preserved on archive branch");
