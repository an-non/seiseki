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
    const statement = new D1StatementAdapter(this.database, this.sql);
    statement.values = values;
    return statement;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1DatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }

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
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql"]) {
    const migration = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    database.exec(migration);
  }
  return database;
}

function submission() {
  return {
    appVersion: "0.15.2",
    consent: { accepted: true, version: "1.3", at: 1785744000000 },
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
    freeText: "教育制度について検討してほしい。",
    analysis: { params: { valid: 100 } },
    nodes: [{ id: "untrusted-node" }]
  };
}

test("Worker API stores a pending response and cascades its deletion", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };

  const health = await worker.fetch(new Request("http://local/api/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", database: "d1" });

  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env);
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.match(created.id, /^r_[a-f0-9]{32}$/u);
  assert.equal(created.analysisStatus, "pending");

  const stored = database.prepare(`
    SELECT free_text, analysis_status, analysis_json FROM responses WHERE id = ?
  `).get(created.id);
  assert.equal(stored.free_text, "教育制度について検討してほしい。");
  assert.equal(stored.analysis_status, "pending");
  assert.equal(stored.analysis_json, null);
  assert.equal(database.prepare("SELECT count(*) AS count FROM answers WHERE response_id = ?").get(created.id).count, 2);
  assert.equal(database.prepare("SELECT count(*) AS count FROM response_questions WHERE response_id = ?").get(created.id).count, 3);
  assert.equal(database.prepare("SELECT count(*) AS count FROM opinion_chunks WHERE response_id = ?").get(created.id).count, 0);

  const metadata = await worker.fetch(new Request(`http://local/api/responses/${created.id}`, {
    headers: { "x-response-manage-token": created.manageToken }
  }), env);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).analysisStatus, "pending");

  const stats = await worker.fetch(new Request("http://local/api/stats"), env);
  assert.equal(stats.status, 200);
  assert.deepEqual(await stats.json(), {
    responses: 1,
    opinionChunks: 0,
    analysis: { pending: 1 },
    answers: [
      { qid: "q_priority", value: "子育て・教育", count: 1 },
      { qid: "q_support", value: "わからない", count: 1 }
    ]
  });

  const remove = await worker.fetch(new Request(`http://local/api/responses/${created.id}`, {
    method: "DELETE",
    headers: { "x-response-manage-token": created.manageToken }
  }), env);
  assert.equal(remove.status, 204);
  assert.equal(database.prepare("SELECT count(*) AS count FROM responses").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM answers").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM response_questions").get().count, 0);
  database.close();
});

test("public config is loaded from D1 and invalid answers are rejected", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };

  const configResponse = await worker.fetch(new Request("http://local/api/config"), env);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.questions.find(question => question.id === "q_econ").left, "財政支出を拡大し再分配を強化すべき");

  const body = submission();
  body.answers.q_priority = "存在しない選択肢";
  const rejected = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "INVALID_ANSWER");
  assert.equal(database.prepare("SELECT count(*) AS count FROM responses").get().count, 0);
  database.close();
});

test("invalid submissions do not create database rows", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  const body = submission();
  body.consent.accepted = false;

  const response = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "CONSENT_REQUIRED");
  assert.equal(database.prepare("SELECT count(*) AS count FROM responses").get().count, 0);
  database.close();
});

