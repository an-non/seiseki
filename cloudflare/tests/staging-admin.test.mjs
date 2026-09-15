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
    "0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql",
    "0004_response_question_context.sql", "0005_rate_limits.sql",
    "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql", "0008_questionnaire_seven_structured.sql",
    "0010_submission_review.sql", "0011_account_recovery.sql"
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
}

function seedAccount(database) {
  const now = Date.now();
  const accountId = "u_11111111111111111111111111111111";
  const responseId = "r_abcdefghijklmnopqrstuvwx";
  database.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(accountId, "staging-user", "staging-user", "0".repeat(32), "1".repeat(64), 10000, now, now);
  database.prepare("INSERT INTO account_sessions VALUES (?, ?, ?, ?)")
    .run("2".repeat(64), accountId, now, now + 60000);
  database.prepare(`
    INSERT INTO responses (
      id, created_at, app_version, consent_version, consent_at, free_text,
      analysis_status, analysis_json, demo_flag, revision, updated_at
    ) VALUES (?, ?, 'test', 'v1', ?, 'private staging response', 'completed', '{}', 1, 2, ?)
  `).run(responseId, now, now, now);
  database.prepare("INSERT INTO account_responses VALUES (?, ?, ?)")
    .run(accountId, responseId, now);
  database.prepare("INSERT INTO answers VALUES (?, 'q_support', 'support')").run(responseId);
  database.prepare(`
    INSERT INTO opinion_chunks (
      response_id, created_at, summary, category, topic, target_type, target_name,
      emotion, criticality, fact_status, provenance_json
    ) VALUES (?, ?, 'summary', ?, 'policy', ?, '', 0, 50, ?, '{}')
  `).run(responseId, now, "\u63d0\u8a00", "\u653f\u5e9c\u5168\u822c", "\u610f\u898b");
  database.prepare(`
    INSERT INTO analysis_runs (
      response_id, engine, model, prompt_version, status, started_at, completed_at,
      response_revision, lease_until
    ) VALUES (?, 'test', 'test', 'v1', 'completed', ?, ?, 2, NULL)
  `).run(responseId, now, now);
  database.prepare(`
    INSERT INTO response_questions (
      response_id, qid, position, type, text, options_json, left_label, right_label
    ) VALUES (?, 'q_support', 0, 'single', 'support question', '["support","oppose"]', '', '')
  `).run(responseId);
  database.prepare("INSERT INTO response_access VALUES (?, ?, ?)")
    .run(responseId, "3".repeat(64), now);
  return { accountId, responseId };
}

function environment(database, overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(database),
    SEISEKI_ENV: "staging",
    STAGING_ADMIN_ENABLED: "true",
    STAGING_ADMIN_TOKEN: "local-test-token-value",
    TURNSTILE_REQUIRED: "false",
    ...overrides
  };
}

function adminHeaders(token = "local-test-token-value") {
  return { "x-seiseki-admin-token": token };
}

test("staging admin page is staging-only and contains no stored data", async () => {
  const database = createDatabase();
  seedAccount(database);
  const page = await worker.fetch(new Request("http://local/api/staging-admin"), environment(database));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /SEISEKI staging/iu);
  assert.match(html, /submission-reviews\?status=held_duplicate/iu);
  assert.match(html, /publicationStatus:\s*"accepted"/iu);
  assert.doesNotMatch(html, /staging-user|private staging response/iu);

  const production = await worker.fetch(new Request("http://local/api/staging-admin"), environment(database, {
    SEISEKI_ENV: "production",
    STAGING_ADMIN_ENABLED: "true"
  }));
  assert.equal(production.status, 404);
});

test("account list requires the staging secret and omits credentials and response text", async () => {
  const database = createDatabase();
  const seeded = seedAccount(database);
  const env = environment(database);
  const missing = await worker.fetch(new Request("http://local/api/staging-admin/accounts"), env);
  assert.equal(missing.status, 401);
  const wrong = await worker.fetch(new Request("http://local/api/staging-admin/accounts", {
    headers: adminHeaders("wrong-token")
  }), env);
  assert.equal(wrong.status, 401);
  const response = await worker.fetch(new Request("http://local/api/staging-admin/accounts", {
    headers: adminHeaders()
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.page.total, 1);
  assert.equal(body.accounts[0].id, seeded.accountId);
  assert.equal(body.accounts[0].name, "staging-user");
  assert.equal(body.accounts[0].response.id, seeded.responseId);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /private staging response|password|salt|hash|token/iu);
});

test("accepting a held pending response enqueues its current revision exactly once", async () => {
  const database = createDatabase();
  const seeded = seedAccount(database);
  database.prepare("DELETE FROM analysis_runs WHERE response_id = ?").run(seeded.responseId);
  database.prepare(`
    UPDATE responses
    SET publication_status = 'held_duplicate', analysis_status = 'pending', analysis_json = NULL
    WHERE id = ?
  `).run(seeded.responseId);
  const queued = [];
  const env = environment(database, {
    AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async message => { queued.push(message); } }
  });
  const url = `http://local/api/staging-admin/submission-reviews/${seeded.responseId}`;
  const options = {
    method: "PATCH",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ publicationStatus: "accepted" })
  };

  const accepted = await worker.fetch(new Request(url, options), env);
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.changed, true);
  assert.equal(acceptedBody.enqueued, true);
  assert.deepEqual(queued, [{ type: "analyze-response", responseId: seeded.responseId, revision: 2 }]);
  assert.equal(database.prepare("SELECT publication_status AS status FROM responses WHERE id = ?").get(seeded.responseId).status, "accepted");

  const repeated = await worker.fetch(new Request(url, options), env);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).enqueued, false);
  assert.equal(queued.length, 1);
});

