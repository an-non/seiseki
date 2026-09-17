import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { issueFormProof, verifyAndConsumeFormProof } from "../src/form-proof.mjs";

class Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.database, this.sql, values); }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function environment() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      hit_count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return {
    database,
    env: {
      DB: { prepare(sql) { return new Statement(database, sql); } },
      FORM_PROOF_REQUIRED: "true",
      RATE_LIMIT_FINGERPRINT_SECRET: "test-only-form-proof-secret-32-characters"
    }
  };
}

test("form proof accepts the intended action once after the minimum delay", async () => {
  const { database, env } = environment();
  const issued = await issueFormProof(env, "register", 1_800_000_000_000);
  assert.equal(issued.readyAt, 1_800_000_000_800);
  await verifyAndConsumeFormProof(env, {
    formProof: issued.token,
    companyWebsite: ""
  }, "register", 1_800_000_001_000);
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token }, "register", 1_800_000_002_000),
    error => error?.code === "FORM_PROOF_REPLAYED"
  );
  database.close();
});

test("form proof rejects honeypot input, immediate use, expiry, action mismatch and tampering", async () => {
  const { database, env } = environment();
  const now = 1_800_000_000_000;
  const issued = await issueFormProof(env, "recover", now);
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token, companyWebsite: "https://bot.example" }, "recover", now + 1_000),
    error => error?.code === "FORM_REJECTED"
  );
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token }, "recover", now + 100),
    error => error?.code === "FORM_PROOF_TOO_FAST"
  );
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token }, "register", now + 1_000),
    error => error?.code === "FORM_PROOF_ACTION_MISMATCH"
  );
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token.slice(0, -1) + "0" }, "recover", now + 1_000),
    error => error?.code === "FORM_PROOF_INVALID"
  );
  await assert.rejects(
    verifyAndConsumeFormProof(env, { formProof: issued.token }, "recover", issued.expiresAt + 1),
    error => error?.code === "FORM_PROOF_EXPIRED"
  );
  database.close();
});

test("form proof fails closed when the shared HMAC secret is missing", async () => {
  await assert.rejects(
    issueFormProof({ FORM_PROOF_REQUIRED: "true" }, "register", Date.now()),
    error => error?.code === "FORM_PROOF_NOT_CONFIGURED"
  );
});