test("public demo endpoint returns display data without raw text or source IDs", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };
  const body = submission();
  body.freeText = "公開してはいけない合成自由記述原文";
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
  const sourceId = (await create.json()).id;
  /* Demo classification is server-owned; emulate the trusted seed path instead
     of asking the public POST body to set demoFlag. */
  database.prepare("UPDATE responses SET demo_flag = 1 WHERE id = ?").run(sourceId);
  database.prepare("INSERT INTO answers (response_id, qid, value) VALUES (?, 'demo_batch', 'demo-test-v1')")
    .run(sourceId);
  const analysis = {
    params: { emo: { pol: -0.2, label: "懸念" }, valid: 70, crit: 65, motiv: 60 },
    ideology: { econ: -42, soc: 28, confidence: 76 },
    attrs: ["教育"],
    chunks: [{
      s: "教育制度の改善を求める", cat: "提言", topic: "教育", tt: "省庁", tn: "文部科学省",
      emo: -0.2, crit: 65, fact: "意見"
    }]
  };
  database.prepare("UPDATE responses SET analysis_status = 'completed', analysis_json = ? WHERE id = ?")
    .run(JSON.stringify(analysis), sourceId);

  const response = await worker.fetch(new Request("http://local/api/demo-responses"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.responses.length, 1);
  assert.equal(payload.responses[0].id, "remote-demo-1");
  assert.equal(payload.responses[0].free, "");
  assert.equal(payload.responses[0].answers.demo_batch, undefined);
  assert.deepEqual(payload.responses[0].analysis.ideology, { econ: -42, soc: 28, confidence: 76 });
  assert.equal(payload.responses[0].analysis.chunks[0].s, "教育制度の改善を求める");
  assert.equal(JSON.stringify(payload).includes(sourceId), false);
  assert.equal(JSON.stringify(payload).includes(body.freeText), false);
  database.close();
});

test("CORS permits only configured browser origins", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    ALLOWED_ORIGINS: "http://127.0.0.1:3000, http://localhost:3000, http://127.0.0.1:5173, http://localhost:5173"
  };

  const preflight = await worker.fetch(new Request("http://local/api/responses", {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:5173",
      "access-control-request-method": "POST"
    }
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/u);
  assert.match(preflight.headers.get("access-control-allow-methods"), /PATCH/u);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/u);

  const allowed = await worker.fetch(new Request("http://local/api/health", {
    headers: { origin: "http://127.0.0.1:3000" }
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");

  const denied = await worker.fetch(new Request("http://local/api/health", {
    headers: { origin: "https://untrusted.example" }
  }), env);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "ORIGIN_NOT_ALLOWED");
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  database.close();
});

