import fs from "node:fs";
import { spawnSync } from "node:child_process";

const sourcePath = "scripts/apply-response-phase4-backend-20260826.mjs";
const tempPath = "scripts/.tmp-response-phase4-backend-20260826.mjs";
let source = fs.readFileSync(sourcePath, "utf8");
source = source
  .replace('`unsupported field: ${key}`', '"unsupported field: " + key')
  .replaceAll('`answers.${qid}`', '"answers." + qid')
  .replaceAll('`answers.${qid} has an invalid qid`', '"answers." + qid + " has an invalid qid"');
fs.writeFileSync(tempPath, source);
try {
  const result = spawnSync(process.execPath, [tempPath], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try { fs.unlinkSync(tempPath); } catch {}
}
