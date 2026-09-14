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
    "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql",
    "0010_submission_review.sql", "0011_account_recovery.sql"
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

test("JSON body limit applies when Content-Length is absent", async () => {
  const request = new Request("http://local/api/accounts/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "body-limit", password: "x".repeat(33 * 1024) })
  });
  assert.equal(request.headers.has("content-length"), false);
  const response = await worker.fetch(request, {
    DB: { prepare() { throw new Error("oversized input must not reach D1"); } }
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "BODY_TOO_LARGE");
});

test("Workers rate limiter rejects analysis submission before D1 is touched", async () => {
  let calls = 0;
  const env = {
    DB: {
      prepare() { throw new Error("D1 must not be touched after the platform gate rejects a request"); }
    },
    ANALYSIS_SUBMISSION_LIMITER: {
      async limit({ key }) {
        calls += 1;
        assert.match(key, /^[a-f0-9]{64}$/u);
        return { success: false };
      }
    }
  };
  const response = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.99"
    },
    body: JSON.stringify(validSubmission())
  }), env);
  assert.equal(calls, 1);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "ANALYSIS_RATE_LIMITED");
});

test("registration Turnstile is required independently from response submission", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    TURNSTILE_REGISTER_REQUIRED: "true",
    TURNSTILE_REGISTER_SECRET: "register-secret"
  };
  const response = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "登録試験", password: "correct-horse-1" })
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "TURNSTILE_REQUIRED");
  database.close();
});

test("registration Turnstile validates token action and hostname before account creation", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REGISTER_REQUIRED: "true",
    TURNSTILE_REGISTER_SECRET: "register-secret",
    TURNSTILE_REGISTER_HOSTNAME: "staging.example"
  };
  const originalFetch = globalThis.fetch;
  let verificationBody = null;
  globalThis.fetch = async (_url, options) => {
    verificationBody = options.body;
    return Response.json({ success: true, hostname: "staging.example", action: "register" });
  };
  try {
    const response = await worker.fetch(new Request("http://local/api/accounts/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "認証済試験", password: "correct-horse-1", turnstileToken: "verified-token" })
    }), env);
    assert.equal(response.status, 201);
    assert.equal(verificationBody.get("secret"), "register-secret");
    assert.equal(verificationBody.get("response"), "verified-token");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("password recovery Turnstile validates the recover action before changing credentials", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    PASSWORD_ITERATIONS: "30000",
    TURNSTILE_RECOVERY_REQUIRED: "true",
    TURNSTILE_RECOVERY_SECRET: "recovery-secret",
    TURNSTILE_RECOVERY_HOSTNAME: "staging.example"
  };
  const registeredResponse = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "復旧認証試験", password: "correct-horse-1" })
  }), env);
  const registered = await registeredResponse.json();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, hostname: "staging.example", action: "register" });
  try {
    const response = await worker.fetch(new Request("http://local/api/accounts/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "復旧認証試験",
        recoveryCode: registered.recoveryCode,
        newPassword: "new-correct-horse-2",
        turnstileToken: "wrong-action-token"
      })
    }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "TURNSTILE_ACTION_MISMATCH");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Turnstile tokens longer than the documented maximum are rejected without verification", async () => {
  const database = createDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("oversized token must not reach Siteverify"); };
  try {
    const response = await worker.fetch(new Request("http://local/api/accounts/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "長過認証試験", password: "correct-horse-1", turnstileToken: "x".repeat(2049) })
    }), {
      DB: new D1DatabaseAdapter(database),
      TURNSTILE_REGISTER_SECRET: "register-secret"
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "TURNSTILE_TOKEN_INVALID");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("public config exposes only registration and recovery site keys", async () => {
  const database = createDatabase();
  const response = await worker.fetch(new Request("http://local/api/config"), {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REGISTER_REQUIRED: "true",
    TURNSTILE_REGISTER_SITE_KEY: "public-site-key",
    TURNSTILE_REGISTER_SECRET: "must-not-leak",
    TURNSTILE_RECOVERY_REQUIRED: "true",
    TURNSTILE_RECOVERY_SITE_KEY: "public-recovery-key",
    TURNSTILE_RECOVERY_SECRET: "recovery-must-not-leak"
  });
  const body = await response.json();
  assert.deepEqual(body.turnstile, {
    registerSiteKey: "public-site-key",
    registerRequired: true,
    recoverySiteKey: "public-recovery-key",
    recoveryRequired: true
  });
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
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
  const payload = await lastResponse.json();
  assert.equal(payload.error, "RATE_LIMITED");
  assert.ok(Number(payload.retryAt) > Date.now());
  assert.ok(Number(lastResponse.headers.get("retry-after")) > 0);
  const rows = database.prepare("SELECT count(*) AS count FROM rate_limit_buckets").get();
  assert.ok(Number(rows.count) >= 2);
  database.close();
});