test("account registration, login, update, response linking, and logout", async () => {
  const database = createDatabase();
  const env = { DB: new D1DatabaseAdapter(database), TURNSTILE_REQUIRED: "false" };

  const register = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "試験利用者", password: "correct-horse-1" })
  }), env);
  assert.equal(register.status, 201);
  const registered = await register.json();
  assert.equal(registered.account.name, "試験利用者");
  assert.match(registered.token, /^[A-Za-z0-9_-]{40,64}$/u);

  const auth = { authorization: `Bearer ${registered.token}` };
  const me = await worker.fetch(new Request("http://local/api/accounts/me", { headers: auth }), env);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.name, "試験利用者");

  const anonymousCreate = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env);
  assert.equal(anonymousCreate.status, 201);
  const anonymousResponseId = (await anonymousCreate.json()).id;

  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(submission())
  }), env);
  assert.equal(create.status, 201);
  const responseId = (await create.json()).id;

  const mine = await worker.fetch(new Request("http://local/api/accounts/me/responses", { headers: auth }), env);
  assert.equal(mine.status, 200);
  const minePayload = await mine.json();
  assert.deepEqual(minePayload.responses.map(item => item.id), [responseId]);
  assert.equal(minePayload.responses[0].free, submission().freeText);
  assert.equal(minePayload.responses[0].answers.q_priority, "子育て・教育");
  assert.deepEqual(minePayload.responses[0].questions, [
    {
      id: "q_support", qid: "q_support", position: 0, type: "single",
      text: "現在の政権を支持しますか？",
      options: ["支持する", "どちらかといえば支持する", "どちらかといえば支持しない", "支持しない", "わからない"],
      left: "", right: ""
    },
    {
      id: "q_priority", qid: "q_priority", position: 1, type: "single",
      text: "いま最も重視する政策分野はどれですか？",
      options: ["経済・雇用", "社会保障・医療", "子育て・教育", "外交・安全保障", "環境・エネルギー", "行政改革・政治とカネ", "その他"],
      left: "", right: ""
    },
    {
      id: "q_econ", qid: "q_econ", position: 2, type: "scale",
      text: "経済政策の方向性について、あなたの考えに近いのはどちらですか？",
      options: ["1", "2", "3", "4", "5"],
      left: "財政支出を拡大し再分配を強化すべき",
      right: "財政健全化と市場活力を優先すべき"
    }
  ]);
  assert.equal("freeText" in minePayload.responses[0], false);
  assert.equal(minePayload.responses.some(item => item.id === anonymousResponseId), false);
  assert.equal(database.prepare("SELECT count(*) AS count FROM account_responses WHERE response_id = ?")
    .get(anonymousResponseId).count, 0);

  const anonymousMine = await worker.fetch(new Request("http://local/api/accounts/me/responses"), env);
  assert.equal(anonymousMine.status, 401);

  const update = await worker.fetch(new Request("http://local/api/accounts/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      currentPassword: "correct-horse-1",
      name: "試験利用者二",
      newPassword: "correct-horse-2"
    })
  }), env);
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.account.name, "試験利用者二");
  assert.notEqual(updated.token, registered.token);

  const stale = await worker.fetch(new Request("http://local/api/accounts/me", { headers: auth }), env);
  assert.equal(stale.status, 401);
  const nextAuth = { authorization: `Bearer ${updated.token}` };
  const logout = await worker.fetch(new Request("http://local/api/accounts/logout", {
    method: "POST",
    headers: nextAuth
  }), env);
  assert.equal(logout.status, 204);
  const loggedOut = await worker.fetch(new Request("http://local/api/accounts/me", { headers: nextAuth }), env);
  assert.equal(loggedOut.status, 401);

  const relogin = await worker.fetch(new Request("http://local/api/accounts/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "試験利用者二", password: "correct-horse-2" })
  }), env);
  assert.equal(relogin.status, 200);
  const cleanupToken = (await relogin.json()).token;
  const removeAccount = await worker.fetch(new Request("http://local/api/accounts/me", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cleanupToken}`
    },
    body: JSON.stringify({ currentPassword: "correct-horse-2" })
  }), env);
  assert.equal(removeAccount.status, 204);
  assert.equal(database.prepare("SELECT count(*) AS count FROM accounts").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM account_sessions").get().count, 0);
  database.close();
});

test("staging KDF configuration stores 30000 iterations", async () => {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    PASSWORD_ITERATIONS: "30000"
  };
  const register = await worker.fetch(new Request("http://local/api/accounts/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "検証利用者", password: "staging-only-1" })
  }), env);
  assert.equal(register.status, 201);
  const registered = await register.json();
  const stored = database.prepare("SELECT password_iterations AS iterations FROM accounts WHERE id = ?")
    .get(registered.account.id);
  assert.equal(stored.iterations, 30000);
  database.close();
});

test("Workers AI output is validated and stored as neutral opinion chunks", async () => {
  const database = createDatabase();
  const pending = [];
  let aiRequest = null;
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "mock-model",
    AI_MAX_OUTPUT_TOKENS: "1800",
    AI: {
      async run(_model, request) {
        aiRequest = request;
        return {
          choices: [{ message: { content: {
            params: { emo: { pol: -0.4, label: "不満" }, valid: 72, crit: 83, motiv: 68 },
            attrs: ["教育", "子育て"],
            ideology: { econ: 100, soc: -100, confidence: 92 },
            chunks: [{
              s: "教育制度の改善を求める",
              cat: "提言",
              topic: "教育",
              tt: "省庁",
              tn: "文部科学省",
              emo: -0.4,
              crit: 83,
              fact: "意見"
            }]
          } } }]
        };
      }
    }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env, ctx);
  assert.equal(create.status, 201);
  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.all(pending);

  const prompt = aiRequest.messages.find(message => message.role === "user").content;
  assert.equal(aiRequest.max_tokens, 1800);
  assert.match(prompt, /年代:30代/u);
  assert.match(prompt, /現在の政権を支持しますか？ -> わからない/u);
  assert.match(prompt, /1=財政支出を拡大し再分配を強化すべき \.\.\. 5=財政健全化と市場活力を優先すべき/u);
  assert.equal(prompt.includes("[論点分割候補"), false);

  const analysisResponse = await worker.fetch(new Request(`http://local/api/responses/${responseId}/analysis`, { headers: responseAuthHeaders }), env);
  assert.equal(analysisResponse.status, 200);
  const analysis = await analysisResponse.json();
  assert.equal(analysis.analysisStatus, "completed");
  assert.equal(analysis.analysis.engine, "workers-ai-hybrid-v1");
  assert.deepEqual(analysis.analysis.ideology, { econ: 100, soc: -100, confidence: 92 });
  assert.equal(analysis.analysis.chunks.length, 1);
  assert.equal(analysis.analysis.chunks[0].topic, "教育");
  assert.equal(database.prepare("SELECT count(*) AS count FROM opinion_chunks WHERE response_id = ?").get(responseId).count, 1);
  assert.equal(database.prepare("SELECT status FROM analysis_runs WHERE response_id = ?").get(responseId).status, "completed");
  database.close();
});

