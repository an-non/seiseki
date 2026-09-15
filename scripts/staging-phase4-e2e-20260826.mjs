const base = String(process.env.STAGING_BASE || "https://seiseki-api-staging.tokyo-odh-129.workers.dev").replace(/\/+$/u, "");
const password = "E2e-pass-20260826!";
const accountName = `e2e${Date.now().toString(36)}`.slice(0, 20);
const log = [];
let token = "";
let responseId = "";
let initialAggregateTotal = null;
let cleanupError = null;

function record(step, detail = {}) {
  const row = { step, ...detail };
  log.push(row);
  console.log(JSON.stringify(row));
}

async function request(path, { method = "GET", body, auth = token, expected, allow = [] } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${auth}`;
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  const accepted = expected == null ? response.ok : response.status === expected || allow.includes(response.status);
  if (!accepted) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { status: response.status, payload, headers: response.headers };
}

function answersFromQuestions(questions, alternate = false) {
  const out = {};
  for (const q of questions || []) {
    if (q?.type === "free") continue;
    if (!Array.isArray(q?.options) || q.options.length < 1) throw new Error(`question ${q?.id || "?"} has no options`);
    out[q.id] = alternate ? q.options.at(-1) : q.options[0];
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
    if (Number(payload?.revision) !== Number(revision)) {
      throw new Error(`analysis revision mismatch: wanted ${revision}, got ${payload?.revision}`);
    }
    if (payload?.analysisStatus === "completed") return payload;
    if (payload?.analysisStatus === "failed") throw new Error(`analysis failed: ${payload?.errorCode || "unknown"}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`analysis timeout for revision ${revision}: ${JSON.stringify(last)}`);
}

async function cleanup() {
  if (!token) return;
  try {
    const res = await request("/api/accounts/me", {
      method: "DELETE",
      body: { currentPassword: password },
      expected: 204
    });
    record("cleanup-account", { status: res.status });
  } catch (error) {
    cleanupError = error;
    record("cleanup-account-failed", { message: error.message });
  }
}

