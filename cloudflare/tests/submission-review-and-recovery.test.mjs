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
    "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql",
    "0007_response_updated_at.sql", "0008_response_follow_up_text.sql", "0008_questionnaire_seven_structured.sql",
    "0009_analysis_cache.sql", "0010_submission_review.sql", "0011_account_recovery.sql",
    "0012_short_submission_fingerprints.sql"
  ]) database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  return database;
}

test("short fingerprint migration preserves existing fingerprints", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE responses (id TEXT PRIMARY KEY, analysis_status TEXT, demo_flag INTEGER)");
  database.exec(readFileSync(new URL("../migrations/0010_submission_review.sql", import.meta.url), "utf8"));
  database.prepare("INSERT INTO responses (id) VALUES (?)").run("existing");
  database.prepare(`
    INSERT INTO response_text_fingerprints (response_id, input_hmac, normalized_length, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("existing", "a".repeat(64), 40, 1);

  database.exec(readFileSync(new URL("../migrations/0012_short_submission_fingerprints.sql", import.meta.url), "utf8"));
  const preserved = database.prepare("SELECT response_id AS responseId, normalized_length AS normalizedLength FROM response_text_fingerprints").get();
  assert.equal(preserved.responseId, "existing");
  assert.equal(preserved.normalizedLength, 40);
  database.prepare("INSERT INTO responses (id) VALUES (?)").run("short");
  database.prepare(`
    INSERT INTO response_text_fingerprints (response_id, input_hmac, normalized_length, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("short", "b".repeat(64), 8, 2);
  database.close();
});

function request(path, method = "GET", body = null, token = null, ip = "192.0.2.10") {
  const headers = { "CF-Connecting-IP": ip };
  if (body !== null) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://local${path}`, {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
}

function submission(text) {
  return {
    appVersion: "0.16.0",
    consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: {
      age: "30代", gender: "回答しない", region: "関東",
      occupation: "会社員(正社員)", party: "支持政党なし"
    },
    answers: {
      q_support: "わからない", q_priority: "子育て・教育", q_econ: "3",
      q_information: "わからない", q_social: "3", q_life: "わからない",
      q_participation: "わからない"
    },
    freeText: text
  };
}

async function register(env, name, ip) {
  const response = await worker.fetch(request("/api/accounts/register", "POST", {
    name,
    password: "correct-horse-1"
  }, null, ip), env);
  assert.equal(response.status, 201);
  return response.json();
}

test("cross-account exact text is retained but held out of public aggregates", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    SUBMISSION_FINGERPRINT_HMAC_SECRET: "test-only-submission-secret-with-32-characters"
  };
  const firstAccount = await register(env, "投稿者一", "192.0.2.11");
  const secondAccount = await register(env, "投稿者二", "192.0.2.12");
  const text = "教育予算の配分を見直し、地域にかかわらず学習機会を保障する制度が必要です。教員配置と教材費も継続して支援してください。";

  const firstResponse = await worker.fetch(request("/api/responses", "POST", submission(text), firstAccount.token, "192.0.2.11"), env);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201);
  assert.equal(first.publicationStatus, "accepted");

  const duplicateResponse = await worker.fetch(request("/api/responses", "POST", submission(`  ${text}  `), secondAccount.token, "192.0.2.12"), env);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 201);
  assert.equal(duplicate.publicationStatus, "held_duplicate");
  assert.equal(database.prepare("SELECT publication_status AS status FROM responses WHERE id = ?").get(duplicate.id).status, "held_duplicate");

  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json=? WHERE id IN (?, ?)")
    .run(JSON.stringify({ params: { emo: { pol: 0, label: "中立" }, valid: 50, crit: 50, motiv: 50 }, ideology: { econ: 0, soc: 0, confidence: 20 }, attrs: [], chunks: [] }), first.id, duplicate.id);
  const stats = await worker.fetch(request("/api/stats"), env);
  assert.equal((await stats.json()).responses, 1);
  database.close();
});

