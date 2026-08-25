import fs from "node:fs";

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, oldText, newText, label) {
  if (text.includes(newText)) return text;
  if (!text.includes(oldText)) throw new Error(`${label}: marker not found`);
  return text.replace(oldText, newText);
}
function replaceBetween(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: boundary not found`);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}

// 1) Migration: lease-aware running claim; remove redundant manage-token index.
{
  const path = "cloudflare/migrations/0006_response_access_revision.sql";
  let text = read(path);
  text = replaceExact(text,
    "ALTER TABLE analysis_runs ADD COLUMN response_revision INTEGER;",
    "ALTER TABLE analysis_runs ADD COLUMN response_revision INTEGER;\nALTER TABLE analysis_runs ADD COLUMN lease_until INTEGER;",
    "analysis lease column"
  );
  text = replaceExact(text,
`CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_response_revision_unique
  ON analysis_runs(response_id, response_revision)
  WHERE response_revision IS NOT NULL;`,
`CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_response_revision_running_unique
  ON analysis_runs(response_id, response_revision)
  WHERE response_revision IS NOT NULL AND status = 'running';`,
    "running-run uniqueness"
  );
  text = text.replace(/\nCREATE INDEX IF NOT EXISTS response_access_token_idx\n  ON response_access\(manage_token_hash\);\n?/u, "\n");
  write(path, text);
}

// 2) DB: fixed run id + expected revision + lease + conditional chunk writes.
{
  const path = "cloudflare/src/db.mjs";
  let text = read(path);
  const replacement = `export async function startAnalysisRun(db, responseId, expectedRevision, engine, model, promptVersion, leaseMs = 300000) {
  const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision < 1) return { status: "stale" };
  const current = await db.prepare(\`
    SELECT revision, analysis_status AS analysisStatus
    FROM responses
    WHERE id = ?
  \`).bind(responseId).first();
  if (!current || current.analysisStatus !== "pending" || Number(current.revision ?? 1) !== revision) {
    return { status: "stale" };
  }

  const now = Date.now();
  const leaseUntil = now + Math.max(30000, Math.min(900000, Number(leaseMs) || 300000));
  const running = await db.prepare(\`
    SELECT id, lease_until AS leaseUntil
    FROM analysis_runs
    WHERE response_id = ? AND response_revision = ? AND status = 'running'
    ORDER BY id DESC LIMIT 1
  \`).bind(responseId, revision).first();
  if (running && Number(running.leaseUntil ?? 0) > now) {
    return { status: "busy", runId: Number(running.id), revision, leaseUntil: Number(running.leaseUntil) };
  }
  if (running) {
    await db.prepare(\`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = 'LEASE_EXPIRED'
      WHERE id = ? AND status = 'running' AND COALESCE(lease_until, 0) <= ?
    \`).bind(now, running.id, now).run();
  }

  try {
    await db.prepare(\`
      INSERT INTO analysis_runs (
        response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until
      )
      SELECT ?, ?, ?, ?, 'running', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM responses
        WHERE id = ? AND analysis_status = 'pending' AND revision = ?
      )
    \`).bind(
      responseId, engine, model, promptVersion, now, revision, leaseUntil,
      responseId, revision
    ).run();
  } catch (error) {
    const message = String(error?.message ?? "").toLowerCase();
    if (message.includes("unique") || message.includes("analysis_runs_response_revision_running_unique")) {
      return { status: "busy", revision };
    }
    throw error;
  }

  const claimed = await db.prepare(\`
    SELECT id, lease_until AS leaseUntil
    FROM analysis_runs
    WHERE response_id = ? AND response_revision = ? AND status = 'running'
    ORDER BY id DESC LIMIT 1
  \`).bind(responseId, revision).first();
  return claimed
    ? { status: "claimed", runId: Number(claimed.id), revision, leaseUntil: Number(claimed.leaseUntil) }
    : { status: "busy", revision };
}

export async function renewAnalysisRunLease(db, responseId, runId, expectedRevision, leaseMs = 300000) {
  const now = Date.now();
  const leaseUntil = now + Math.max(30000, Math.min(900000, Number(leaseMs) || 300000));
  const result = await db.prepare(\`
    UPDATE analysis_runs
    SET lease_until = ?
    WHERE id = ? AND response_id = ? AND response_revision = ?
      AND status = 'running' AND COALESCE(lease_until, 0) >= ?
      AND EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ? AND analysis_status = 'pending')
  \`).bind(leaseUntil, runId, responseId, expectedRevision, now, responseId, expectedRevision).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function markRunStale(db, runId, errorCode = "STALE_REVISION") {
  if (!runId) return;
  await db.prepare(\`
    UPDATE analysis_runs
    SET status = 'failed', completed_at = ?, error_code = ?, lease_until = NULL
    WHERE id = ? AND status = 'running'
  \`).bind(Date.now(), errorCode, runId).run();
}

export async function completeResponseAnalysis(db, responseId, runId, expectedRevision, analysis, metadata) {
  const revision = Number(expectedRevision);
  const completedAt = Date.now();
  const guardSql = \`EXISTS (
    SELECT 1
    FROM responses r
    JOIN analysis_runs ar ON ar.id = ?
    WHERE r.id = ? AND r.revision = ?
      AND ar.response_id = r.id AND ar.response_revision = ?
      AND ar.status = 'running' AND COALESCE(ar.lease_until, 0) >= ?
  )\`;
  const statements = [
    db.prepare(\`
      UPDATE responses
      SET analysis_status = 'completed', analysis_json = ?
      WHERE id = ? AND revision = ? AND \${guardSql}
    \`).bind(JSON.stringify(analysis), responseId, revision, runId, responseId, revision, revision, completedAt),
    db.prepare(\`
      DELETE FROM opinion_chunks
      WHERE response_id = ? AND \${guardSql}
    \`).bind(responseId, runId, responseId, revision, revision, completedAt)
  ];
  for (const chunk of analysis.chunks) {
    statements.push(db.prepare(\`
      INSERT INTO opinion_chunks (
        response_id, created_at, summary, category, topic,
        target_type, target_name, emotion, criticality, fact_status, provenance_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE \${guardSql}
    \`).bind(
      responseId, completedAt, chunk.s, chunk.cat, chunk.topic,
      chunk.tt, chunk.tn, chunk.emo, chunk.crit, chunk.fact,
      JSON.stringify({ ...metadata, responseRevision: revision, analysisRunId: runId }),
      runId, responseId, revision, revision, completedAt
    ));
  }
  statements.push(db.prepare(\`
    UPDATE analysis_runs
    SET status = 'completed', completed_at = ?, error_code = NULL, lease_until = NULL
    WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
      AND EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ?)
  \`).bind(completedAt, runId, responseId, revision, responseId, revision));
  const results = await db.batch(statements);
  const updated = Number(results?.[0]?.meta?.changes ?? 0) > 0;
  if (!updated) await markRunStale(db, runId);
  return updated;
}

export async function failResponseAnalysis(db, responseId, runId, expectedRevision, errorCode) {
  const revision = Number(expectedRevision);
  const completedAt = Date.now();
  const results = await db.batch([
    db.prepare(\`
      UPDATE responses
      SET analysis_status = 'failed', analysis_json = NULL
      WHERE id = ? AND revision = ?
        AND EXISTS (
          SELECT 1 FROM analysis_runs
          WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
        )
    \`).bind(responseId, revision, runId, responseId, revision),
    db.prepare(\`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = ?, lease_until = NULL
      WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
    \`).bind(completedAt, String(errorCode || "ANALYSIS_FAILED").slice(0, 80), runId, responseId, revision)
  ]);
  return Number(results?.[0]?.meta?.changes ?? 0) > 0;
}`;
  text = replaceBetween(text,
    "export async function startAnalysisRun",
    "export async function getResponseAnalysis",
    replacement,
    "analysis run block"
  );
  text = replaceExact(text,
`  } catch (error) {
    if (accountId && String(error?.message ?? "").toLowerCase().includes("unique")) {
      const wrapped = new Error("RESPONSE_ALREADY_EXISTS");
      wrapped.code = "RESPONSE_ALREADY_EXISTS";
      throw wrapped;
    }
    throw error;
  }`,
`  } catch (error) {
    const message = String(error?.message ?? "").toLowerCase();
    const accountConflict = message.includes("account_responses.account_id")
      || message.includes("account_responses_account_unique");
    if (accountId && accountConflict) {
      const wrapped = new Error("RESPONSE_ALREADY_EXISTS");
      wrapped.code = "RESPONSE_ALREADY_EXISTS";
      throw wrapped;
    }
    throw error;
  }`,
    "specific account uniqueness classification"
  );
  write(path, text);
}

// 3) Auth: delete linked responses and account in the same batch without a pre-select.
{
  const path = "cloudflare/src/auth.mjs";
  let text = read(path);
  text = replaceExact(text,
`  const linked = await db.prepare(\`
    SELECT response_id AS responseId
    FROM account_responses
    WHERE account_id = ?
  \`).bind(account.id).all();
  const statements = [];
  for (const linkedRow of linked.results ?? []) {
    statements.push(db.prepare("DELETE FROM responses WHERE id = ?").bind(linkedRow.responseId));
  }
  statements.push(db.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id));
  await db.batch(statements);`,
`  await db.batch([
    db.prepare(\`
      DELETE FROM responses
      WHERE id IN (
        SELECT response_id FROM account_responses WHERE account_id = ?
      )
    \`).bind(account.id),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id)
  ]);`,
    "account atomic delete"
  );
  write(path, text);
}

// 4) Analysis: carry expected revision + exact run id from claim through completion.
{
  const path = "cloudflare/src/analysis.mjs";
  let text = read(path);
  text = replaceExact(text,
`import {
  completeResponseAnalysis,
  getResponseForAnalysis,
  startAnalysisRun
} from "./db.mjs";`,
`import {
  completeResponseAnalysis,
  getResponseForAnalysis,
  renewAnalysisRunLease,
  startAnalysisRun
} from "./db.mjs";`,
    "analysis imports"
  );
  const replacement = `export async function analyzeStoredResponse(env, responseId, expectedRevision = null) {
  const model = String(env.AI_MODEL || DEFAULT_MODEL);
  const record = await getResponseForAnalysis(env.DB, responseId);
  if (!record || record.analysisStatus !== "pending") return { status: "done" };
  const revision = expectedRevision == null ? Number(record.revision ?? 1) : Number(expectedRevision);
  if (!Number.isInteger(revision) || revision < 1 || Number(record.revision ?? 1) !== revision) {
    return { status: "stale" };
  }
  const leaseMs = Number(env.ANALYSIS_LEASE_MS || 300000);
  const claim = await startAnalysisRun(env.DB, responseId, revision, ENGINE, model, PROMPT_VERSION, leaseMs);
  if (!claim || claim.status !== "claimed") return claim || { status: "busy" };
  const runId = claim.runId;
  const freeText = safeFreeText(record.freeText);
  const finish = async (analysis, metadata) => {
    const renewed = await renewAnalysisRunLease(env.DB, responseId, runId, revision, leaseMs);
    if (!renewed) return { status: "stale", runId, revision };
    const saved = await completeResponseAnalysis(env.DB, responseId, runId, revision, analysis, metadata);
    return { status: saved ? "completed" : "stale", runId, revision };
  };
  if (!freeText.trim()) {
    return finish(emptyAnalysis(freeText), {
      engine: "rules-only-v1",
      model: "none",
      promptVersion: PROMPT_VERSION
    });
  }
  try {
    const result = await requestAiAnalysis(env, model, record, freeText);
    return finish(result.analysis, {
      engine: ENGINE,
      model,
      promptVersion: PROMPT_VERSION,
      attempts: result.attempts
    });
  } catch (error) {
    const code = errorCode(error);
    const analysis = fallbackAnalysis(freeText);
    const outcome = await finish(analysis, {
      engine: analysis.engine,
      model: "none",
      promptVersion: PROMPT_VERSION,
      fallbackReason: code
    });
    console.warn(JSON.stringify({ event: "analysis_fallback", responseId, revision, runId, errorCode: code }));
    return outcome;
  }
}`;
  text = replaceBetween(text,
    "export async function analyzeStoredResponse",
    "\n}",
    replacement,
    "analyzeStoredResponse"
  );
  // replaceBetween above stops at the first closing brace; re-do safely using last export function position if needed.
  const first = text.indexOf(replacement);
  if (first >= 0) {
    const duplicateTail = text.indexOf("\n  const model = String(env.AI_MODEL", first + replacement.length);
    if (duplicateTail >= 0) throw new Error("analysis function replacement left duplicate body");
  }
  write(path, text);
}

// 5) Worker queue: expected revision is passed into analysis; active lease causes retry rather than ack.
{
  const path = "cloudflare/src/index.mjs";
  let text = read(path);
  text = text.replaceAll("await analyzeStoredResponse(env, response.id);", "await analyzeStoredResponse(env, response.id, 1);");
  text = replaceExact(text,
`        await analyzeStoredResponse(env, responseId);
        message.ack();`,
`        const outcome = await analyzeStoredResponse(env, responseId, revision);
        if (outcome?.status === "busy") {
          message.retry({ delaySeconds: 30 });
          continue;
        }
        message.ack();`,
    "queue busy retry"
  );
  write(path, text);
}

// 6) UI: persist anonymous manage token in private scope and attach auth on poll/delete.
{
  const path = "core/ui.jsx";
  let text = read(path);
  text = replaceExact(text,
`  return created && created.id ? created.id : null;
}

async function cloudLoadResponseAnalysis(id) {
  if (!cloudApiEnabled() || !id) return null;
  const payload = await cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/analysis");
  return normalizeCloudAnalysisResult(payload);
}`,
`  if (!created || !created.id) return null;
  const result = {
    id: String(created.id),
    revision: Number(created.revision || 1),
    manageToken: String(created.manageToken || "")
  };
  if (result.manageToken) {
    await pSet("response-access:" + result.id, {
      manageToken: result.manageToken,
      createdAt: Date.now()
    });
  }
  return result;
}

async function cloudResponseAuthHeaders(id) {
  const headers = {};
  const session = await pGet("session:current");
  if (session && session.token) headers.authorization = "Bearer " + session.token;
  const access = await pGet("response-access:" + id);
  if (access && access.manageToken) headers["x-response-manage-token"] = access.manageToken;
  return headers;
}

async function cloudLoadResponseAnalysis(id) {
  if (!cloudApiEnabled() || !id) return null;
  const payload = await cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/analysis", {
    headers: await cloudResponseAuthHeaders(id)
  });
  return normalizeCloudAnalysisResult(payload);
}`,
    "UI response auth"
  );
  text = replaceExact(text,
`async function cloudDeleteResponse(id) {
  if (!cloudApiEnabled() || !id) return true;
  try {
    await cloudApiRequest("/api/responses/" + encodeURIComponent(id), { method: "DELETE" });
    return true;
  } catch (e) {
    if (e && e.status === 404) return true;
    throw e;
  }
}`,
`async function cloudDeleteResponse(id) {
  if (!cloudApiEnabled() || !id) return true;
  try {
    await cloudApiRequest("/api/responses/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: await cloudResponseAuthHeaders(id)
    });
    await pDel("response-access:" + id);
    return true;
  } catch (e) {
    if (e && e.status === 404) {
      await pDel("response-access:" + id);
      return true;
    }
    throw e;
  }
}`,
    "UI delete auth"
  );
  text = replaceExact(text,
`    let remoteId = null;
    /* 追記(seq=2)も同じ経路に載せる。解析はアカウントに紐付いたまま Cloudflare 側で行われる。 */
    if (cloudApiEnabled()) {
      try {
        remoteId = await cloudCreateInitialResponse(base, session && session.token);
        const remote = await cloudWaitForResponseAnalysis(remoteId);`,
`    let remoteId = null;
    let remoteRevision = null;
    /* Cloudflare作成結果には認可情報とrevisionが含まれる。匿名manage tokenはprivate scopeへ保存する。 */
    if (cloudApiEnabled()) {
      try {
        const createdRemote = await cloudCreateInitialResponse(base, session && session.token);
        remoteId = createdRemote && createdRemote.id;
        remoteRevision = createdRemote && createdRemote.revision;
        if (!remoteId) throw new Error("Cloudflare response id was not returned");
        const remote = await cloudWaitForResponseAnalysis(remoteId);`,
    "UI create result"
  );
  text = replaceExact(text,
`      remoteId: remoteId,
      ...(remoteId ? { cloudAnalysisStatus: cloudAnalysisStatus || "pending" } : {}),`,
`      remoteId: remoteId,
      ...(remoteRevision ? { remoteRevision: remoteRevision } : {}),
      ...(remoteId ? { cloudAnalysisStatus: cloudAnalysisStatus || "pending" } : {}),`,
    "UI remote revision storage"
  );
  write(path, text);
}

// 7) Existing test fixtures should use the current schema.
for (const path of ["cloudflare/tests/security-release.test.mjs", "cloudflare/tests/worker-sqlite.test.mjs"]) {
  let text = read(path);
  if (path.endsWith("security-release.test.mjs")) {
    text = replaceExact(text,
`    "0004_response_question_context.sql",
    "0005_rate_limits.sql"`,
`    "0004_response_question_context.sql",
    "0005_rate_limits.sql",
    "0006_response_access_revision.sql"`,
      "security fixture migration"
    );
  } else {
    text = replaceExact(text,
`for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql"])`,
`for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql"])`,
      "worker fixture migration"
    );
  }
  write(path, text);
}

// 8) Fix the older focused queue test harness so the full suite can execute it honestly.
{
  const path = "cloudflare/tests/response-auth-revision.test.mjs";
  let text = read(path);
  text = replaceExact(text,
`async function createResponse(env, body = submission(), token = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = \`Bearer \${token}\`;
  return worker.fetch(new Request("http://local/api/responses", {
    method: "POST", headers, body: JSON.stringify(body)
  }), env);
}`,
`async function createResponse(env, body = submission(), token = null, ctx = undefined) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = \`Bearer \${token}\`;
  return worker.fetch(new Request("http://local/api/responses", {
    method: "POST", headers, body: JSON.stringify(body)
  }), env, ctx);
}`,
    "focused create helper"
  );
  text = replaceExact(text,
`  const createdResponse = await createResponse(env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await new Promise(resolve => setTimeout(resolve, 0));`,
`  const waits = [];
  const createdResponse = await createResponse(env, submission(), null, {
    waitUntil: promise => waits.push(promise)
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await Promise.all(waits);`,
    "focused queue waitUntil"
  );
  write(path, text);
}

console.log("Applied response audit fixes.");
