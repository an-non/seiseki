import fs from "node:fs";

const file = "core/ui.jsx";
let src = fs.readFileSync(file, "utf8");

const stableJapaneseSans = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",-apple-system,BlinkMacSystemFont,sans-serif';

src = src.replace(
  /const FONT_BODY = '[^']+';/u,
  `const FONT_BODY = '${stableJapaneseSans}';`
);
src = src.replace(
  /const FONT_DISP = '[^']+';/u,
  `const FONT_DISP = '${stableJapaneseSans}';`
);
src = src.replace(
  /const FONT_MONO = '[^']+';/u,
  'const FONT_MONO = \'ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,monospace\';'
);

src = src.replace(/\n\s*@import url\([^\n]+fonts\.googleapis\.com[^\n]+\);/u, "");

src = src.replace(
  '      html, body { margin: 0; }',
  '      html, body { margin: 0; font-family: ${FONT_BODY}; -webkit-text-size-adjust: 100%; font-synthesis: none; }'
);

/* Keep the 3D quantum renderer on the same origin as the app.  The previous
   cross-origin iframe depended on a second Worker and could be blank even when
   the main production Worker was healthy.  The revision parameter is also a
   deliberate cache-buster for the trace/layout renderer. */
src = src.replace(
  /const QUANTUM_PREVIEW_URL = "[^"]+";/u,
  'const QUANTUM_PREVIEW_URL = "/quantum/chunk-network-entanglement-preview.html?count=10000&seed=prototype-10000&theme=dark&rev=trace-layout-v2";'
);

src = src.replace(
  '      {cloudApiEnabled() ? (\n        <div role="status" style={{ background: C.karashiSoft, borderBottom: "1px solid " + C.karashi, color: C.ink }}>',
  '      {cloudApiEnabled() && typeof window !== "undefined" && window.SEISEKI_RUNTIME_MODE === "staging" ? (\n        <div role="status" style={{ background: C.karashiSoft, borderBottom: "1px solid " + C.karashi, color: C.ink }}>'
);
src = src.replace(
  '      {cloudApiEnabled() && typeof window !== "undefined" && window.location.hostname.includes("staging") ? (\n        <div role="status" style={{ background: C.karashiSoft, borderBottom: "1px solid " + C.karashi, color: C.ink }}>',
  '      {cloudApiEnabled() && typeof window !== "undefined" && window.SEISEKI_RUNTIME_MODE === "staging" ? (\n        <div role="status" style={{ background: C.karashiSoft, borderBottom: "1px solid " + C.karashi, color: C.ink }}>'
);

if (!src.includes('count=10000&seed=prototype-10000')) throw new Error("quantum 10000-node URL missing");
if (!src.includes('rev=trace-layout-v2')) throw new Error("embedded quantum cache revision missing");
if (!src.includes('const QUANTUM_PREVIEW_URL = "/quantum/')) throw new Error("same-origin quantum URL missing");
if (src.includes('seiseki-opinion-network-preview.tokyo-odh-129.workers.dev/chunk-network-entanglement-preview.html')) throw new Error("external quantum iframe dependency still present");
if (src.includes('fonts.googleapis.com')) throw new Error("external Google font import still present");
if (!src.includes('const FONT_BODY = \'"Hiragino Sans"')) throw new Error("Hiragino-first body font missing");
if (!src.includes('const FONT_DISP = \'"Hiragino Sans"')) throw new Error("Hiragino-first display font missing");
if (!src.includes('font-synthesis: none')) throw new Error("font synthesis guard missing");
if (!src.includes('window.SEISEKI_RUNTIME_MODE === "staging"')) throw new Error("explicit staging runtime guard missing");

fs.writeFileSync(file, src);
console.log("SEISEKI typography + same-origin embedded quantum UI patch applied");