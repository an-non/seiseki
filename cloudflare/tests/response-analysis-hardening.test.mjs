import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";
import { completeResponseAnalysis, failResponseAnalysis, getResponseAnalysis, startAnalysisRun } from "../src/db.mjs";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() { const r = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(r.changes) } }; }
}
class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try { const out = statements.map(s => s.run()); this.database.exec("COMMIT"); return out; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function makeDb() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql"]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.prepare(`INSERT INTO responses (id, created_at, app_version, consent_version, consent_at, free_text, analysis_status, demo_flag, revision)
                    VALUES ('r_testhardening0001', ?, '0.16.0', '1.3', ?, 'x', 'pending', 0, 1)`).run(Date.now(), Date.now());
  return database;
}
const emptyAnalysis = { params: { emo: { pol: 0, label: "中立" }, valid: 0, crit: 0, motiv: 0 }, ideology: { econ: 0, soc: 0, confidence: 0 }, attrs: [], chunks: [] };

test("expired lease cannot mark analysis run completed", async () => {
  const database = makeDb();
  const db = new D1(database);
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 't', 't', 'v', 'running', ?, 1, 0)`).run(Date.now() - 1000);
  const runId = Number(database.prepare("SELECT id FROM analysis_runs ORDER BY id DESC LIMIT 1").get().id);
  const saved = await completeResponseAnalysis(db, "r_testhardening0001", runId, 1, emptyAnalysis, {});
  assert.equal(saved, false);
  assert.equal(database.prepare("SELECT analysis_status AS s FROM responses WHERE id='r_testhardening0001'").get().s, "pending");
  const run = database.prepare("SELECT status, error_code AS e FROM analysis_runs WHERE id=?").get(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.e, "LEASE_EXPIRED");
  database.close();
});

test("expired lease cannot mark the current response failed", async () => {
  const database = makeDb();
  const db = new D1(database);
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 't', 't', 'v', 'running', ?, 1, 0)`).run(Date.now() - 1000);
  const runId = Number(database.prepare("SELECT id FROM analysis_runs ORDER BY id DESC LIMIT 1").get().id);
  const saved = await failResponseAnalysis(db, "r_testhardening0001", runId, 1, "AI_REQUEST_FAILED");
  assert.equal(saved, false);
  assert.equal(database.prepare("SELECT analysis_status AS s FROM responses WHERE id='r_testhardening0001'").get().s, "pending");
  const run = database.prepare("SELECT status, error_code AS e FROM analysis_runs WHERE id=?").get(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.e, "LEASE_EXPIRED");
  database.close();
});

test("expired running lease is reclaimed by a new run", async () => {
  const database = makeDb();
  const db = new D1(database);
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, 0)`).run(Date.now() - 1000);
  const claim = await startAnalysisRun(db, "r_testhardening0001", 1, "new", "new", "v", 30000);
  assert.equal(claim.status, "claimed");
  const rows = database.prepare("SELECT status, error_code AS e FROM analysis_runs ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].e, "LEASE_EXPIRED");
  assert.equal(rows[1].status, "running");
  database.close();
});

test("analysis status ignores an old revision run", async () => {
  const database = makeDb();
  const db = new D1(database);
  database.prepare("UPDATE responses SET revision=2, analysis_status='pending' WHERE id='r_testhardening0001'").run();
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until, error_code)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, ?, 'OLD_ERROR')`).run(Date.now(), Date.now() + 300000);
  const state = await getResponseAnalysis(db, "r_testhardening0001");
  assert.equal(state.revision, 2);
  assert.equal(state.analysisStatus, "pending");
  assert.equal(state.errorCode, undefined);
  database.close();
});

test("busy queue retry waits for the active lease instead of fixed 30 seconds", async () => {
  const database = makeDb();
  const db = new D1(database);
  const leaseUntil = Date.now() + 180000;
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, ?)`).run(Date.now(), leaseUntil);
  let retryDelay = 0;
  await worker.queue({ messages: [{
    id: "lease-busy", attempts: 1,
    body: { type: "analyze-response", responseId: "r_testhardening0001", revision: 1 },
    ack: () => assert.fail("busy message must not ack"),
    retry: ({ delaySeconds }) => { retryDelay = delaySeconds; }
  }] }, { DB: db, AI_ANALYSIS_ENABLED: "true" });
  assert.ok(retryDelay >= 175 && retryDelay <= 185, String(retryDelay));
  database.close();
});

test("wrangler declares dead letter queues for staging and production", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /seiseki-analysis-staging-dlq/u);
  assert.match(config, /seiseki-analysis-dlq/u);
});
