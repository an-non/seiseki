import {
  createResponseFollowUpText,
  deleteResponseFollowUpText,
  deleteResponse,
  getBasicStats,
  getResponseMetadata,
  getResponseQuestionSnapshot,
  insertPendingResponse,
  listPublicDemoResponses,
  updateInitialResponse,
  updateResponseFollowUpText,
  updateResponseFreeText
} from "./db.mjs";
import { getResponseAnalysis, prepareResponseAnalysisRetry, restoreResponseAnalysisFailure } from "./db.mjs";
import {
  authenticateRequest,
  authorizeResponseAccess,
  createResponseManageToken,
  deleteAccount,
  getAccount,
  listAccountResponses,
  loginAccount,
  logoutAccount,
  registerAccount,
  updateAccount
} from "./auth.mjs";
import { analyzeStoredResponse } from "./analysis.mjs";
import { loadQuestions, snapshotQuestions, validateAnswersAgainstQuestions } from "./config.mjs";
import {
  createResponseId,
  normalizeExpectedRevision,
  normalizeFollowUpTextCreate,
  normalizeFollowUpTextDelete,
  normalizeFollowUpTextUpdate,
  normalizeFreeTextUpdate,
  normalizeInitialResponseUpdate,
  normalizeSubmission,
  RequestError
} from "./validation.mjs";
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "./rate-limit.mjs";
import { getPublicAggregate } from "./public-aggregate.mjs";
import { handleStagingAdminRequest } from "./staging-admin.mjs";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
});

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : "";
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, X-Response-Manage-Token, X-Seiseki-Admin-Token",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function routeId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})$/u);
  return match ? match[1] : null;
}

function routeAnalysisId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/analysis$/u);
  return match ? match[1] : null;
}

function routeFreeTextId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/free-text$/u);
  return match ? match[1] : null;
}

function routeFollowUpId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/follow-up$/u);
  return match ? match[1] : null;
}

function routeInitialId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/initial$/u);
  return match ? match[1] : null;
}

function routeAnswersId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/answers$/u);
  return match ? match[1] : null;
}

function routeRequeueId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/analysis\/requeue$/u);
  return match ? match[1] : null;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "application/json is required");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 32 * 1024) {
    throw new RequestError(413, "BODY_TOO_LARGE", "request body is too large");
  }
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

async function verifyTurnstile(body, request, options = {}) {
  const required = String(options.required).toLowerCase() === "true";
  const secret = String(options.secret || "").trim();
  const expectedHostname = String(options.hostname || "").trim();
  const expectedAction = String(options.action || "").trim();
  const token = String(body?.turnstileToken ?? "").trim();

  if (!secret) {
    if (required) {
      throw new RequestError(503, "TURNSTILE_NOT_CONFIGURED", "Turnstile is required but not configured");
    }
    return;
  }

  if (!token) {
    if (required) throw new RequestError(400, "TURNSTILE_REQUIRED", "Turnstile token is required");
    return;
  }

  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("idempotency_key", crypto.randomUUID());
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) form.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });
  const result = await response.json();
  if (!result.success) throw new RequestError(403, "TURNSTILE_FAILED", "Turnstile verification failed");
  if (expectedHostname && result.hostname !== expectedHostname) {
    throw new RequestError(403, "TURNSTILE_HOSTNAME_MISMATCH", "Turnstile hostname did not match");
  }
  if (expectedAction && result.action !== expectedAction) {
    throw new RequestError(403, "TURNSTILE_ACTION_MISMATCH", "Turnstile action did not match");
  }
}

