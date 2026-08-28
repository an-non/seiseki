import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";
import { composeAnalysisText } from "../src/analysis.mjs";

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
function db() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql"]) {
    database.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  return database;
}
function submission() {
  return {
    appVersion: "0.16.0", consent: { accepted: true, version: "1.4", at: Date.now() },
    demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
    answers: { q_support: "わからない", q_priority: "子育て・教育", q_econ: "3" }, freeText: "初回本文"
  };
}
async function register(env, name) {
  const response = await worker.fetch(new Request("http://local/api/accounts/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: "correct-horse-1" }) }), env);
  assert.equal(response.status, 201); return response.json();
}
async function create(env, token) {
  const response = await worker.fetch(new Request("http://local/api/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(submission()) }), env);
  assert.equal(response.status, 201); return response.json();
}

test("analysis input keeps first and second free text distinguishable", () => {
  assert.equal(composeAnalysisText({ freeText: "一回目", followUpText: "二回目" }), "[初回自由記述]\n一回目\n\n[第二自由記述]\n二回目");
});

test("second free text can be created once and increments the same response revision", async () => {
  const database = db(); const queued = []; const waits = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async item => queued.push(item) } };
  const owner = await register(env, "二回目作成者"); const created = await create(env, owner.token);
  const first = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env, { waitUntil: p => waits.push(p) });
  assert.equal(first.status, 201); assert.equal((await first.json()).revision, 2); await Promise.all(waits);
  const row = database.prepare("SELECT free_text AS firstText, follow_up_text AS secondText, revision FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([row.firstText, row.secondText, row.revision], ["初回本文", "第二本文", 2]);
  assert.deepEqual(queued.at(-1), { type: "analyze-response", responseId: created.id, revision: 2 });
  const second = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2, followUpText: "三回目にはならない" }) }), env);
  assert.equal(second.status, 409); assert.equal((await second.json()).error, "FOLLOW_UP_ALREADY_EXISTS");
  assert.equal(database.prepare("SELECT follow_up_text AS t, revision FROM responses WHERE id=?").get(created.id).t, "第二本文");
  database.close();
});

test("second free text correction uses PATCH and does not create another submission slot", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目修正者"); const created = await create(env, owner.token);
  let response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env);
  assert.equal(response.status, 201);
  response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2, followUpText: "第二本文の修正版" }) }), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).revision, 3);
  const row = database.prepare("SELECT free_text AS firstText, follow_up_text AS secondText, revision FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([row.firstText, row.secondText, row.revision], ["初回本文", "第二本文の修正版", 3]);
  database.close();
});

test("stale follow-up create does not invalidate current chunks or running analysis", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目競合者"); const created = await create(env, owner.token);
  database.prepare("UPDATE responses SET revision=2 WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'保持','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'t','t','v','running',?,2,?)").run(created.id, Date.now(), Date.now() + 300000);
  const response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "競合本文" }) }), env);
  assert.equal(response.status, 409); assert.equal((await response.json()).error, "REVISION_CONFLICT");
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 1);
  assert.equal(database.prepare("SELECT status FROM analysis_runs WHERE response_id=? AND response_revision=2").get(created.id).status, "running");
  assert.equal(database.prepare("SELECT follow_up_text AS t FROM responses WHERE id=?").get(created.id).t, null);
  database.close();
});

test("account response keeps first and second free texts as separate fields", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目取得者"); const created = await create(env, owner.token);
  await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env);
  const response = await worker.fetch(new Request("http://local/api/accounts/me/responses", { headers: { authorization: "Bearer " + owner.token } }), env);
  assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.responses[0].free, "初回本文");
  assert.equal(payload.responses[0].followUpText, "第二本文");
  assert.equal(payload.responses[0].followUpSubmitted, true);
  assert.equal(payload.responses[0].seq, 1);
  assert.equal(payload.responses[0].revision, 2);
  database.close();
});
