import fs from "node:fs";

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceBetween(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: boundary not found`);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}
function replaceExact(text, oldText, newText, label) {
  if (text.includes(newText)) return text;
  if (!text.includes(oldText)) throw new Error(`${label}: marker not found`);
  return text.replace(oldText, newText);
}

// Phase 3 hardening: B1 lease-safe completion, B2 lease-aware retry + DLQ config,
// B4 current-revision-only status reads.
{
  const path = "cloudflare/src/db.mjs";
  let text = read(path);

  const startRun = `export async function startAnalysisRun(db, responseId, expectedRevision, engine, model, promptVersion, leaseMs = 300000) {
  const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision < 1) return { status: "stale" };
  const current = await db.prepare(\`
    SELECT revision, analysis_status AS analysisStatus
    FROM responses
    WHERE id = ?
  \`).bind(responseId).first();
  if (!current || current.analysisStatus !== "pending" || Number(current.revision ?? 1) !== revision) {
    return { status: "stale" };
  }

  const now = Date.now();
  const leaseUntil = now + Math.max(30000, Math.min(900000, Number(leaseMs) || 300000));
  const findRunning = () => db.prepare(\`
    SELECT id, lease_until AS leaseUntil
    FROM analysis_runs
    WHERE response_id = ? AND response_revision = ? AND status = 'running'
    ORDER BY id DESC LIMIT 1
  \`).bind(responseId, revision).first();

  const running = await findRunning();
  if (running && Number(running.leaseUntil ?? 0) > now) {
    return { status: "busy", runId: Number(running.id), revision, leaseUntil: Number(running.leaseUntil) };
  }
  if (running) {
    await db.prepare(\`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = 'LEASE_EXPIRED', lease_until = NULL
      WHERE id = ? AND status = 'running' AND COALESCE(lease_until, 0) <= ?
    \`).bind(now, running.id, now).run();
  }

  try {
    await db.prepare(\`
      INSERT INTO analysis_runs (
        response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until
      )
      SELECT ?, ?, ?, ?, 'running', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM responses
        WHERE id = ? AND analysis_status = 'pending' AND revision = ?
      )
    \`).bind(
      responseId, engine, model, promptVersion, now, revision, leaseUntil,
      responseId, revision
    ).run();
  } catch (error) {
    const message = String(error?.message ?? "").toLowerCase();
    if (message.includes("unique") || message.includes("analysis_runs_response_revision_running_unique")) {
      const active = await findRunning();
      return {
        status: "busy",
        runId: active ? Number(active.id) : null,
        revision,
        leaseUntil: active ? Number(active.leaseUntil ?? now + 1000) : now + 1000
      };
    }
    throw error;
  }

  const claimed = await findRunning();
  if (claimed) {
    return { status: "claimed", runId: Number(claimed.id), revision, leaseUntil: Number(claimed.leaseUntil) };
  }
  return { status: "stale", revision };
}`;
  text = replaceBetween(text,
    "export async function startAnalysisRun",
    "export async function renewAnalysisRunLease",
    startRun,
    "startAnalysisRun"
  );

  const complete = `export async function completeResponseAnalysis(db, responseId, runId, expectedRevision, analysis, metadata) {
  const revision = Number(expectedRevision);
  const completedAt = Date.now();
  const guardSql = \`EXISTS (
    SELECT 1
    FROM responses r
    JOIN analysis_runs ar ON ar.id = ?
    WHERE r.id = ? AND r.revision = ? AND r.analysis_status = 'pending'
      AND ar.response_id = r.id AND ar.response_revision = ?
      AND ar.status = 'running' AND COALESCE(ar.lease_until, 0) >= ?
  )\`;
  const statements = [
    db.prepare(\`
      UPDATE responses
      SET analysis_status = 'completed', analysis_json = ?
      WHERE id = ? AND revision = ? AND \${guardSql}
    \`).bind(JSON.stringify(analysis), responseId, revision, runId, responseId, revision, revision, completedAt),
    db.prepare(\`
      DELETE FROM opinion_chunks
      WHERE response_id = ? AND \${guardSql}
    \`).bind(responseId, runId, responseId, revision, revision, completedAt)
  ];
  for (const chunk of analysis.chunks) {
    statements.push(db.prepare(\`
      INSERT INTO opinion_chunks (
        response_id, created_at, summary, category, topic,
        target_type, target_name, emotion, criticality, fact_status, provenance_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE \${guardSql}
    \`).bind(
      responseId, completedAt, chunk.s, chunk.cat, chunk.topic,
      chunk.tt, chunk.tn, chunk.emo, chunk.crit, chunk.fact,
      JSON.stringify({ ...metadata, responseRevision: revision, analysisRunId: runId }),
      runId, responseId, revision, revision, completedAt
    ));
  }
  statements.push(db.prepare(\`
    UPDATE analysis_runs
    SET status = 'completed', completed_at = ?, error_code = NULL, lease_until = NULL
    WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
      AND COALESCE(lease_until, 0) >= ?
      AND EXISTS (
        SELECT 1 FROM responses
        WHERE id = ? AND revision = ? AND analysis_status = 'completed'
      )
  \`).bind(completedAt, runId, responseId, revision, completedAt, responseId, revision));

  const results = await db.batch(statements);
  const responseUpdated = Number(results?.[0]?.meta?.changes ?? 0) === 1;
  const runUpdated = Number(results?.[results.length - 1]?.meta?.changes ?? 0) === 1;
  if (responseUpdated && runUpdated) return true;

  const runState = await db.prepare(\`
    SELECT lease_until AS leaseUntil, status
    FROM analysis_runs WHERE id = ?
  \`).bind(runId).first();
  const code = Number(runState?.leaseUntil ?? 0) < completedAt ? "LEASE_EXPIRED" : "STALE_REVISION";
  await markRunStale(db, runId, code);
  return false;
}`;
  text = replaceBetween(text,
    "export async function completeResponseAnalysis",
    "export async function failResponseAnalysis",
    complete,
    "completeResponseAnalysis"
  );

  const getAnalysis = `export async function getResponseAnalysis(db, id) {
  const row = await db.prepare(\`
    SELECT analysis_status AS analysisStatus, analysis_json AS analysisJson, revision
    FROM responses
    WHERE id = ?
  \`).bind(id).first();
  if (!row) return null;
  const revision = Number(row.revision ?? 1);
  const run = await db.prepare(\`
    SELECT status, error_code AS errorCode, response_revision AS responseRevision
    FROM analysis_runs
    WHERE response_id = ? AND response_revision = ?
    ORDER BY id DESC LIMIT 1
  \`).bind(id, revision).first();
  let analysis = null;
  if (row.analysisJson) {
    try { analysis = JSON.parse(row.analysisJson); } catch { analysis = null; }
  }
  return {
    analysisStatus: row.analysisStatus === "pending" && run?.status === "running"
      ? "running"
      : row.analysisStatus,
    revision,
    analysis,
    ...(run?.errorCode ? { errorCode: run.errorCode } : {})
  };
}`;
  text = replaceBetween(text,
    "export async function getResponseAnalysis",
    "export async function deleteResponse",
    getAnalysis,
    "getResponseAnalysis"
  );
  write(path, text);
}

{
  const path = "cloudflare/src/index.mjs";
  let text = read(path);
  const helper = `function retryDelayForLease(outcome, now = Date.now()) {
  const leaseUntil = Number(outcome?.leaseUntil ?? 0);
  const remainingMs = Math.max(0, leaseUntil - now);
  const jitterMs = Math.floor(Math.random() * 2000);
  return Math.min(86400, Math.max(1, Math.ceil((remainingMs + jitterMs) / 1000)));
}\n\n`;
  if (!text.includes("function retryDelayForLease")) {
    const marker = "async function handleRequest(request, env, ctx) {";
    if (!text.includes(marker)) throw new Error("index helper insertion marker not found");
    text = text.replace(marker, helper + marker);
  }
  text = replaceExact(text,
`        if (outcome?.status === "busy") {
          message.retry({ delaySeconds: 30 });
          continue;
        }`,
`        if (outcome?.status === "busy") {
          const delaySeconds = retryDelayForLease(outcome);
          console.warn(JSON.stringify({
            event: "analysis_queue_busy_retry",
            responseId,
            revision,
            runId: outcome?.runId ?? null,
            leaseUntil: outcome?.leaseUntil ?? null,
            delaySeconds,
            attempts: Number(message.attempts ?? 1)
          }));
          message.retry({ delaySeconds });
          continue;
        }`,
    "lease-aware queue retry"
  );
  write(path, text);
}

{
  const path = "cloudflare/wrangler.jsonc";
  let text = read(path);
  text = replaceExact(text,
`            "max_retries": 3,
            "max_concurrency": 1,`,
`            "max_retries": 3,
            "dead_letter_queue": "seiseki-analysis-staging-dlq",
            "max_concurrency": 1,`,
    "staging DLQ"
  );
  const prodNeedle = `        "max_retries": 3,
        "max_concurrency": 1,`;
  const prodReplacement = `        "max_retries": 3,
        "dead_letter_queue": "seiseki-analysis-dlq",
        "max_concurrency": 1,`;
  text = replaceExact(text, prodNeedle, prodReplacement, "production DLQ declaration");
  write(path, text);
}

{
  const path = "cloudflare/tests/response-analysis-hardening.test.mjs";
  const test = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";
import { completeResponseAnalysis, getResponseAnalysis, startAnalysisRun } from "../src/db.mjs";

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
    database.exec(readFileSync(new URL(\`../migrations/\${name}\`, import.meta.url), "utf8"));
  }
  database.prepare(\`INSERT INTO responses (id, created_at, app_version, consent_version, consent_at, free_text, analysis_status, demo_flag, revision)
                    VALUES ('r_testhardening0001', ?, '0.16.0', '1.3', ?, 'x', 'pending', 0, 1)\`).run(Date.now(), Date.now());
  return database;
}
const emptyAnalysis = { params: { emo: { pol: 0, label: "中立" }, valid: 0, crit: 0, motiv: 0 }, ideology: { econ: 0, soc: 0, confidence: 0 }, attrs: [], chunks: [] };

test("expired lease cannot mark analysis run completed", async () => {
  const database = makeDb();
  const db = new D1(database);
  database.prepare(\`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 't', 't', 'v', 'running', ?, 1, 0)\`).run(Date.now() - 1000);
  const runId = Number(database.prepare("SELECT id FROM analysis_runs ORDER BY id DESC LIMIT 1").get().id);
  const saved = await completeResponseAnalysis(db, "r_testhardening0001", runId, 1, emptyAnalysis, {});
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
  database.prepare(\`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, 0)\`).run(Date.now() - 1000);
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
  database.prepare(\`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until, error_code)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, ?, 'OLD_ERROR')\`).run(Date.now(), Date.now() + 300000);
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
  database.prepare(\`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until)
                    VALUES ('r_testhardening0001', 'old', 'old', 'v', 'running', ?, 1, ?)\`).run(Date.now(), leaseUntil);
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
`;
  write(path, test);
}

console.log("Applied Phase 3 hardening (B1/B2/B4).");