test("failed held-response enqueue restores the hold instead of stranding an accepted response", async () => {
  const database = createDatabase();
  const seeded = seedAccount(database);
  database.prepare("DELETE FROM analysis_runs WHERE response_id = ?").run(seeded.responseId);
  database.prepare(`
    UPDATE responses
    SET publication_status = 'held_duplicate', analysis_status = 'pending', analysis_json = NULL
    WHERE id = ?
  `).run(seeded.responseId);
  const env = environment(database, {
    AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async () => { throw new Error("queue unavailable"); } }
  });
  const response = await worker.fetch(new Request(`http://local/api/staging-admin/submission-reviews/${seeded.responseId}`, {
    method: "PATCH",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ publicationStatus: "accepted" })
  }), env);
  assert.equal(response.status, 503);
  assert.equal(database.prepare("SELECT publication_status AS status FROM responses WHERE id = ?").get(seeded.responseId).status, "held_duplicate");
});

test("staging review endpoints backfill fingerprints and allow explicit adjudication without returning text", async () => {
  const database = createDatabase();
  const seeded = seedAccount(database);
  database.prepare("UPDATE responses SET free_text = ? WHERE id = ?")
    .run("同じ内容の大量投稿を検知するために十分な長さを持たせたステージング専用の回答本文です。本文は管理APIから返しません。", seeded.responseId);
  const env = environment(database, { SUBMISSION_FINGERPRINT_HMAC_SECRET: "s".repeat(48) });

  const backfill = await worker.fetch(new Request("http://local/api/staging-admin/submission-reviews/backfill", {
    method: "POST",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ limit: 20 })
  }), env);
  assert.equal(backfill.status, 200);
  assert.deepEqual(await backfill.json(), { processed: 1, held: 0, remainingMayExist: false });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM response_text_fingerprints").get().count, 1);

  const list = await worker.fetch(new Request("http://local/api/staging-admin/submission-reviews?status=all", {
    headers: adminHeaders()
  }), env);
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.reviews[0].responseId, seeded.responseId);
  assert.equal(listed.reviews[0].publicationStatus, "accepted");
  assert.equal(typeof listed.reviews[0].normalizedLength, "number");
  assert.doesNotMatch(JSON.stringify(listed), /ステージング専用の回答本文/iu);

  const hold = await worker.fetch(new Request(`http://local/api/staging-admin/submission-reviews/${seeded.responseId}`, {
    method: "PATCH",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ publicationStatus: "held_duplicate" })
  }), env);
  assert.equal(hold.status, 200);
  assert.equal((await hold.json()).publicationStatus, "held_duplicate");
  assert.equal(database.prepare("SELECT publication_status AS status FROM responses WHERE id = ?").get(seeded.responseId).status, "held_duplicate");
});

test("account deletion requires exact name confirmation and cascades all linked records", async () => {
  const database = createDatabase();
  const seeded = seedAccount(database);
  const env = environment(database);
  const url = `http://local/api/staging-admin/accounts/${seeded.accountId}`;
  const mismatch = await worker.fetch(new Request(url, {
    method: "DELETE",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ confirmName: "another-user" })
  }), env);
  assert.equal(mismatch.status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 1);

  const response = await worker.fetch(new Request(url, {
    method: "DELETE",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ confirmName: "staging-user" })
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, true);
  assert.deepEqual(body.deletedRecords, {
    responses: 1,
    sessions: 1,
    answers: 1,
    chunks: 1,
    analysisRuns: 1,
    questionSnapshots: 1,
    responseAccess: 1
  });
  for (const table of [
    "accounts", "account_sessions", "account_responses", "responses", "answers",
    "opinion_chunks", "analysis_runs", "response_questions", "response_access"
  ]) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test("enabled staging admin fails closed when the secret is not configured", async () => {
  const database = createDatabase();
  const env = environment(database);
  delete env.STAGING_ADMIN_TOKEN;
  const response = await worker.fetch(new Request("http://local/api/staging-admin/accounts", {
    headers: adminHeaders()
  }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "STAGING_ADMIN_NOT_CONFIGURED");
});
