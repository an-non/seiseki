import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";

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
function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql"]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
}
function submission(text = "最初の自由記述") {
  return {
    appVersion: "0.16.0", consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
    answers: { q_support: "わからない", q_priority: "子育て・教育", q_econ: "3" }, freeText: text
  };
}
async function register(env, name) {
  const r = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password: "correct-horse-1" })
  }), env);
  assert.equal(r.status, 201); return r.json();
}
async function create(env, token, ctx) {
  return worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(submission())
  }), env, ctx);
}

test("invalid bearer on create is rejected instead of becoming anonymous", async () => {
  const database = createDatabase(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const r = await create(env, "invalid-token-value-that-is-long-enough-12345678901234567890");
  assert.equal(r.status, 401);
  assert.equal(database.prepare("SELECT count(*) AS n FROM responses").get().n, 0);
  database.close();
});

test("free-text PATCH keeps one response and increments revision while invalidating old analysis", async () => {
  const database = createDatabase(); const queued = []; const waits = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const owner = await register(env, "編集所有者");
  const createdResponse = await create(env, owner.token, { waitUntil: p => waits.push(p) });
  const created = await createdResponse.json(); await Promise.all(waits); waits.length = 0;
  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'旧','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/free-text`, {
    method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, freeText: "更新済み本文" })
  }), env, { waitUntil: p => waits.push(p) });
  assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.revision, 2); await Promise.all(waits);
  assert.equal(database.prepare("SELECT count(*) AS n FROM responses").get().n, 1);
  assert.equal(database.prepare("SELECT count(*) AS n FROM account_responses WHERE account_id=?").get(owner.account.id).n, 1);
  const stored = database.prepare("SELECT revision, free_text AS t, analysis_status AS s, analysis_json AS a FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([stored.revision, stored.t, stored.s, stored.a], [2, "更新済み本文", "pending", null]);
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 0);
  assert.deepEqual(queued.at(-1), { type: "analyze-response", responseId: created.id, revision: 2 });
  database.close();
});

test("stale expectedRevision returns 409 without partial mutation", async () => {
  const database = createDatabase(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "競合所有者"); const cr = await create(env, owner.token); const created = await cr.json();
  database.prepare("UPDATE responses SET revision=2 WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'保持','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'t','t','v','running',?,2,?)").run(created.id, Date.now(), Date.now() + 300000);
  const before = database.prepare("SELECT free_text AS t FROM responses WHERE id=?").get(created.id).t;
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/free-text`, {
    method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, freeText: "上書きされない" })
  }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "REVISION_CONFLICT");
  assert.equal(database.prepare("SELECT free_text AS t FROM responses WHERE id=?").get(created.id).t, before);
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 1);
  assert.equal(database.prepare("SELECT status FROM analysis_runs WHERE response_id=? AND response_revision=2").get(created.id).status, "running");
  database.close();
});

test("answers PATCH updates questionnaire data without changing revision or analysis", async () => {
  const database = createDatabase(); const queued = []; const waits = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const owner = await register(env, "回答編集者"); const cr = await create(env, owner.token); const created = await cr.json();
  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'保持','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  const before = database.prepare("SELECT revision, analysis_status AS status, analysis_json AS json FROM responses WHERE id=?").get(created.id);
  const good = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/answers", {
    method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },
    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" } })
  }), env, { waitUntil: p => waits.push(p) });
  assert.equal(good.status, 200); const body = await good.json();
  assert.equal(body.revision, 1); assert.equal(body.analysisStatus, "unchanged"); assert.equal(body.reanalysisQueued, false);
  await Promise.all(waits);
  const rows = database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id);
  assert.deepEqual(rows.map(x => [x.qid,x.value]), [["q_econ","5"],["q_priority","経済・雇用"],["q_support","支持しない"]]);
  const after = database.prepare("SELECT revision, analysis_status AS status, analysis_json AS json FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([after.revision, after.status, after.json], [before.revision, before.status, before.json]);
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 1);
  assert.deepEqual(queued, []);
  const bad = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/answers", {
    method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },
    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "存在しない選択肢", q_priority: "経済・雇用", q_econ: "5" } })
  }), env);
  assert.equal(bad.status, 400);
  database.close();
});

test("healthy pending current revision is not manually requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "ANALYSIS_NOT_RETRYABLE"); assert.deepEqual(queued, []); database.close();
});

test("failed current revision can be requeued without changing the response body", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const before = database.prepare("SELECT free_text AS t, updated_at AS u FROM responses WHERE id=?").get(created.id);
  database.prepare("UPDATE responses SET analysis_status='failed' WHERE id=?").run(created.id);
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  const after = database.prepare("SELECT free_text AS t, updated_at AS u, analysis_status AS s FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([after.t, after.u, after.s], [before.t, before.u, "pending"]); database.close();
});

test("stalled pending current revision can be requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  database.prepare("UPDATE responses SET updated_at=? WHERE id=?").run(Date.now() - 120000, created.id);
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]); database.close();
});

test("active running current revision is not manually requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json(); const now = Date.now();
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'test','test','v','running',?,1,?)").run(created.id, now, now + 60000);
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "ANALYSIS_NOT_RETRYABLE"); assert.deepEqual(queued, []); database.close();
});

test("expired running current revision is requeued and its stale run is closed", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json(); const now = Date.now();
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'test','test','v','running',?,1,?)").run(created.id, now - 120000, now - 1000);
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  const oldRun = database.prepare("SELECT status,error_code AS errorCode FROM analysis_runs WHERE response_id=? ORDER BY id DESC LIMIT 1").get(created.id);
  assert.deepEqual([oldRun.status, oldRun.errorCode], ["failed", "LEASE_EXPIRED"]); database.close();
});

test("invalid bearer cannot fall through to an anonymous manage token", async () => {
  const database = createDatabase(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const cr = await create(env, null); const created = await cr.json();
  const r = await worker.fetch(new Request(`http://local/api/responses/${created.id}`, {
    headers: {
      authorization: "Bearer invalid-token-value-that-is-long-enough-12345678901234567890",
      "x-response-manage-token": created.manageToken
    }
  }), env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "SESSION_INVALID");
  database.close();
});