test("Workers AI failures complete with deterministic rule fallback", async () => {
  const database = createDatabase();
  const pending = [];
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "missing-model",
    AI: { async run() { throw new Error("upstream private diagnostic"); } }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env, ctx);
  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.allSettled(pending);

  const response = await worker.fetch(new Request(`http://local/api/responses/${responseId}/analysis`, { headers: responseAuthHeaders }), env);
  const analysis = await response.json();
  assert.equal(analysis.analysisStatus, "completed");
  assert.equal(analysis.analysis.engine, "rules-fallback-v1");
  assert.equal(analysis.analysis.chunks.length, 1);
  assert.equal(analysis.analysis.chunks[0].topic, "教育");
  assert.equal(JSON.stringify(analysis).includes("private diagnostic"), false);
  assert.equal(database.prepare("SELECT status FROM analysis_runs WHERE response_id = ?").get(responseId).status, "completed");
  database.close();
});

test("rule fallback redacts contact details from stored public summaries", async () => {
  const database = createDatabase();
  const pending = [];
  const body = submission();
  body.freeText = "教育制度を改善してほしい。連絡先は test@example.com、090-1234-5678、〒100-0001です。";
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "missing-model",
    AI_MAX_ATTEMPTS: "1",
    AI: { async run() { throw new Error("unavailable"); } }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, ctx);
  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.all(pending);
  const summaries = database.prepare("SELECT summary FROM opinion_chunks WHERE response_id = ? ORDER BY id").all(responseId);
  const stored = summaries.map(row => row.summary).join(" ");
  assert.equal(stored.includes("test@example.com"), false);
  assert.equal(stored.includes("090-1234-5678"), false);
  assert.equal(stored.includes("100-0001"), false);
  assert.match(stored, /\[メール\]|\[電話番号\]|\[郵便番号\]/u);
  database.close();
});

test("Workers AI retries once before storing a valid result", async () => {
  const database = createDatabase();
  const pending = [];
  let calls = 0;
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "retry-model",
    AI_MAX_ATTEMPTS: "2",
    AI: { async run() {
      calls += 1;
      if (calls === 1) throw new Error("temporary upstream failure");
      return { response: {
        params: { emo: { pol: 0, label: "中立" }, valid: 60, crit: 50, motiv: 60 },
        ideology: { econ: 0, soc: 0, confidence: 0 },
        attrs: ["教育"],
        chunks: [{
          s: "教育制度について検討する", cat: "提言", topic: "教育", tt: "その他", tn: "",
          emo: 0, crit: 50, fact: "意見"
        }]
      } };
    } }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env, ctx);
  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.all(pending);
  const stored = await (await worker.fetch(new Request(`http://local/api/responses/${responseId}/analysis`, { headers: responseAuthHeaders }), env)).json();
  assert.equal(calls, 2);
  assert.equal(stored.analysisStatus, "completed");
  assert.equal(stored.analysis.engine, "workers-ai-hybrid-v1");
  database.close();
});

