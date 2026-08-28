const base = String(process.env.STAGING_BASE || "https://seiseki-api-staging.tokyo-odh-129.workers.dev").replace(/\/+$/u, "");
const password = "E2e-current-response-20260828!";
const accountName = `cur${Date.now().toString(36)}`.slice(0, 20);
let token = "";
let responseId = "";
let baseline = null;
let mainError = null;
let cleanupError = null;

function log(step, detail = {}) {
  console.log(JSON.stringify({ step, ...detail }));
}

async function request(path, { method = "GET", body, auth = token, expected } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${auth}`;
  const response = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  const ok = expected == null ? response.ok : response.status === expected;
  if (!ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { status: response.status, payload };
}

function answerSet(questions, useLast = false) {
  const out = {};
  for (const question of questions || []) {
    if (question?.type === "free") continue;
    if (!Array.isArray(question?.options) || question.options.length < 1) throw new Error(`question ${question?.id || "?"} has no options`);
    out[question.id] = useLast ? question.options.at(-1) : question.options[0];
  }
  return out;
}

async function aggregateTotal() {
  const { payload } = await request("/api/public-aggregate", { auth: "" });
  return Number(payload?.total ?? -1);
}

async function waitForAnalysis(id, revision, timeoutMs = 120000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const { payload } = await request(`/api/responses/${id}/analysis`);
    last = payload;
    if (Number(payload?.revision) !== Number(revision)) throw new Error(`analysis revision mismatch: expected ${revision}, got ${payload?.revision}`);
    if (payload?.analysisStatus === "completed") return payload;
    if (payload?.analysisStatus === "failed") throw new Error(`analysis failed for revision ${revision}: ${payload?.errorCode || "unknown"}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`analysis timeout revision ${revision}: ${JSON.stringify(last)}`);
}

async function current(expectedRevision, expectedFirst, expectedSecond, expectedAnswers, followUpSubmitted) {
  const { payload } = await request("/api/accounts/me/responses");
  const rows = payload?.responses || [];
  if (rows.length !== 1) throw new Error(`expected exactly one current response, got ${rows.length}`);
  const row = rows[0];
  if (row.id !== responseId) throw new Error(`response id mismatch ${row.id}`);
  if (Number(row.revision) !== Number(expectedRevision)) throw new Error(`revision mismatch ${row.revision}`);
  if (String(row.free || "") !== expectedFirst) throw new Error("first free text mismatch");
  if (Boolean(row.followUpSubmitted) !== Boolean(followUpSubmitted)) throw new Error(`follow-up submitted mismatch ${row.followUpSubmitted}`);
  if (followUpSubmitted && String(row.followUpText || "") !== expectedSecond) throw new Error("second free text mismatch");
  if (!followUpSubmitted && row.followUpText != null) throw new Error("withdrawn follow-up still exposed");
  for (const [qid, value] of Object.entries(expectedAnswers)) {
    if (String(row.answers?.[qid] || "") !== String(value)) throw new Error(`answer mismatch for ${qid}`);
  }
  return row;
}

async function cleanup() {
  if (!token) return;
  try {
    const result = await request("/api/accounts/me", { method: "DELETE", body: { currentPassword: password }, expected: 204 });
    log("cleanup-account", { status: result.status });
  } catch (error) {
    cleanupError = error;
    log("cleanup-account-failed", { message: error.message });
  }
}

