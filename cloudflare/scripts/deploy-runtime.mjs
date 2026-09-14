import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeAssets } from "./assert-runtime-assets.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const cloudflareRoot = resolve(dirname(scriptPath), "..");
const target = process.argv[2];

await assertRuntimeAssets(target);

const wranglerPath = resolve(cloudflareRoot, "node_modules/wrangler/bin/wrangler.js");
const args = [wranglerPath, "deploy"];
if (target === "staging") args.push("--env", "staging");
args.push("--strict");

const result = spawnSync(process.execPath, args, {
  cwd: cloudflareRoot,
  env: process.env,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