test("analysis queue defers processing and the consumer completes it", async () => {
  const database = createDatabase();
  const pending = [];
  const queued = [];
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "queue-model",
    ANALYSIS_QUEUE: { async send(body) { queued.push(body); } },
    AI: { async run() { return { response: {
      params: { emo: { pol: 0, label: "中立" }, valid: 60, crit: 50, motiv: 60 },
      ideology: { econ: 0, soc: 0, confidence: 0 },
      attrs: ["教育"],
      chunks: [{
        s: "教育制度について検討する", cat: "提言", topic: "教育", tt: "その他", tn: "",
        emo: 0, crit: 50, fact: "意見"
      }]
    } }; } }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const create = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env, ctx);
  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.all(pending);
  assert.deepEqual(queued, [{ type: "analyze-response", responseId, revision: 1 }]);
  assert.equal(database.prepare("SELECT analysis_status FROM responses WHERE id = ?").get(responseId).analysis_status, "pending");
  const waitingResponse = await worker.fetch(new Request(`http://local/api/responses/${responseId}/analysis`, { headers: responseAuthHeaders }), env);
  const waitingAnalysis = await waitingResponse.json();
  assert.equal(waitingAnalysis.analysisStatus, "pending");
  assert.equal(waitingAnalysis.analysis, null);

  let acknowledged = false;
  await worker.queue({ messages: [{
    id: "message-1",
    body: queued[0],
    attempts: 1,
    ack() { acknowledged = true; },
    retry() { throw new Error("unexpected retry"); }
  }] }, env);
  assert.equal(acknowledged, true);
  assert.equal(database.prepare("SELECT analysis_status FROM responses WHERE id = ?").get(responseId).analysis_status, "completed");
  const completedResponse = await worker.fetch(new Request(`http://local/api/responses/${responseId}/analysis`, { headers: responseAuthHeaders }), env);
  const completedAnalysis = await completedResponse.json();
  assert.equal(completedAnalysis.analysisStatus, "completed");
  assert.equal(completedAnalysis.analysis.chunks.length, 1);
  assert.equal(completedAnalysis.analysis.chunks[0].s, "教育制度について検討する");
  assert.equal(database.prepare("SELECT count(*) AS count FROM opinion_chunks WHERE response_id = ?").get(responseId).count, 1);
  database.close();
});

test("duplicate queue deliveries claim one analysis run and create one node set", async () => {
  const database = createDatabase();
  const pending = [];
  const queued = [];
  let aiCalls = 0;
  const env = {
    DB: new D1DatabaseAdapter(database),
    TURNSTILE_REQUIRED: "false",
    AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "duplicate-queue-model",
    ANALYSIS_QUEUE: { async send(body) { queued.push(body); } },
    AI: { async run() {
      aiCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { response: {
        params: { emo: { pol: 0, label: "中立" }, valid: 65, crit: 55, motiv: 60 },
        ideology: { econ: 0, soc: 0, confidence: 0 },
        attrs: ["教育"],
        chunks: [{
          s: "教育制度について検討する", cat: "提言", topic: "教育", tt: "その他", tn: "",
          emo: 0, crit: 55, fact: "意見"
        }]
      } };
    } }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const created = await worker.fetch(new Request("http://local/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission())
  }), env, ctx);
  const responseId = (await created.json()).id;
  await Promise.all(pending);

  let retries = 0;
  const message = () => ({
    id: crypto.randomUUID(), body: queued[0], attempts: 1,
    ack() {}, retry() { retries += 1; }
  });
  await Promise.all([
    worker.queue({ messages: [message()] }, env),
    worker.queue({ messages: [message()] }, env)
  ]);

  assert.equal(aiCalls, 1);
  assert.equal(retries, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM analysis_runs WHERE response_id = ?").get(responseId).count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM opinion_chunks WHERE response_id = ?").get(responseId).count, 1);
  assert.equal(database.prepare("SELECT analysis_status FROM responses WHERE id = ?").get(responseId).analysis_status, "completed");
  database.close();
});