test("cross-account exact short text is held once it reaches the configurable minimum", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    SUBMISSION_FINGERPRINT_HMAC_SECRET: "test-only-submission-secret-with-32-characters"
  };
  const firstAccount = await register(env, "短文投稿者一", "192.0.2.41");
  const secondAccount = await register(env, "短文投稿者二", "192.0.2.42");
  const text = "がんばろう！社会党！";

  const firstResponse = await worker.fetch(request("/api/responses", "POST", submission(text), firstAccount.token, "192.0.2.41"), env);
  assert.equal(firstResponse.status, 201);
  assert.equal((await firstResponse.json()).publicationStatus, "accepted");

  const duplicateResponse = await worker.fetch(request("/api/responses", "POST", submission(text), secondAccount.token, "192.0.2.42"), env);
  assert.equal(duplicateResponse.status, 201);
  assert.equal((await duplicateResponse.json()).publicationStatus, "held_duplicate");
  database.close();
});

test("held duplicate is not dispatched to Workers AI and reports a terminal hold state", async () => {
  const database = createDatabase();
  const queued = [];
  const pending = [];
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    ANALYSIS_QUEUE: { send: async message => { queued.push(message); } },
    SUBMISSION_FINGERPRINT_HMAC_SECRET: "test-only-submission-secret-with-32-characters"
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const firstAccount = await register(env, "queue-first", "192.0.2.31");
  const secondAccount = await register(env, "queue-second", "192.0.2.32");
  const text = "This exact submission is deliberately longer than forty characters for duplicate queue testing.";

  const firstResponse = await worker.fetch(
    request("/api/responses", "POST", submission(text), firstAccount.token, "192.0.2.31"),
    env,
    ctx
  );
  const first = await firstResponse.json();
  await Promise.all(pending.splice(0));
  assert.equal(first.publicationStatus, "accepted");
  assert.equal(queued.length, 1);

  const duplicateResponse = await worker.fetch(
    request("/api/responses", "POST", submission(text), secondAccount.token, "192.0.2.32"),
    env,
    ctx
  );
  const duplicate = await duplicateResponse.json();
  await Promise.all(pending.splice(0));
  assert.equal(duplicate.publicationStatus, "held_duplicate");
  assert.equal(duplicate.analysisStatus, "held");
  assert.equal(queued.length, 1);

  const analysisResponse = await worker.fetch(
    request(`/api/responses/${duplicate.id}/analysis`, "GET", null, secondAccount.token, "192.0.2.32"),
    env,
    ctx
  );
  const analysis = await analysisResponse.json();
  assert.equal(analysis.analysisStatus, "held");
  assert.equal(analysis.publicationStatus, "held_duplicate");
  assert.equal(analysis.retryable, false);
  database.close();
});

test("one-time recovery code resets password, sessions, and itself", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false", PASSWORD_ITERATIONS: "30000" };
  const registered = await register(env, "復旧利用者", "192.0.2.21");
  assert.match(registered.recoveryCode, /^[A-Za-z0-9_-]{40,64}$/u);

  const recoveredResponse = await worker.fetch(request("/api/accounts/recover", "POST", {
    name: "復旧利用者",
    recoveryCode: registered.recoveryCode,
    newPassword: "new-correct-horse-2"
  }, null, "192.0.2.22"), env);
  assert.equal(recoveredResponse.status, 200);
  const recovered = await recoveredResponse.json();
  assert.match(recovered.recoveryCode, /^[A-Za-z0-9_-]{40,64}$/u);
  assert.notEqual(recovered.recoveryCode, registered.recoveryCode);

  const oldSession = await worker.fetch(request("/api/accounts/me", "GET", null, registered.token), env);
  assert.equal(oldSession.status, 401);
  const oldPassword = await worker.fetch(request("/api/accounts/login", "POST", {
    name: "復旧利用者", password: "correct-horse-1"
  }, null, "192.0.2.23"), env);
  assert.equal(oldPassword.status, 401);
  const newPassword = await worker.fetch(request("/api/accounts/login", "POST", {
    name: "復旧利用者", password: "new-correct-horse-2"
  }, null, "192.0.2.24"), env);
  assert.equal(newPassword.status, 200);

  const reused = await worker.fetch(request("/api/accounts/recover", "POST", {
    name: "復旧利用者", recoveryCode: registered.recoveryCode, newPassword: "third-correct-horse-3"
  }, null, "192.0.2.25"), env);
  assert.equal(reused.status, 401);
  assert.equal((await reused.json()).error, "RECOVERY_INVALID");
  database.close();
});
