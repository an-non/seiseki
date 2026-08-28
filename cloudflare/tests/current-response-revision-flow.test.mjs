import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";
import { getResponseForAnalysis } from "../src/db.mjs";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try { const out = statements.map(statement => statement.run()); this.database.exec("COMMIT"); return out; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql",
    "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql",
    "0007_response_updated_at.sql", "0008_response_follow_up_text.sql", "0008_questionnaire_seven_structured.sql"
  ]) database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  return database;
}
const answersA = {
  q_support: "わからない",
  q_priority: "子育て・教育",
  q_econ: "3",
  q_information: "どちらかといえば不足している",
  q_social: "3",
  q_life: "どちらかといえば対応していない",
  q_participation: "どちらかといえば反映されていない"
};
const answersB = {
  q_support: "支持しない",
  q_priority: "経済・雇用",
  q_econ: "5",
  q_information: "不足している",
  q_social: "2",
  q_life: "対応していない",
  q_participation: "反映されていない"
};
async function register(env) {
  const response = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "canonical-flow-user", password: "correct-horse-1" })
  }), env);
  assert.equal(response.status, 201);
  return response.json();
}

test("follow-up then initial correction forms one current revision without losing second text", async () => {
  const database = createDatabase();
  const queued = []; const waits = [];
  const env = {
    DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async job => queued.push(job) }
  };
  const owner = await register(env);
  const createdResponse = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },
    body: JSON.stringify({
      appVersion: "0.16.0",
      consent: { accepted: true, version: "1.4", at: Date.now() },
      demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
      answers: answersA,
      freeText: "初回本文A"
    })
  }), env, { waitUntil: promise => waits.push(promise) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await Promise.all(waits); waits.length = 0;
  assert.equal(created.revision, 1);

  const followUpResponse = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },
    body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文A" })
  }), env, { waitUntil: promise => waits.push(promise) });
  assert.equal(followUpResponse.status, 201);
  assert.equal((await followUpResponse.json()).revision, 2);
  await Promise.all(waits); waits.length = 0;

  const initialResponse = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/initial", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },
    body: JSON.stringify({ expectedRevision: 2, answers: answersB, freeText: "初回本文B" })
  }), env, { waitUntil: promise => waits.push(promise) });
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).revision, 3);
  await Promise.all(waits);

  const current = await getResponseForAnalysis(env.DB, created.id);
  assert.equal(current.revision, 3);
  assert.equal(current.freeText, "初回本文B");
  assert.equal(current.followUpText, "第二本文A");
  assert.deepEqual(Object.fromEntries(current.answers.map(answer => [answer.qid, answer.value])), answersB);
  assert.deepEqual(queued.map(job => job.revision), [1, 2, 3]);
  assert.deepEqual(queued.at(-1), { type: "analyze-response", responseId: created.id, revision: 3 });
  database.close();
});
