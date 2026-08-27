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
  run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
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
    "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql"
  ]) database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  return database;
}
function submission() {
  return {
    appVersion: "0.16.0",
    consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
    answers: { q_support: "わからない", q_priority: "子育て・教育" },
    freeText: "教育制度について検討してほしい。"
  };
}

test("create emits revision and stale/duplicate queue delivery cannot overwrite it", async () => {
  const database = createDatabase();
  const queued = [];
  const waits = [];
  const env = {
    DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async body => { queued.push(body); } }
  };
  const createdResponse = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission())
  }), env, { waitUntil: promise => waits.push(promise) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await Promise.all(waits);
  assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);

  let staleAck = 0;
  await worker.queue({ messages: [{
    id: "stale", body: { type: "analyze-response", responseId: created.id, revision: 2 },
    ack: () => { staleAck += 1; }, retry: () => assert.fail("stale message retried")
  }] }, env);
  assert.equal(staleAck, 1);
  assert.equal(database.prepare("SELECT count(*) AS n FROM analysis_runs WHERE response_id = ?").get(created.id).n, 0);

  const aiEnv = {
    ...env,
    AI: { run: async () => ({ response: JSON.stringify({
      params: { emo: { pol: 0, label: "中立" }, valid: 60, crit: 50, motiv: 50 },
      ideology: { econ: 0, soc: 0, confidence: 10 }, attrs: [], chunks: []
    }) }) }
  };
  let acked = 0;
  const makeMessage = () => ({
    id: crypto.randomUUID(), body: { type: "analyze-response", responseId: created.id, revision: 1 },
    ack: () => { acked += 1; }, retry: () => assert.fail("valid message retried")
  });
  await worker.queue({ messages: [makeMessage(), makeMessage()] }, aiEnv);
  assert.equal(acked, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM analysis_runs WHERE response_id = ? AND response_revision = 1").get(created.id).n, 1);
  assert.equal(database.prepare("SELECT analysis_status AS status FROM responses WHERE id = ?").get(created.id).status, "completed");
  database.close();
});
