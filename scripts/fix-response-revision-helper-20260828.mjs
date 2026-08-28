import { readFileSync, writeFileSync } from "node:fs";
const path = "scripts/apply-response-revision-unification-20260828.mjs";
let source = readFileSync(path, "utf8");
const block = `replaceOnce(\n  "core/ui.jsx",\n  \`          {nonFreeQuestions.map((q, index) => (\`,\n  \`          {nonFreeQuestions.map((q, index) => (\`\n);\n`;
if (!source.includes(block)) throw new Error("duplicate-match no-op block not found");
source = source.replace(block, "");
writeFileSync(path, source, "utf8");
console.log("revision helper duplicate-match block removed");
