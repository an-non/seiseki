import fs from "node:fs";

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, oldText, newText, label) {
  if (text.includes(newText)) return text;
  if (!text.includes(oldText)) throw new Error(`${label}: marker not found`);
  return text.replace(oldText, newText);
}

// Validation helpers for optimistic updates.
{
  const path = "cloudflare/src/validation.mjs";
  let text = read(path);
  if (!text.includes("export function normalizeExpectedRevision")) {
    const marker = "\nexport function createResponseId";
    const addition = `
export function normalizeExpectedRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new RequestError(400, "INVALID_REVISION", "expectedRevision must be a positive integer");
  }
  return revision;
}

export function normalizeFreeTextUpdate(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "freeText"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", `unsupported field: ${key}`);
  }
  return Object.freeze({
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
    freeText: cleanText(body.freeText, 1500, "freeText")
  });
}

export function normalizeAnswersUpdate(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "answers"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", `unsupported field: ${key}`);
  }
  const answerInput = requireObject(body.answers, "answers");
  const answers = [];
  for (const [rawQid, rawValue] of Object.entries(answerInput)) {
    const qid = cleanText(rawQid, 64, "answer qid", true);
    const value = cleanText(rawValue, 60, `answers.${qid}`, true);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(qid)) {
      throw new RequestError(400, "INVALID_FIELD", `answers.${qid} has an invalid qid`);
    }
    answers.push(Object.freeze({ qid, value }));
  }
  if (answers.length > 100) throw new RequestError(400, "INVALID_FIELD", "too many answers");
  return Object.freeze({ expectedRevision: normalizeExpectedRevision(body.expectedRevision), answers: Object.freeze(answers) });
}
`;
    if (!text.includes(marker)) throw new Error("validation insertion marker not found");
    text = text.replace(marker, addition + marker);
  }
  write(path, text);
}

// DB CAS updates. Every destructive statement is guarded by the old revision and the
// revision bump is last in the batch, so a stale request leaves no partial mutation.
{
  const path = "cloudflare/src/db.mjs";
  let text = read(path);
  if (!text.includes("export async function getResponseQuestionSnapshot")) {
    const marker = "\nexport async function deleteResponse";
    const addition = `
export async function getResponseQuestionSnapshot(db, id) {
  const rows = await db.prepare(\`
    SELECT qid, position, type, text, options_json AS optionsJson,
           left_label AS leftLabel, right_label AS rightLabel
    FROM response_questions
    WHERE response_id = ?
    ORDER BY position
  \`).bind(id).all();
  return (rows.results ?? []).map(row => {
    let options = [];
    try { options = JSON.parse(row.optionsJson); } catch { options = []; }
    return { id: row.qid, qid: row.qid, position: row.position, type: row.type, text: row.text, options, left: row.leftLabel || "", right: row.rightLabel || "" };
  });
}

function expectedRevisionGuard() {
  return "EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ?)";
}

export async function updateResponseFreeText(db, id, expectedRevision, freeText) {
  const now = Date.now();
  const guard = expectedRevisionGuard();
  const statements = [
    db.prepare(\`DELETE FROM opinion_chunks WHERE response_id = ? AND \${guard}\`)
      .bind(id, id, expectedRevision),
    db.prepare(\`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = 'SUPERSEDED_REVISION', lease_until = NULL
      WHERE response_id = ? AND response_revision = ? AND status = 'running' AND \${guard}
    \`).bind(now, id, expectedRevision, id, expectedRevision),
    db.prepare(\`
      UPDATE responses
      SET free_text = ?, revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(freeText, id, expectedRevision)
  ];
  const results = await db.batch(statements);
  if (Number(results?.[2]?.meta?.changes ?? 0) !== 1) return null;
  return expectedRevision + 1;
}

export async function updateResponseAnswers(db, id, expectedRevision, answers) {
  const now = Date.now();
  const guard = expectedRevisionGuard();
  const statements = [
    db.prepare(\`DELETE FROM answers WHERE response_id = ? AND \${guard}\`)
      .bind(id, id, expectedRevision)
  ];
  for (const answer of answers) {
    statements.push(db.prepare(\`
      INSERT INTO answers (response_id, qid, value)
      SELECT ?, ?, ? WHERE \${guard}
    \`).bind(id, answer.qid, answer.value, id, expectedRevision));
  }
  statements.push(
    db.prepare(\`DELETE FROM opinion_chunks WHERE response_id = ? AND \${guard}\`)
      .bind(id, id, expectedRevision),
    db.prepare(\`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = 'SUPERSEDED_REVISION', lease_until = NULL
      WHERE response_id = ? AND response_revision = ? AND status = 'running' AND \${guard}
    \`).bind(now, id, expectedRevision, id, expectedRevision),
    db.prepare(\`
      UPDATE responses
      SET revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(id, expectedRevision)
  );
  const results = await db.batch(statements);
  const final = results?.[results.length - 1];
  if (Number(final?.meta?.changes ?? 0) !== 1) return null;
  return expectedRevision + 1;
}
`;
    if (!text.includes(marker)) throw new Error("db update insertion marker not found");
    text = text.replace(marker, addition + marker);
  }
  write(path, text);
}