async function handleCreateResponse(request, env, ctx) {
  await enforceRateLimit(env.DB, request, RATE_LIMIT_POLICIES.response);
  const body = await readJson(request);
  await verifyTurnstile(body, request, {
    required: env.TURNSTILE_REQUIRED,
    secret: env.TURNSTILE_SECRET,
    hostname: env.TURNSTILE_HOSTNAME
  });
  const normalized = normalizeSubmission(body);
  const questions = await loadQuestions(env.DB);
  if (!validateAnswersAgainstQuestions(normalized.answers, questions, normalized.demoFlag)) {
    throw new RequestError(400, "INVALID_ANSWER", "answers do not match the active questions");
  }

  const account = await authenticateRequest(env.DB, request, request.headers.has("authorization"));
  if (account) {
    const current = await getAccount(env.DB, account);
    if (current?.account?.responseId) {
      throw new RequestError(409, "RESPONSE_ALREADY_EXISTS", "this account already has an active response");
    }
  }

  const manageAccess = account ? null : await createResponseManageToken();
  const response = {
    ...normalized,
    id: createResponseId(),
    createdAt: Date.now()
  };

  try {
    await insertPendingResponse(
      env.DB,
      response,
      snapshotQuestions(questions),
      manageAccess?.tokenHash ?? null,
      account?.id ?? null
    );
  } catch (error) {
    if (error?.code === "RESPONSE_ALREADY_EXISTS" || String(error?.message ?? "") === "RESPONSE_ALREADY_EXISTS") {
      throw new RequestError(409, "RESPONSE_ALREADY_EXISTS", "this account already has an active response");
    }
    throw error;
  }

  if (String(env.AI_ANALYSIS_ENABLED).toLowerCase() === "true" && ctx) {
    const dispatch = async () => {
      if (env.ANALYSIS_QUEUE?.send) {
        try {
          await env.ANALYSIS_QUEUE.send({ type: "analyze-response", responseId: response.id, revision: 1 });
          return;
        } catch (error) {
          console.error(JSON.stringify({
            event: "analysis_enqueue_failed",
            responseId: response.id,
            revision: 1,
            error: String(error?.message ?? "unknown").slice(0, 160)
          }));
        }
      }
      await analyzeStoredResponse(env, response.id, 1);
    };
    ctx.waitUntil(dispatch().catch(error => {
      console.error(JSON.stringify({
        event: "analysis_failed",
        responseId: response.id,
        revision: 1,
        error: String(error?.message ?? "unknown").slice(0, 160)
      }));
    }));
  }

  return json({
    id: response.id,
    revision: 1,
    status: "stored",
    analysisStatus: "pending",
    ...(manageAccess ? { manageToken: manageAccess.token } : {})
  }, 201);
}

function retryDelayForLease(outcome, now = Date.now()) {
  const leaseUntil = Number(outcome?.leaseUntil ?? 0);
  const remainingMs = Math.max(0, leaseUntil - now);
  const jitterMs = Math.floor(Math.random() * 2000);
  return Math.min(86400, Math.max(1, Math.ceil((remainingMs + jitterMs) / 1000)));
}

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
      console.error(JSON.stringify({
        event: "analysis_update_enqueue_pending", responseId, revision,
        code: error?.code || "UNKNOWN"
      }));
    }
  })());
}

