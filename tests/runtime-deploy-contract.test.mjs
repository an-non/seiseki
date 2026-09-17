import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("runtime build scripts use explicit modes", async () => {
  const localPackage = JSON.parse(await read("local/package.json"));
  const workerPackage = JSON.parse(await read("cloudflare/package.json"));

  assert.equal(localPackage.scripts.build, "vite build --mode local");
  assert.equal(localPackage.scripts["build:staging"], "vite build --mode staging");
  assert.equal(localPackage.scripts["build:production"], "vite build --mode production");
  assert.equal(workerPackage.scripts["deploy:staging"], "node scripts/deploy-runtime.mjs staging");
  assert.equal(workerPackage.scripts["deploy:production"], "node scripts/deploy-runtime.mjs production");
});

test("Vite emits a runtime contract for every build", async () => {
  const config = await read("local/vite.config.js");
  assert.match(config, /DEPLOYED_RUNTIME_CONTRACTS/);
  assert.match(config, /seiseki-runtime\.json/);
  assert.match(config, /apiRequired: true/);
});

test("staging workflow builds and deploys only guarded staging artifacts", async () => {
  const workflow = await read(".github/workflows/deploy-staging.yml");
  assert.match(workflow, /VITE_SEISEKI_API_REQUIRED: 'true'/);
  assert.match(workflow, /VITE_SEISEKI_RUNTIME_MODE: staging/);
  assert.match(workflow, /npm run build:staging/);
  assert.match(workflow, /npm --prefix cloudflare run assets:check:staging/);
  assert.match(workflow, /npm run deploy:staging/);
});

test("production workflow builds and deploys only guarded production artifacts", async () => {
  const workflow = await read(".github/workflows/production-release.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /release_sha:/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /d1 migrations apply/);
  assert.match(workflow, /npm run build:production/);
  assert.match(workflow, /npm run deploy:production/);
  assert.match(workflow, /test ! -e dist\/quantum-v2\/quantum-node-relations-v2-preview\.html/);
});

test("production access preflight is immutable and read-only", async () => {
  const workflow = await read(".github/workflows/production-preflight.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_sha:/);
  assert.match(workflow, /preflight-production/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /d1 list --json/);
  assert.match(workflow, /queues list/);
  assert.match(workflow, /secret list/);
  assert.match(workflow, /d1 migrations list seiseki-db --remote/);
  assert.match(workflow, /deployments list/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /^\s*npx wrangler deploy(?:\s|$)/m);
  assert.doesNotMatch(workflow, /d1 migrations apply/);
  assert.doesNotMatch(workflow, /d1 execute/);
});

test("superseded production and hotfix workflows remain inert", async () => {
  const retiredWorkflows = [
    "cloudflare-production-diagnostic.yml",
    "production-dashboard-hotfix.yml",
    "production-quantum-10000-hotfix.yml",
    "production-release-dbapi-v2.yml",
    "production-release-dbapi.yml",
    "quantum-trace-layout-hotfix.yml",
    "rapid-quantum-dashboard-hotfix-v2.yml",
    "rapid-quantum-dashboard-hotfix.yml",
    "safari15-hotfix-v3.yml",
  ];

  for (const name of retiredWorkflows) {
    const workflow = await read(`.github/workflows/${name}`);
    assert.match(workflow, /^name: "\[retired\]/m, name);
    assert.match(workflow, /workflow_dispatch:/, name);
    assert.doesNotMatch(workflow, /^  push:/m, name);
    assert.match(workflow, /permissions:\s+contents: read/, name);
    assert.match(workflow, /^    if: \$\{\{ false \}\}$/m, name);
  }
});

test("production D1 migrations are isolated behind an immutable manual workflow", async () => {
  const workflow = await read(".github/workflows/production-d1-migrate.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /migrate-production-d1/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /d1 time-travel info DB --json/);
  assert.match(workflow, /d1 migrations apply DB --remote/);
  assert.doesNotMatch(workflow, /wrangler deploy/);
  assert.doesNotMatch(workflow, /git push/);
});

test("password KDF is consistent with the verified Free CPU profile", async () => {
  const config = JSON.parse(await read("cloudflare/wrangler.jsonc"));
  const auth = await read("cloudflare/src/auth.mjs");
  const productionSetup = await read("scripts/configure-production.mjs");
  const release = await read(".github/workflows/production-release.yml");
  assert.equal(config.vars.PASSWORD_ITERATIONS, "30000");
  assert.equal(config.env.staging.vars.PASSWORD_ITERATIONS, "30000");
  assert.match(auth, /const PASSWORD_ITERATIONS = 30000;/);
  assert.match(productionSetup, /PASSWORD_ITERATIONS: "30000"/);
  assert.match(release, /PASSWORD_ITERATIONS !== '30000'/);
});

test("production build excludes the local-only quantum v2 prototype", async () => {
  const config = await read("local/vite.config.js");
  assert.match(config, /mode === "production" \? \{\} : \{ quantumV2: quantumV2Entry \}/);
  assert.match(config, /placeQuantumPreview\(mode !== "production"\)/);
});
