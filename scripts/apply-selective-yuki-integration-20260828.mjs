import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  let source = readFileSync(path, "utf8");
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, found ${count}`);
  source = source.replace(from, to);
  writeFileSync(path, source, "utf8");
}

function insertAfterOnce(path, marker, addition) {
  let source = readFileSync(path, "utf8");
  if (source.includes(addition.trim())) return;
  const count = source.split(marker).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one marker, found ${count}`);
  source = source.replace(marker, marker + addition);
  writeFileSync(path, source, "utf8");
}

insertAfterOnce(
  "cloudflare/src/index.mjs",
  'import { getPublicAggregate } from "./public-aggregate.mjs";\n',
  'import { handleStagingAdminRequest } from "./staging-admin.mjs";\n'
);

replaceOnce(
  "cloudflare/src/index.mjs",
  '"access-control-allow-headers": "Authorization, Content-Type, X-Response-Manage-Token",',
  '"access-control-allow-headers": "Authorization, Content-Type, X-Response-Manage-Token, X-Seiseki-Admin-Token",'
);

insertAfterOnce(
  "cloudflare/src/index.mjs",
  '  const url = new URL(request.url);\n',
  '\n  const stagingAdminResponse = await handleStagingAdminRequest(request, env, url);\n  if (stagingAdminResponse) return stagingAdminResponse;\n'
);

replaceOnce(
  "cloudflare/wrangler.jsonc",
  '      "vars": {\n        "TURNSTILE_REQUIRED": "false",',
  '      "vars": {\n        "SEISEKI_ENV": "staging",\n        "STAGING_ADMIN_ENABLED": "true",\n        "TURNSTILE_REQUIRED": "false",'
);

const forbidden = [
  ["cloudflare/src/index.mjs", "storeLocalProvisionalAnalysis"],
  ["cloudflare/src/analysis.mjs", "storeLocalProvisionalAnalysis"],
  ["cloudflare/src/db.mjs", "provisional_analysis"]
];
for (const [path, token] of forbidden) {
  const source = readFileSync(path, "utf8");
  if (source.includes(token)) throw new Error(`forbidden provisional-analysis integration detected in ${path}: ${token}`);
}

console.log("selective staging-admin integration applied without provisional D1 analysis path");