// Worker routes, strict bearer boundary, and revision-aware requeue recovery.
{
  const path = "cloudflare/src/index.mjs";
  let text = read(path);
  text = replaceExact(text,
`  deleteResponse,
  getBasicStats,
  getResponseMetadata,
  insertPendingResponse,
  listPublicDemoResponses`,
`  deleteResponse,
  getBasicStats,
  getResponseMetadata,
  getResponseQuestionSnapshot,
  insertPendingResponse,
  listPublicDemoResponses,
  updateResponseAnswers,
  updateResponseFreeText`,
    "db imports"
  );
  text = replaceExact(text,
`import { createResponseId, normalizeSubmission, RequestError } from "./validation.mjs";`,
`import {
  createResponseId,
  normalizeAnswersUpdate,
  normalizeExpectedRevision,
  normalizeFreeTextUpdate,
  normalizeSubmission,
  RequestError
} from "./validation.mjs";`,
    "validation imports"
  );
  text = replaceExact(text,
`  const account = await authenticateRequest(env.DB, request, false);`,
`  const account = await authenticateRequest(env.DB, request, request.headers.has("authorization"));`,
    "strict bearer on create"
  );

  if (!text.includes("function routeFreeTextId")) {
    const marker = "\nasync function readJson(request) {";
    const addition = `
function routeFreeTextId(pathname) {
  const match = pathname.match(/^\\/api\\/responses\\/(r_[A-Za-z0-9_-]{12,62})\\/free-text$/u);
  return match ? match[1] : null;
}

function routeAnswersId(pathname) {
  const match = pathname.match(/^\\/api\\/responses\\/(r_[A-Za-z0-9_-]{12,62})\\/answers$/u);
  return match ? match[1] : null;
}

function routeRequeueId(pathname) {
  const match = pathname.match(/^\\/api\\/responses\\/(r_[A-Za-z0-9_-]{12,62})\\/analysis\\/requeue$/u);
  return match ? match[1] : null;
}
`;
    if (!text.includes(marker)) throw new Error("route insertion marker not found");
    text = text.replace(marker, addition + marker);
  }

  if (!text.includes("async function enqueueAnalysisRevision")) {
    const marker = "\nasync function handleRequest(request, env, ctx) {";
    const addition = `
async function enqueueAnalysisRevision(env, responseId, revision) {
  if (!env.ANALYSIS_QUEUE?.send) {
    throw new RequestError(503, "ANALYSIS_QUEUE_UNAVAILABLE", "analysis queue is not available");
  }
  try {
    await env.ANALYSIS_QUEUE.send({ type: "analyze-response", responseId, revision });
  } catch (error) {
    console.error(JSON.stringify({
      event: "analysis_enqueue_failed",
      responseId,
      revision,
      error: String(error?.message ?? "unknown").slice(0, 160)
    }));
    throw new RequestError(503, "ANALYSIS_ENQUEUE_FAILED", "analysis could not be queued");
  }
}

function dispatchUpdatedAnalysis(env, ctx, responseId, revision) {
  if (String(env.AI_ANALYSIS_ENABLED).toLowerCase() !== "true" || !ctx) return;
  ctx.waitUntil((async () => {
    try {
      await enqueueAnalysisRevision(env, responseId, revision);
    } catch (error) {
      console.error(JSON.stringify({ event: "analysis_update_enqueue_pending", responseId, revision, code: error?.code || "UNKNOWN" }));
    }
  })());
}
`;
    if (!text.includes(marker)) throw new Error("enqueue helper marker not found");
    text = text.replace(marker, addition + marker);
  }

  if (!text.includes("const freeTextId = routeFreeTextId")) {
    const marker = `  const analysisId = routeAnalysisId(url.pathname);`;
    const routes = `  const freeTextId = routeFreeTextId(url.pathname);
  if (freeTextId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, freeTextId);
    const input = normalizeFreeTextUpdate(await readJson(request));
    const nextRevision = await updateResponseFreeText(env.DB, freeTextId, input.expectedRevision, input.freeText);
    if (nextRevision == null) throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    dispatchUpdatedAnalysis(env, ctx, freeTextId, nextRevision);
    return json({ id: freeTextId, revision: nextRevision, analysisStatus: "pending" });
  }

  const answersId = routeAnswersId(url.pathname);
  if (answersId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, answersId);
    const input = normalizeAnswersUpdate(await readJson(request));
    const snapshot = await getResponseQuestionSnapshot(env.DB, answersId);
    if (!snapshot.length || input.answers.length !== snapshot.length || !validateAnswersAgainstQuestions(input.answers, snapshot, false)) {
      throw new RequestError(400, "INVALID_ANSWER", "answers do not match the saved question snapshot");
    }
    const nextRevision = await updateResponseAnswers(env.DB, answersId, input.expectedRevision, input.answers);
    if (nextRevision == null) throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    dispatchUpdatedAnalysis(env, ctx, answersId, nextRevision);
    return json({ id: answersId, revision: nextRevision, analysisStatus: "pending" });
  }

  const requeueId = routeRequeueId(url.pathname);
  if (requeueId && request.method === "POST") {
    await authorizeResponseAccess(env.DB, request, requeueId);
    const body = await readJson(request);
    const expectedRevision = normalizeExpectedRevision(body?.expectedRevision);
    const current = await getResponseMetadata(env.DB, requeueId);
    if (!current) throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (Number(current.revision ?? 1) !== expectedRevision) {
      throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    }
    if (current.analysisStatus !== "pending") {
      throw new RequestError(409, "ANALYSIS_NOT_PENDING", "only a pending analysis can be requeued");
    }
    await enqueueAnalysisRevision(env, requeueId, expectedRevision);
    return json({ id: requeueId, revision: expectedRevision, analysisStatus: "pending", queued: true }, 202);
  }

`;
    if (!text.includes(marker)) throw new Error("response route insertion marker not found");
    text = text.replace(marker, routes + marker);
  }
  write(path, text);
}