async function handleRequest(request, env, ctx) {
  if (!env.DB) throw new RequestError(503, "DB_NOT_BOUND", "D1 binding DB is not configured");
  const url = new URL(request.url);

  const stagingAdminResponse = await handleStagingAdminRequest(request, env, url);
  if (stagingAdminResponse) return stagingAdminResponse;

  if (request.method === "GET" && url.pathname === "/api/health") {
    const row = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ status: row?.ok === 1 ? "ok" : "degraded", database: "d1" });
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    return json({
      questions: await loadQuestions(env.DB),
      turnstile: {
        registerSiteKey: String(env.TURNSTILE_REGISTER_SITE_KEY || ""),
        registerRequired: String(env.TURNSTILE_REGISTER_REQUIRED).toLowerCase() === "true"
      }
    });
  }
  if (request.method === "POST" && url.pathname === "/api/responses") {
    return handleCreateResponse(request, env, ctx);
  }
  if (request.method === "GET" && url.pathname === "/api/stats") {
    return json(await getBasicStats(env.DB), 200, { "cache-control": "public, max-age=0, s-maxage=60" });
  }
  if (request.method === "GET" && url.pathname === "/api/public-aggregate") {
    return json(await getPublicAggregate(env.DB), 200, { "cache-control": "public, max-age=0, s-maxage=30" });
  }
  if (request.method === "GET" && url.pathname === "/api/demo-responses") {
    return json({ responses: await listPublicDemoResponses(env.DB) }, 200, {
      "cache-control": "public, max-age=0, s-maxage=60"
    });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/register") {
    await enforceRateLimit(env.DB, request, RATE_LIMIT_POLICIES.register);
    const body = await readJson(request);
    await verifyTurnstile(body, request, {
      required: env.TURNSTILE_REGISTER_REQUIRED,
      secret: env.TURNSTILE_REGISTER_SECRET,
      hostname: env.TURNSTILE_REGISTER_HOSTNAME,
      action: "register"
    });
    return json(await registerAccount(env.DB, body, env.PASSWORD_ITERATIONS), 201);
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/login") {
    const body = await readJson(request);
    const accountName = String(body?.name ?? "").normalize("NFKC").trim().toLowerCase();
    await enforceRateLimit(env.DB, request, RATE_LIMIT_POLICIES.login, accountName);
    return json(await loginAccount(env.DB, body));
  }
  if (url.pathname === "/api/accounts/me") {
    const account = await authenticateRequest(env.DB, request, true);
    if (request.method === "GET") return json(await getAccount(env.DB, account));
    if (request.method === "PATCH") {
      return json(await updateAccount(env.DB, account, await readJson(request), env.PASSWORD_ITERATIONS));
    }
    if (request.method === "DELETE") {
      await deleteAccount(env.DB, account, await readJson(request));
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/logout") {
    const account = await authenticateRequest(env.DB, request, true);
    await logoutAccount(env.DB, account);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  if (request.method === "GET" && url.pathname === "/api/accounts/me/responses") {
    const account = await authenticateRequest(env.DB, request, true);
    return json({ responses: await listAccountResponses(env.DB, account.id) });
  }

  const freeTextId = routeFreeTextId(url.pathname);
  if (freeTextId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, freeTextId);
    const input = normalizeFreeTextUpdate(await readJson(request));
    const nextRevision = await updateResponseFreeText(env.DB, freeTextId, input.expectedRevision, input.freeText);
    if (nextRevision == null) {
      throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    }
    dispatchUpdatedAnalysis(env, ctx, freeTextId, nextRevision);
    const current = await getResponseMetadata(env.DB, freeTextId);
    return json({ id: freeTextId, revision: nextRevision, analysisStatus: "pending", updatedAt: Number(current?.updatedAt || Date.now()) });
  }

  const followUpId = routeFollowUpId(url.pathname);
  if (followUpId && (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE")) {
    await authorizeResponseAccess(env.DB, request, followUpId);
    const rawInput = await readJson(request);
    const input = request.method === "POST"
      ? normalizeFollowUpTextCreate(rawInput)
      : request.method === "PATCH"
        ? normalizeFollowUpTextUpdate(rawInput)
        : normalizeFollowUpTextDelete(rawInput);
    const outcome = request.method === "POST"
      ? await createResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)
      : request.method === "PATCH"
        ? await updateResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)
        : await deleteResponseFollowUpText(env.DB, followUpId, input.expectedRevision);
    if (outcome.status === "not_found") throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (outcome.status === "stale") throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    if (outcome.status === "exists") throw new RequestError(409, "FOLLOW_UP_ALREADY_EXISTS", "second free-text response has already been submitted");
    if (outcome.status === "missing") throw new RequestError(409, "FOLLOW_UP_NOT_SUBMITTED", "second free-text response has not been submitted yet");
    if (outcome.status !== "updated") throw new RequestError(409, "FOLLOW_UP_CONFLICT", "second free-text response could not be updated");
    dispatchUpdatedAnalysis(env, ctx, followUpId, outcome.revision);
    return json({
      id: followUpId,
      revision: outcome.revision,
      analysisStatus: "pending",
      followUpSubmitted: request.method === "DELETE" ? false : true,
      updatedAt: outcome.updatedAt
    }, request.method === "POST" ? 201 : 200);
  }

  const initialId = routeInitialId(url.pathname);
  if (initialId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, initialId);
    const input = normalizeInitialResponseUpdate(await readJson(request));
    const snapshot = await getResponseQuestionSnapshot(env.DB, initialId);
    if (!snapshot.length || input.answers.length !== snapshot.length || !validateAnswersAgainstQuestions(input.answers, snapshot, false)) {
      throw new RequestError(400, "INVALID_ANSWER", "answers do not match the saved question snapshot");
    }
    const outcome = await updateInitialResponse(env.DB, initialId, input.expectedRevision, input.answers, input.freeText);
    if (outcome.status === "not_found") throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (outcome.status !== "updated") throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    dispatchUpdatedAnalysis(env, ctx, initialId, outcome.revision);
    return json({ id: initialId, revision: outcome.revision, analysisStatus: "pending", updatedAt: outcome.updatedAt });
  }

  const answersId = routeAnswersId(url.pathname);
  if (answersId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, answersId);
    throw new RequestError(410, "ANSWERS_ONLY_UPDATE_REMOVED", "questionnaire-only correction was removed; update the initial response as one revision");
  }

  const requeueId = routeRequeueId(url.pathname);
  if (requeueId && request.method === "POST") {
    await authorizeResponseAccess(env.DB, request, requeueId);
    await enforceRateLimit(env.DB, request, RATE_LIMIT_POLICIES.analysisRequeue, requeueId);
    const body = await readJson(request);
    const expectedRevision = normalizeExpectedRevision(body?.expectedRevision);
    const current = await getResponseAnalysis(env.DB, requeueId);
    if (!current) throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (Number(current.revision ?? 1) !== expectedRevision) throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    if (!current.retryable) throw new RequestError(409, "ANALYSIS_NOT_RETRYABLE", "analysis can be retried only after failure or a detected stall");
    const prepared = await prepareResponseAnalysisRetry(env.DB, requeueId, expectedRevision);
    if (prepared.status === "stale") throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    if (prepared.status !== "ready") throw new RequestError(409, "ANALYSIS_NOT_RETRYABLE", "analysis is no longer retryable");
    try { await enqueueAnalysisRevision(env, requeueId, expectedRevision); }
    catch (error) { if (prepared.resetFromFailed) await restoreResponseAnalysisFailure(env.DB, requeueId, expectedRevision); throw error; }
    return json({ id: requeueId, revision: expectedRevision, analysisStatus: "pending", stalled: false, retryable: false, queued: true }, 202);
  }

  const analysisId = routeAnalysisId(url.pathname);
  if (analysisId && request.method === "GET") {
    await authorizeResponseAccess(env.DB, request, analysisId);
    const analysis = await getResponseAnalysis(env.DB, analysisId);
    if (!analysis) throw new RequestError(404, "NOT_FOUND", "response was not found");
    return json(analysis);
  }

  const id = routeId(url.pathname);
  if (id && request.method === "GET") {
    await authorizeResponseAccess(env.DB, request, id);
    const response = await getResponseMetadata(env.DB, id);
    if (!response) throw new RequestError(404, "NOT_FOUND", "response was not found");
    return json(response);
  }
  if (id && request.method === "DELETE") {
    await authorizeResponseAccess(env.DB, request, id);
    const deleted = await deleteResponse(env.DB, id);
    if (!deleted) throw new RequestError(404, "NOT_FOUND", "response was not found");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  throw new RequestError(404, "NOT_FOUND", "route was not found");
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);
    if (request.headers.has("origin") && !origin) {
      return json({ error: "ORIGIN_NOT_ALLOWED", message: "request origin is not allowed" }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    try {
      return withCors(await handleRequest(request, env, ctx), origin);
    } catch (error) {
      if (error instanceof RequestError) {
        return withCors(json({ error: error.code, message: error.message }, error.status), origin);
      }
      console.error("request failed", error);
      return withCors(json({ error: "INTERNAL_ERROR", message: "request failed" }, 500), origin);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      const responseId = body?.type === "analyze-response" ? String(body.responseId ?? "") : "";
      const revision = Number(body?.revision);
      if (!/^r_[A-Za-z0-9_-]{12,62}$/u.test(responseId) || !Number.isInteger(revision) || revision < 1) {
        console.warn(JSON.stringify({ event: "analysis_queue_invalid_message", messageId: message.id }));
        message.ack();
        continue;
      }
      try {
        const current = await getResponseMetadata(env.DB, responseId);
        if (!current || Number(current.revision ?? 1) !== revision) {
          console.warn(JSON.stringify({
            event: "analysis_queue_stale_message",
            responseId,
            queuedRevision: revision,
            currentRevision: current ? Number(current.revision ?? 1) : null
          }));
          message.ack();
          continue;
        }
        const outcome = await analyzeStoredResponse(env, responseId, revision);
        if (outcome?.status === "busy") {
          const delaySeconds = retryDelayForLease(outcome);
          console.warn(JSON.stringify({
            event: "analysis_queue_busy_retry",
            responseId,
            revision,
            runId: outcome?.runId ?? null,
            leaseUntil: outcome?.leaseUntil ?? null,
            delaySeconds,
            attempts: Number(message.attempts ?? 1)
          }));
          message.retry({ delaySeconds });
          continue;
        }
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: "analysis_queue_failed",
          responseId,
          revision,
          error: String(error?.message ?? "unknown").slice(0, 160)
        }));
        message.retry({ delaySeconds: Math.min(60, Math.max(1, Number(message.attempts ?? 1) * 5)) });
      }
    }
  }
};