let mainError = null;
try {
  const health = await request("/api/health", { auth: "" });
  if (health.payload?.status !== "ok") throw new Error(`health not ok: ${JSON.stringify(health.payload)}`);
  record("health", health.payload);

  for (const route of ["/app", "/app/dashboard", "/app/quantum"]) {
    const res = await fetch(base + route, { redirect: "follow" });
    if (!res.ok) throw new Error(`${route} returned ${res.status}`);
    const html = await res.text();
    if (!html.includes("<html") && !html.includes("<!doctype")) throw new Error(`${route} did not return app HTML`);
    record("ui-route", { route, status: res.status, bytes: html.length });
  }

  const config = await request("/api/config", { auth: "" });
  const questions = config.payload?.questions || [];
  const initialAnswers = answersFromQuestions(questions, false);
  const alternateAnswers = answersFromQuestions(questions, true);
  if (!Object.keys(initialAnswers).length) throw new Error("no non-free questions available");
  record("config", { questions: questions.length, answerQuestions: Object.keys(initialAnswers).length });

  initialAggregateTotal = await aggregateTotal();
  if (!Number.isFinite(initialAggregateTotal) || initialAggregateTotal < 0) throw new Error("invalid public aggregate total");
  record("aggregate-baseline", { total: initialAggregateTotal });

  const registered = await request("/api/accounts/register", {
    method: "POST",
    auth: "",
    expected: 201,
    body: { name: accountName, password }
  });
  token = String(registered.payload?.token || "");
  if (!token) throw new Error("registration did not return a token");
  if (registered.payload?.account?.responseId != null) throw new Error("new account unexpectedly has responseId");
  record("register", { accountId: registered.payload?.account?.id });

  const submission = {
    appVersion: "0.16.0-e2e",
    consent: { accepted: true, version: "1.3", at: Date.now() },
    demo: {
      age: "30代",
      gender: "回答しない",
      region: "関東",
      occupation: "会社員(正社員)",
      party: "支持政党なし"
    },
    answers: initialAnswers,
    freeText: "staging E2E initial response. current-response revision flow verification."
  };

  const created = await request("/api/responses", {
    method: "POST",
    expected: 201,
    body: submission
  });
  responseId = String(created.payload?.id || "");
  if (!responseId || Number(created.payload?.revision) !== 1) throw new Error(`unexpected create payload: ${JSON.stringify(created.payload)}`);
  record("create", { responseId, revision: 1 });

  const duplicate = await request("/api/responses", {
    method: "POST",
    body: { ...submission, consent: { ...submission.consent, at: Date.now() } },
    expected: 409
  });
  if (duplicate.payload?.error !== "RESPONSE_ALREADY_EXISTS") throw new Error(`wrong duplicate error: ${JSON.stringify(duplicate.payload)}`);
  record("duplicate-create-rejected", { error: duplicate.payload.error });

  const patched = await request(`/api/responses/${responseId}/free-text`, {
    method: "PATCH",
    expected: 200,
    body: {
      expectedRevision: 1,
      freeText: "staging E2E updated response. revision two must supersede revision one analysis."
    }
  });
  if (Number(patched.payload?.revision) !== 2) throw new Error(`free-text PATCH did not produce revision 2: ${JSON.stringify(patched.payload)}`);
  record("free-text-patch", { revision: 2 });

  const stalePatch = await request(`/api/responses/${responseId}/free-text`, {
    method: "PATCH",
    expected: 409,
    body: { expectedRevision: 1, freeText: "this stale mutation must not win" }
  });
  if (stalePatch.payload?.error !== "REVISION_CONFLICT") throw new Error(`wrong stale PATCH error: ${JSON.stringify(stalePatch.payload)}`);
  record("stale-free-text-rejected", { error: stalePatch.payload.error });

  const pendingTotal = await aggregateTotal();
  if (pendingTotal !== initialAggregateTotal) {
    throw new Error(`pending response leaked into public aggregate: baseline=${initialAggregateTotal} now=${pendingTotal}`);
  }
  record("pending-hidden-from-public", { total: pendingTotal });

  const healthyPendingRetry = await request(`/api/responses/${responseId}/analysis/requeue`, {
    method: "POST",
    expected: 409,
    body: { expectedRevision: 2 }
  });
  if (healthyPendingRetry.payload?.error !== "ANALYSIS_NOT_RETRYABLE") {
    throw new Error(`wrong healthy pending retry error: ${JSON.stringify(healthyPendingRetry.payload)}`);
  }
  record("healthy-pending-retry-rejected", {
    status: healthyPendingRetry.status,
    error: healthyPendingRetry.payload.error,
    revision: 2
  });

  await waitForAnalysis(responseId, 2);
  record("analysis-completed", { revision: 2 });

  const completedTotal = await aggregateTotal();
  if (completedTotal !== initialAggregateTotal + 1) {
    throw new Error(`completed response missing from public aggregate: baseline=${initialAggregateTotal} now=${completedTotal}`);
  }
  record("completed-visible-in-public", { total: completedTotal });

  const answerPatch = await request(`/api/responses/${responseId}/answers`, {
    method: "PATCH",
    expected: 200,
    body: { expectedRevision: 2, answers: alternateAnswers }
  });
  if (Number(answerPatch.payload?.revision) !== 3) throw new Error(`answers PATCH did not produce revision 3: ${JSON.stringify(answerPatch.payload)}`);
  record("answers-patch", { revision: 3 });

  const staleAnswers = await request(`/api/responses/${responseId}/answers`, {
    method: "PATCH",
    expected: 409,
    body: { expectedRevision: 2, answers: initialAnswers }
  });
  if (staleAnswers.payload?.error !== "REVISION_CONFLICT") throw new Error(`wrong stale answers error: ${JSON.stringify(staleAnswers.payload)}`);
  record("stale-answers-rejected", { error: staleAnswers.payload.error });

  const rependingTotal = await aggregateTotal();
  if (rependingTotal !== initialAggregateTotal) {
    throw new Error(`revision 3 pending response leaked into public aggregate: baseline=${initialAggregateTotal} now=${rependingTotal}`);
  }
  record("updated-pending-hidden-from-public", { total: rependingTotal });

  await waitForAnalysis(responseId, 3);
  record("analysis-completed", { revision: 3 });

  const accountResponses = await request("/api/accounts/me/responses");
  const rows = accountResponses.payload?.responses || [];
  if (rows.length !== 1 || rows[0]?.id !== responseId || Number(rows[0]?.revision) !== 3) {
    throw new Error(`account current response mismatch: ${JSON.stringify(rows)}`);
  }
  record("account-current-response", { id: rows[0].id, revision: rows[0].revision, count: rows.length });

  const finalVisibleTotal = await aggregateTotal();
  if (finalVisibleTotal !== initialAggregateTotal + 1) {
    throw new Error(`revision 3 completed response missing from public aggregate: baseline=${initialAggregateTotal} now=${finalVisibleTotal}`);
  }
  record("revision3-visible-in-public", { total: finalVisibleTotal });
} catch (error) {
  mainError = error;
  record("failure", { message: error.message, status: error.status || null, payload: error.payload || null });
} finally {
  await cleanup();
}

if (initialAggregateTotal != null && !cleanupError) {
  try {
    const after = await aggregateTotal();
    if (after !== initialAggregateTotal) throw new Error(`public aggregate did not return to baseline: ${initialAggregateTotal} -> ${after}`);
    record("aggregate-restored", { total: after });
  } catch (error) {
    cleanupError = error;
    record("post-cleanup-check-failed", { message: error.message });
  }
}

console.log(JSON.stringify({ e2e: mainError || cleanupError ? "failed" : "passed", steps: log.length }));
if (mainError) throw mainError;
if (cleanupError) throw cleanupError;