// Backend tests for C1/B3/C3 and CAS behavior.
{
  const path = "cloudflare/tests/response-phase4-backend.test.mjs";
  const test = `import assert from "node:assert/strict";
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
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql"]) {
    database.exec(readFileSync(new URL(\`../migrations/\${name}\`, import.meta.url), "utf8"));
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
  const r = await worker.fetch(new Request("http://local/api/accounts/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: "correct-horse-1" }) }), env);
  assert.equal(r.status, 201); return r.json();
}
async function create(env, token, ctx) {
  return worker.fetch(new Request("http://local/api/responses", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer \${token}` } : {}) }, body: JSON.stringify(submission()) }), env, ctx);
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
  const owner = await register(env, "編集所有者"); const createdResponse = await create(env, owner.token, { waitUntil: p => waits.push(p) });
  const created = await createdResponse.json(); await Promise.all(waits); waits.length = 0;
  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'旧','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  const r = await worker.fetch(new Request(`http://local/api/responses/\${created.id}/free-text`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer \${owner.token}` }, body: JSON.stringify({ expectedRevision: 1, freeText: "更新済み本文" }) }), env, { waitUntil: p => waits.push(p) });
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
  const before = database.prepare("SELECT free_text AS t FROM responses WHERE id=?").get(created.id).t;
  const r = await worker.fetch(new Request(`http://local/api/responses/\${created.id}/free-text`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer \${owner.token}` }, body: JSON.stringify({ expectedRevision: 1, freeText: "上書きされない" }) }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "REVISION_CONFLICT");
  assert.equal(database.prepare("SELECT free_text AS t FROM responses WHERE id=?").get(created.id).t, before);
  database.close();
});

test("answers PATCH validates saved question snapshot and replaces answers at one new revision", async () => {
  const database = createDatabase(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "回答編集者"); const cr = await create(env, owner.token); const created = await cr.json();
  const good = await worker.fetch(new Request(`http://local/api/responses/\${created.id}/answers`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer \${owner.token}` }, body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" } }) }), env);
  assert.equal(good.status, 200); assert.equal((await good.json()).revision, 2);
  const rows = database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id);
  assert.deepEqual(rows.map(x => [x.qid,x.value]), [["q_econ","5"],["q_priority","経済・雇用"],["q_support","支持しない"]]);
  const bad = await worker.fetch(new Request(`http://local/api/responses/\${created.id}/answers`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer \${owner.token}` }, body: JSON.stringify({ expectedRevision: 2, answers: { q_support: "存在しない選択肢", q_priority: "経済・雇用", q_econ: "5" } }) }), env);
  assert.equal(bad.status, 400);
  database.close();
});

test("pending current revision can be requeued with authorization", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const r = await worker.fetch(new Request(`http://local/api/responses/\${created.id}/analysis/requeue`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  database.close();
});
`;
  write(path, test);
}

console.log("Applied Phase 4 backend update API and recovery boundaries.");
