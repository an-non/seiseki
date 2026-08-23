import fs from "node:fs";

const file = "core/ui.jsx";
let src = fs.readFileSync(file, "utf8");

const replaceOnce = (from, to, label) => {
  if (src.includes(to)) return;
  if (!src.includes(from)) throw new Error(`missing ${label}`);
  src = src.replace(from, to);
};

replaceOnce(
  'const FONT_BODY = \'"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif\';',
  'const FONT_BODY = \'-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",sans-serif\';',
  'FONT_BODY'
);
replaceOnce(
  'const FONT_DISP = \'"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif\';',
  'const FONT_DISP = \'-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",sans-serif\';',
  'FONT_DISP'
);
replaceOnce(
  'const FONT_MONO = \'"IBM Plex Mono","SF Mono","Consolas",monospace\';',
  'const FONT_MONO = \'ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,monospace\';',
  'FONT_MONO'
);

src = src.replace(/\n\s*@import url\([^\n]+fonts\.googleapis\.com[^\n]+\);/u, "");

src = src.replace(
  /const QUANTUM_PREVIEW_URL = "https:\/\/seiseki-opinion-network-preview\.tokyo-odh-129\.workers\.dev\/chunk-network-entanglement-preview\.html\?count=5000&seed=prototype-5000&theme=dark&rev=[^"]+";/u,
  'const QUANTUM_PREVIEW_URL = "https://seiseki-opinion-network-preview.tokyo-odh-129.workers.dev/chunk-network-entanglement-preview.html?count=5000&seed=prototype-5000&theme=dark&rev=mobile-touch-v3";'
);

if (!src.includes('count=5000&seed=prototype-5000')) throw new Error("quantum 5000-node URL missing");
if (!src.includes('rev=mobile-touch-v3')) throw new Error("quantum cache revision missing");
if (src.includes('fonts.googleapis.com')) throw new Error("external Google font import still present");
if (!src.includes('Hiragino Sans')) throw new Error("mobile-safe Japanese font stack missing");

fs.writeFileSync(file, src);
console.log("SEISEKI mobile UI font/cache patch applied");
