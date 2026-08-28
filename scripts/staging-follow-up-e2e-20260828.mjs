const base = String(process.env.STAGING_BASE || "https://seiseki-api-staging.tokyo-odh-129.workers.dev").replace(/\/+$/u, "");
const password = "E2e-follow-up-20260828!";
const accountName = `fup${Date.now().toString(36)}`.slice(0, 20);
const log = [];
let token = "";
let responseId = "";
let aggregateBaseline = null;
let mainError = null;
let cleanupError = null;

function record(step, detail = {}) {
  const row = { step, ...detail };
  log.push(row);
  console.log(JSON.stringify(row));
}

async function request(path, { method = "GET", body, auth = token, expected } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${auth}`;
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  const accepted = expected == null ? response.ok : response.status === expected;
  if (!accepted) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { status: response.status, payload };
}

function answersFromQuestions(questions) {
  const out = {};
  for (const q of questions || []) {
    if (q?.type === "free") continue;
    if (!Array.isArray(q?.options) || q.options.length < 1) throw new Error(`question ${q?.id || "?"} has no options`);
    out[q.id] = q.options[0];
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

async function currentResponse(expectedRevision, expectedFirst, expectedSecond, expectedSubmitted = true) {
  const { payload } = await request("/api/accounts/me/responses");
  const rows = payload?.responses || [];
  if (rows.length !== 1) throw new Error(`expected one current response, got ${rows.length}`);
  const row = rows[0];
  if (String(row.id || "") !== responseId) throw new Error(`response id mismatch: ${row.id}`);
  if (Number(row.seq) !== 1) throw new Error(`seq must remain 1, got ${row.seq}`);
  if (Number(row.revision) !== Number(expectedRevision)) throw new Error(`revision mismatch: ${row.revision}`);
  if (String(row.free || "") !== expectedFirst) throw new Error(`first free text changed unexpectedly: ${JSON.stringify(row.free)}`);
  if (expectedSubmitted) {
    if (row.followUpSubmitted !== true) throw new Error("followUpSubmitted was not true");
    if (String(row.followUpText || "") !== expectedSecond) throw new Error(`second free text mismatch: ${JSON.stringify(row.followUpText)}`);
  } else if (row.followUpSubmitted === true || row.followUpText != null) {
    throw new Error("follow-up unexpectedly exists before submission");
  }
  return row;
}

async function cleanup() {
  if (!token) return;
  try {
    const result = await request("/api/accounts/me", {
      method: "DELETE",
      body: { currentPassword: password },
      expected: 204
    });
    record("cleanup-account", { status: result.status });
  } catch (error) {
    cleanupError = error;
    record("cleanup-account-failed", { message: error.message });
  }
}

try {
  const health = await request("/api/health", { auth: "" });
  if (health.payload?.status !== "ok") throw new Error(`health not ok: ${JSON.stringify(health.payload)}`);
  record("health", { status: health.payload.status });

  for (const route of ["/app", "/survey", "/survey/follow-up", "/account/response"]) {
    const response = await fetch(base + route, { redirect: "follow" });
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    const html = await response.text();
    if (!html.toLowerCase().includes("<html") && !html.toLowerCase().includes("<!doctype")) throw new Error(`${route} did not return app HTML`);
    record("ui-route", { route, status: response.status, bytes: html.length });
  }

  const config = await request("/api/config", { auth: "" });
  const answers = answersFromQuestions(config.payload?.questions || []);
  if (!Object.keys(answers).length) throw new Error("no non-free questions available");
  record("config", { answerQuestions: Object.keys(answers).length });

  aggregateBaseline = await aggregateTotal();
  if (!Number.isFinite(aggregateBaseline) || aggregateBaseline < 0) throw new Error("invalid public aggregate baseline");
  record("aggregate-baseline", { total: aggregateBaseline });

  const registered = await request("/api/accounts/register", {
    method: "POST",
    auth: "",
    expected: 201,
    body: { name: accountName, password }
  });
  token = String(registered.payload?.token || "");
  if (!token) throw new Error("registration did not return token");
  record("register", { ok: true });

  const firstText = "staging follow-up E2E first free text";
  const submission = {
    appVersion: "0.16.0-follow-up-e2e",
    consent: { accepted: true, version: "1.4", at: Date.now() },
    demo: {
      age: "30代",
      gender: "回答しない",
      region: "関東",
      occupation: "会社員(正社員)",
      party: "支持政党なし"
    },
    answers,
    freeText: firstText
  };

  const created = await request("/api/responses", { method: "POST", expected: 201, body: submission });
  responseId = String(created.payload?.id || "");
  if (!responseId || Number(created.payload?.revision) !== 1) throw new Error(`unexpected create payload: ${JSON.stringify(created.payload)}`);
  record("create-initial", { revision: 1 });

  await currentResponse(1, firstText, "", false);
  record("initial-separated", { revision: 1, followUpSubmitted: false });

  const secondText = "staging follow-up E2E second free text";
  const followUp = await request(`/api/responses/${responseId}/follow-up`, {
    method: "POST",
    expected: 201,
    body: { expectedRevision: 1, followUpText: secondText }
  });
  if (Number(followUp.payload?.revision) !== 2) throw new Error(`follow-up POST did not produce revision 2: ${JSON.stringify(followUp.payload)}`);
  record("follow-up-created", { revision: 2 });

  const duplicate = await request(`/api/responses/${responseId}/follow-up`, {
    method: "POST",
    expected: 409,
    body: { expectedRevision: 2, followUpText: "must not become a third submission" }
  });
  if (duplicate.payload?.error !== "FOLLOW_UP_ALREADY_EXISTS") throw new Error(`wrong duplicate follow-up error: ${JSON.stringify(duplicate.payload)}`);
  record("duplicate-follow-up-rejected", { error: duplicate.payload.error });

  await currentResponse(2, firstText, secondText, true);
  record("follow-up-separated", { revision: 2, seq: 1 });

  const pendingTotal = await aggregateTotal();
  if (pendingTotal !== aggregateBaseline) throw new Error(`pending revision leaked into public aggregate: ${aggregateBaseline} -> ${pendingTotal}`);
  record("pending-hidden-from-public", { total: pendingTotal });

  await waitForAnalysis(responseId, 2);
  record("analysis-completed", { revision: 2 });

  const correctedSecond = "staging follow-up E2E corrected second free text";
  const corrected = await request(`/api/responses/${responseId}/follow-up`, {
    method: "PATCH",
    expected: 200,
    body: { expectedRevision: 2, followUpText: correctedSecond }
  });
  if (Number(corrected.payload?.revision) !== 3) throw new Error(`follow-up PATCH did not produce revision 3: ${JSON.stringify(corrected.payload)}`);
  record("follow-up-corrected", { revision: 3 });

  const stale = await request(`/api/responses/${responseId}/follow-up`, {
    method: "PATCH",
    expected: 409,
    body: { expectedRevision: 2, followUpText: "stale correction must not win" }
  });
  if (stale.payload?.error !== "REVISION_CONFLICT") throw new Error(`wrong stale follow-up error: ${JSON.stringify(stale.payload)}`);
  record("stale-follow-up-rejected", { error: stale.payload.error });

  await currentResponse(3, firstText, correctedSecond, true);
  await waitForAnalysis(responseId, 3);
  record("analysis-completed", { revision: 3 });

  const correctedFirst = "staging follow-up E2E corrected first free text";
  const firstCorrection = await request(`/api/responses/${responseId}/free-text`, {
    method: "PATCH",
    expected: 200,
    body: { expectedRevision: 3, freeText: correctedFirst }
  });
  if (Number(firstCorrection.payload?.revision) !== 4) throw new Error(`first free-text PATCH did not produce revision 4: ${JSON.stringify(firstCorrection.payload)}`);
  record("first-free-text-corrected", { revision: 4 });

  await currentResponse(4, correctedFirst, correctedSecond, true);
  await waitForAnalysis(responseId, 4);
  record("analysis-completed", { revision: 4 });

  const visibleTotal = await aggregateTotal();
  if (visibleTotal !== aggregateBaseline + 1) throw new Error(`completed response missing from public aggregate: ${aggregateBaseline} -> ${visibleTotal}`);
  record("completed-visible-in-public", { total: visibleTotal });
} catch (error) {
  mainError = error;
  record("failure", { message: error.message, status: error.status || null, payload: error.payload || null });
} finally {
  await cleanup();
}

if (aggregateBaseline != null && !cleanupError) {
  try {
    const after = await aggregateTotal();
    if (after !== aggregateBaseline) throw new Error(`public aggregate did not return to baseline: ${aggregateBaseline} -> ${after}`);
    record("aggregate-restored", { total: after });
  } catch (error) {
    cleanupError = error;
    record("post-cleanup-check-failed", { message: error.message });
  }
}

console.log(JSON.stringify({ e2e: mainError || cleanupError ? "failed" : "passed", steps: log.length }));
if (mainError) throw mainError;
if (cleanupError) throw cleanupError;