test("analysis requeue has a short per-response revision cooldown", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  database.prepare("UPDATE responses SET analysis_status='failed' WHERE id=?").run(created.id);
  const request = () => new Request(`http://local/api/responses/${created.id}/analysis/requeue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken },
      body: JSON.stringify({ expectedRevision: 1 })
    });
  const first = await worker.fetch(request(), env);
  const second = await worker.fetch(request(), env);
  assert.equal(first.status, 202);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "RATE_LIMITED");
  assert.equal(queued.length, 1);
  database.close();
});

test("stale loser leaves response, answers, chunks, and runs completely untouched", async () => {
  const database = createDatabase();
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "stale-snapshot-owner");
  const created = await (await create(env, owner.token)).json();
  const now = Date.now();
  database.prepare("UPDATE responses SET revision=2 WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?, 'keep', '評価', 'その他', 'その他', '',0,0,'意見','{}')")
    .run(created.id, now);
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'test','test','v1','running',?,2,?)")
    .run(created.id, now, now + 60000);
  const answers = Object.fromEntries(
    database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id)
      .map(row => [row.qid, row.value])
  );
  const snapshot = () => ({
    response: database.prepare("SELECT revision,free_text,analysis_status,analysis_json FROM responses WHERE id=?").get(created.id),
    answers: database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id),
    chunks: database.prepare("SELECT summary,category,topic FROM opinion_chunks WHERE response_id=? ORDER BY id").all(created.id),
    runs: database.prepare("SELECT id,status,error_code,response_revision,lease_until FROM analysis_runs WHERE response_id=? ORDER BY id").all(created.id)
  });
  const before = snapshot();

  const staleText = await worker.fetch(new Request(`http://local/api/responses/${created.id}/free-text`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, freeText: "stale update" })
  }), env);
  assert.equal(staleText.status, 409);
  assert.deepEqual(snapshot(), before);

  const staleAnswers = await worker.fetch(new Request(`http://local/api/responses/${created.id}/answers`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, answers })
  }), env);
  assert.equal(staleAnswers.status, 409);
  assert.deepEqual(snapshot(), before);
  database.close();
});
