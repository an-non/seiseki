import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";

class D1StatementAdapter {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    const next = new D1StatementAdapter(this.database, this.sql);
    next.values = values;
    return next;
  }
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
      const result = statements.map(statement => statement.run());
      this.database.exec("COMMIT");
      return result;
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

function validSubmission() {
  return {
    appVersion: "0.15.3",
    consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: {
      age: "30代",
      gender: "回答しない",
      region: "関東",
      occupation: "会社員(正社員)",
      party: "支持政党なし"
    },
    answers: {
      q_support: "わからない",
      q_priority: "子育て・教育"
    },
    freeText: "制度について検討してほしい。"
  };
}

test("optional Turnstile mode permits a request with no client token even when a secret exists", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    TURNSTILE_SECRET: "configured-but-optional"
  };
  const response = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10"
    },
    body: JSON.stringify(validSubmission())
  }), env);
  assert.equal(response.status, 201);
  database.close();
});

test("required Turnstile mode fails closed if the secret is absent", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "true" };
  const response = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.11"
    },
    body: JSON.stringify(validSubmission())
  }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "TURNSTILE_NOT_CONFIGURED");
  database.close();
});

test("login attempts are limited before repeated password derivation", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  let lastResponse = null;
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    lastResponse = await worker.fetch(new Request("http://local/api/accounts/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.12"
      },
      body: JSON.stringify({ name: "ghost-account", password: "not-a-real-password" })
    }), env);
    if (attempt <= 10) assert.equal(lastResponse.status, 401);
  }
  assert.equal(lastResponse.status, 429);
  assert.equal((await lastResponse.json()).error, "RATE_LIMITED");
  const rows = database.prepare("SELECT count(*) AS count FROM rate_limit_buckets").get();
  assert.ok(Number(rows.count) >= 2);
  database.close();
});
