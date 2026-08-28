import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";

class D1StatementAdapter {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new D1StatementAdapter(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1DatabaseAdapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database, sql); }
  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_accounts_and_analysis.sql",
    "0003_staging_kdf_range.sql",
    "0004_response_question_context.sql",
    "0005_rate_limits.sql",
    "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql"
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
}

function submission(text = "教育制度について検討してほしい。") {
  return {
    appVersion: "0.16.0",
    consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: {
      age: "30代", gender: "回答しない", region: "関東",
      occupation: "会社員(正社員)", party: "支持政党なし"
    },
    answers: { q_support: "わからない", q_priority: "子育て・教育" },
    freeText: text
  };
}

async function register(env, name) {
  const response = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password: "correct-horse-1" })
  }), env);
  assert.equal(response.status, 201);
  return response.json();
}

async function createResponse(env, body = submission(), token = null, ctx = undefined) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return worker.fetch(new Request("http://local/api/responses", {
    method: "POST", headers, body: JSON.stringify(body)
  }), env, ctx);
}

test("anonymous response requires its one-time manage token for read and delete", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  const createdResponse = await createResponse(env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.revision, 1);
  assert.match(created.manageToken, /^[A-Za-z0-9_-]{40,64}$/u);
  assert.equal(database.prepare("SELECT count(*) AS n FROM response_access WHERE response_id = ?").get(created.id).n, 1);

  const denied = await worker.fetch(new Request(`http://local/api/responses/${created.id}`), env);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "RESPONSE_AUTH_REQUIRED");

  const allowed = await worker.fetch(new Request(`http://local/api/responses/${created.id}`, {
    headers: { "x-response-manage-token": created.manageToken }
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).revision, 1);

  const removed = await worker.fetch(new Request(`http://local/api/responses/${created.id}`, {
    method: "DELETE",
    headers: { "x-response-manage-token": created.manageToken }
  }), env);
  assert.equal(removed.status, 204);
  assert.equal(database.prepare("SELECT count(*) AS n FROM responses WHERE id = ?").get(created.id).n, 0);
  assert.equal(database.prepare("SELECT count(*) AS n FROM response_access WHERE response_id = ?").get(created.id).n, 0);
  database.close();
});

test("account can create only one active response and another account cannot read it", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "所有者一号");
  const stranger = await register(env, "別利用者二号");

  const firstResponse = await createResponse(env, submission(), owner.token);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(first.manageToken, undefined);
  assert.equal(database.prepare("SELECT count(*) AS n FROM account_responses WHERE account_id = ?").get(owner.account.id).n, 1);

  const second = await createResponse(env, submission("二件目として保存されてはいけない。"), owner.token);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "RESPONSE_ALREADY_EXISTS");
  assert.equal(database.prepare("SELECT count(*) AS n FROM responses").get().n, 1);

  const ownerRead = await worker.fetch(new Request(`http://local/api/responses/${first.id}`, {
    headers: { authorization: `Bearer ${owner.token}` }
  }), env);
  assert.equal(ownerRead.status, 200);

  const strangerRead = await worker.fetch(new Request(`http://local/api/responses/${first.id}`, {
    headers: { authorization: `Bearer ${stranger.token}` }
  }), env);
  assert.equal(strangerRead.status, 403);
  assert.equal((await strangerRead.json()).error, "RESPONSE_FORBIDDEN");
  database.close();
});

test("account deletion removes its response and all response children", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "削除利用者");
  const createdResponse = await createResponse(env, submission(), owner.token);
  const created = await createdResponse.json();
  database.prepare(`INSERT INTO analysis_runs (response_id, engine, model, prompt_version, status, started_at, response_revision)
                    VALUES (?, 'test', 'test', 'v1', 'failed', ?, 1)`).run(created.id, Date.now());

  const removed = await worker.fetch(new Request("http://local/api/accounts/me", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ currentPassword: "correct-horse-1" })
  }), env);
  assert.equal(removed.status, 204);
  for (const [table, where, value] of [
    ["accounts", "id", owner.account.id],
    ["account_sessions", "account_id", owner.account.id],
    ["account_responses", "account_id", owner.account.id],
    ["responses", "id", created.id],
    ["answers", "response_id", created.id],
    ["response_questions", "response_id", created.id],
    ["analysis_runs", "response_id", created.id],
    ["opinion_chunks", "response_id", created.id]
  ]) {
    assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where} = ?`).get(value).n, 0, table);
  }
  database.close();
});

test("queue requires revision, ignores stale jobs, and deduplicates one revision", async () => {
  const database = createDatabase();
  const queued = [];
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async body => { queued.push(body); } }
  };
  const waits = [];
  const createdResponse = await createResponse(env, submission(), null, {
    waitUntil: promise => waits.push(promise)
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await Promise.all(waits);
  assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);

  let staleAck = 0;
  await worker.queue({ messages: [{
    id: "stale-1", body: { type: "analyze-response", responseId: created.id, revision: 2 },
    ack: () => { staleAck += 1; }, retry: () => assert.fail("stale job should not retry")
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
  const message = () => ({
    id: crypto.randomUUID(), body: { type: "analyze-response", responseId: created.id, revision: 1 },
    ack: () => { acked += 1; }, retry: () => assert.fail("valid job should not retry")
  });
  await worker.queue({ messages: [message(), message()] }, aiEnv);
  assert.equal(acked, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM analysis_runs WHERE response_id = ? AND response_revision = 1").get(created.id).n, 1);
  const stored = database.prepare("SELECT analysis_status AS status FROM responses WHERE id = ?").get(created.id);
  assert.equal(stored.status, "completed");
  database.close();
});
