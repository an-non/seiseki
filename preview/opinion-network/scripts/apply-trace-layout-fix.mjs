import fs from "node:fs";

const file = process.argv[2] || "preview/opinion-network/public/chunk-network-entanglement-preview.html";
const html = fs.readFileSync(file, "utf8");

/*
 * The compact trace/layout source is now already canonical on the preview
 * branch.  Older versions of this helper tried to re-apply the same blocks
 * with exact multi-line string matches; once part of the layout had already
 * landed, that made the workflow fail on an otherwise-correct source.
 *
 * Keep this helper idempotent: verify the canonical markers and succeed when
 * they are already present.  If any marker disappears, fail loudly so the
 * deploy cannot silently ship a regressed quantum asset.
 */
const markers = [
  'width:min(300px,calc(100% - 32px));',
  'width:min(340px,calc(100% - 340px));',
  'width:min(54vw,220px); height:min(24vh,168px);',
  'max-height:76px;',
  'traceEntries.slice(-48)',
  'traceOutput.textContent = [...completed, activeEntry].filter(Boolean).join("\\n\\n");',
  'requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });',
  'traceEntries.push(formatTrace(item, action, traceSequence));',
  'if (traceEntries.length > 48) traceEntries.shift();',
  'traceState.textContent = "";'
];

const missing = markers.filter(marker => !html.includes(marker));
if (missing.length) {
  throw new Error(`canonical trace/layout markers missing: ${missing.join(" | ")}`);
}

console.log(`compact trace layout already canonical; verified: ${file}`);
