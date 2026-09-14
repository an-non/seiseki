import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "../..");

const CONTRACTS = Object.freeze({
  staging: Object.freeze({
    apiBaseUrl: "https://seiseki-api-staging.tokyo-odh-129.workers.dev",
    apiRequired: true,
    runtimeMode: "staging"
  }),
  production: Object.freeze({
    apiBaseUrl: "https://seiseki-api.tokyo-odh-129.workers.dev",
    apiRequired: true,
    runtimeMode: "production"
  })
});

export async function assertRuntimeAssets(target) {
  const expected = CONTRACTS[target];
  if (!expected) throw new Error(`Unsupported deployment target: ${target}`);

  const manifestPath = resolve(projectRoot, "local/dist/seiseki-runtime.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Runtime artifact manifest is missing or invalid: ${manifestPath}`, { cause: error });
  }

  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      throw new Error(
        `Refusing ${target} deploy: runtime manifest ${key}=${JSON.stringify(manifest[key])}, expected ${JSON.stringify(value)}`
      );
    }
  }

  return { target, manifestPath, ...expected };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await assertRuntimeAssets(process.argv[2]);
  console.log(JSON.stringify({ status: "runtime_assets_verified", ...result }, null, 2));
}