try {
  const health = await request("/api/health", { auth: "" });
  if (health.payload?.status !== "ok") throw new Error("health is not ok");
  log("health", { status: health.payload.status });

  for (const route of ["/app", "/survey", "/survey/follow-up", "/account/response", "/app/quantum"]) {
    const response = await fetch(base + route, { redirect: "follow" });
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    const html = await response.text();
    if (!/<html|<!doctype/i.test(html)) throw new Error(`${route} did not return app html`);
    log("route", { route, status: response.status, bytes: html.length });
  }

  const adminPage = await fetch(base + "/api/staging-admin", { redirect: "follow" });
  if (adminPage.status !== 200) throw new Error(`staging admin page returned ${adminPage.status}`);
  log("staging-admin-page", { status: adminPage.status });

  const config = await request("/api/config", { auth: "" });
  const questions = config.payload?.questions || [];
  const initialAnswers = answerSet(questions, false);
  const correctedAnswers = answerSet(questions, true);
  if (Object.keys(initialAnswers).length !== 7) throw new Error(`expected seven structured questions, got ${Object.keys(initialAnswers).length}`);
  log("config-seven-questions", { count: Object.keys(initialAnswers).length });

  baseline = await aggregateTotal();
  if (!Number.isFinite(baseline) || baseline < 0) throw new Error("invalid aggregate baseline");
  log("aggregate-baseline", { total: baseline });

  const registered = await request("/api/accounts/register", { method: "POST", auth: "", expected: 201, body: { name: accountName, password } });
  token = String(registered.payload?.token || "");
  if (!token) throw new Error("registration returned no token");
  log("register", { ok: true });

  const firstText = "staging current response E2E first text";
  const created = await request("/api/responses", {
    method: "POST", expected: 201,
    body: {
      appVersion: "0.16.0-e2e",
      consent: { accepted: true, version: "1.4", at: Date.now() },
      demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
      answers: initialAnswers,
      freeText: firstText
    }
  });
  responseId = String(created.payload?.id || "");
  if (!responseId || Number(created.payload?.revision) !== 1) throw new Error(`unexpected create payload ${JSON.stringify(created.payload)}`);
  log("initial-created", { revision: 1 });
  await current(1, firstText, "", initialAnswers, false);

  const secondText = "staging current response E2E second text";
  const second = await request(`/api/responses/${responseId}/follow-up`, { method: "POST", expected: 201, body: { expectedRevision: 1, followUpText: secondText } });
  if (Number(second.payload?.revision) !== 2) throw new Error("follow-up did not advance to revision 2");
  await current(2, firstText, secondText, initialAnswers, true);
  await waitForAnalysis(responseId, 2);
  log("second-created-and-analyzed", { revision: 2 });

  const correctedFirst = "staging current response E2E corrected first text";
  const initialUpdate = await request(`/api/responses/${responseId}/initial`, {
    method: "PATCH", expected: 200,
    body: { expectedRevision: 2, answers: correctedAnswers, freeText: correctedFirst }
  });
  if (Number(initialUpdate.payload?.revision) !== 3) throw new Error(`initial update did not advance to revision 3: ${JSON.stringify(initialUpdate.payload)}`);
  await current(3, correctedFirst, secondText, correctedAnswers, true);
  log("initial-updated-preserving-second", { revision: 3 });

  const stale = await request(`/api/responses/${responseId}/initial`, {
    method: "PATCH", expected: 409,
    body: { expectedRevision: 2, answers: initialAnswers, freeText: "stale update must not win" }
  });
  if (stale.payload?.error !== "REVISION_CONFLICT") throw new Error(`wrong stale error ${JSON.stringify(stale.payload)}`);
  await current(3, correctedFirst, secondText, correctedAnswers, true);
  await waitForAnalysis(responseId, 3);
  log("stale-initial-rejected", { revision: 3 });

  const oldAnswersOnly = await request(`/api/responses/${responseId}/answers`, {
    method: "PATCH", expected: 410,
    body: { expectedRevision: 3, answers: correctedAnswers }
  });
  if (oldAnswersOnly.payload?.error !== "ANSWERS_ONLY_UPDATE_REMOVED") throw new Error(`wrong retired answers endpoint error ${JSON.stringify(oldAnswersOnly.payload)}`);
  log("answers-only-retired", { status: 410 });

  const withdrawn = await request(`/api/responses/${responseId}/follow-up`, {
    method: "DELETE", expected: 200,
    body: { expectedRevision: 3 }
  });
  if (Number(withdrawn.payload?.revision) !== 4 || withdrawn.payload?.followUpSubmitted !== false) throw new Error(`withdrawal payload mismatch ${JSON.stringify(withdrawn.payload)}`);
  await current(4, correctedFirst, "", correctedAnswers, false);
  await waitForAnalysis(responseId, 4);
  log("second-withdrawn-and-reanalyzed", { revision: 4 });

  const visible = await aggregateTotal();
  if (visible !== baseline + 1) throw new Error(`completed current response missing from aggregate: ${baseline} -> ${visible}`);
  log("completed-visible", { total: visible });
} catch (error) {
  mainError = error;
  log("failure", { message: error.message, status: error.status || null, payload: error.payload || null });
} finally {
  await cleanup();
}

if (baseline != null && !cleanupError) {
  try {
    const after = await aggregateTotal();
    if (after !== baseline) throw new Error(`aggregate not restored after cleanup: ${baseline} -> ${after}`);
    log("aggregate-restored", { total: after });
  } catch (error) {
    cleanupError = error;
    log("post-cleanup-failed", { message: error.message });
  }
}

if (mainError) throw mainError;
if (cleanupError) throw cleanupError;
console.log(JSON.stringify({ e2e: "passed" }));
