import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const parts = [
  "core/head.jsx",
  "core/logic.js",
  "core/seiseki-local-bridge.js",
  "core/chunk-network.js",
  "core/opinion-network.jsx",
  "core/chunk-network.jsx",
  "core/ui.jsx",
];
const output = parts.map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const outputs = ["app/seiseki.jsx", "local/src/App.jsx"];
for (const target of outputs) fs.writeFileSync(path.join(root, target), output, "utf8");
process.stdout.write(JSON.stringify({ outputs, parts, bytes: Buffer.byteLength(output) }, null, 2) + "\n");
