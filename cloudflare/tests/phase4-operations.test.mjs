import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

test("response CI keeps the full regression suite as a hard gate", () => {
  const workflow = read(".github/workflows/response-update-ci.yml");
  assert.match(workflow, /Required full regression suite[\s\S]*?run: npm test/u);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
});

test("obsolete code-generating driver workflows cannot auto-commit or push", () => {
  for (const path of [
    ".github/workflows/response-phase3-hardening-20260826.yml",
    ".github/workflows/response-phase4-backend-20260826.yml",
    ".github/workflows/response-phase4-ui-20260826.yml",
    ".github/workflows/reconcile-staging-account-links-20260826.yml"
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
});

test("Phase 4 deployment is manual, staging-only, migration-first, and cleanup-checked", () => {
  const workflow = read(".github/workflows/phase4-staging-deploy-e2e-20260826.yml");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s{2}push:/mu);
  assert.match(workflow, /deploy-phase4-staging/u);
  assert.match(workflow, /d1 migrations apply DB --env staging --remote/u);
  assert.match(workflow, /wrangler deploy --env staging --strict/u);
  assert.ok(
    workflow.indexOf("d1 migrations apply DB --env staging --remote")
      < workflow.indexOf("wrangler deploy --env staging --strict"),
    "staging migration must precede deployment"
  );
  assert.doesNotMatch(workflow, /Number\([^\n]+\)\s*!==\s*49/u);
  assert.match(workflow, /Verify E2E cleanup restored the staging baseline\s+if: always\(\)/u);
  assert.match(workflow, /seiseki-analysis-staging-dlq/u);
  assert.doesNotMatch(workflow, /wrangler deploy(?! --env staging)/u);
  assert.doesNotMatch(workflow, /d1 migrations apply seiseki-db --remote/u);
});

test("standalone migration requires explicit confirmation and uses the staging binding", () => {
  const workflow = read(".github/workflows/apply-staging-response-migrations-20260826.yml");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s{2}push:/mu);
  assert.match(workflow, /migrate-staging/u);
  assert.match(workflow, /d1 migrations apply DB --env staging --remote/u);
  assert.doesNotMatch(workflow, /d1 migrations apply seiseki-db --remote/u);
  assert.doesNotMatch(workflow, /Expected 49 responses/u);
});

test("staging queue has bounded retries and a staging DLQ", () => {
  const config = JSON.parse(read("cloudflare/wrangler.jsonc"));
  const consumer = config.env.staging.queues.consumers[0];
  assert.equal(consumer.max_retries, 3);
  assert.equal(consumer.retry_delay, 10);
  assert.equal(consumer.dead_letter_queue, "seiseki-analysis-staging-dlq");
});

test("live E2E keeps credentials out of logs and always attempts account cleanup", () => {
  const script = read("scripts/staging-phase4-e2e-20260826.mjs");
  assert.doesNotMatch(script, /record\([^\n]*(?:token|password)/iu);
  assert.match(script, /finally\s*\{\s*await cleanup\(\);\s*\}/u);
  assert.match(script, /method:\s*"DELETE"[\s\S]*?currentPassword:\s*password/u);
});
