import { RequestError } from "./validation.mjs";
import { createSubmissionFingerprint, refreshSubmissionReview } from "./submission-review.mjs";

const encoder = new TextEncoder();
const ADMIN_PREFIX = "/api/staging-admin";
const ADMIN_TOKEN_HEADER = "x-seiseki-admin-token";

function adminEnabled(env) {
  return String(env.SEISEKI_ENV ?? "").toLowerCase() === "staging"
    && String(env.STAGING_ADMIN_ENABLED ?? "").toLowerCase() === "true";
}

async function safeTokenEqual(provided, expected) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function requireAdmin(request, env) {
  const expected = String(env.STAGING_ADMIN_TOKEN ?? "");
  if (!expected) {
    throw new RequestError(503, "STAGING_ADMIN_NOT_CONFIGURED", "staging administrator access is not configured");
  }
  const provided = String(request.headers.get(ADMIN_TOKEN_HEADER) ?? "");
  if (!provided || provided.length > 512 || !await safeTokenEqual(provided, expected)) {
    throw new RequestError(401, "STAGING_ADMIN_UNAUTHORIZED", "staging administrator authentication failed");
  }
}

function adminJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function readAdminJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "application/json is required");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 4096) throw new RequestError(413, "BODY_TOO_LARGE", "request body is too large");
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

async function listAccounts(db, url) {
  const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 100);
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 100000);
  const [countRow, rows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM accounts").first(),
    db.prepare(`
      SELECT a.id, a.name, a.created_at AS createdAt, a.updated_at AS updatedAt,
             ar.response_id AS responseId, r.created_at AS responseCreatedAt,
             r.updated_at AS responseUpdatedAt, r.analysis_status AS analysisStatus,
             r.revision AS revision, r.publication_status AS publicationStatus,
             (SELECT COUNT(*) FROM opinion_chunks oc WHERE oc.response_id = ar.response_id) AS chunkCount
      FROM accounts a
      LEFT JOIN account_responses ar ON ar.account_id = a.id
      LEFT JOIN responses r ON r.id = ar.response_id
      ORDER BY a.normalized_name ASC, a.id ASC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all()
  ]);
  return {
    accounts: (rows.results ?? []).map(row => ({
      id: row.id,
      name: row.name,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      response: row.responseId ? {
        id: row.responseId,
        createdAt: Number(row.responseCreatedAt),
        updatedAt: Number(row.responseUpdatedAt),
        analysisStatus: row.analysisStatus,
        revision: Number(row.revision ?? 1),
        publicationStatus: row.publicationStatus ?? "accepted",
        chunkCount: Number(row.chunkCount ?? 0)
      } : null
    })),
    page: { offset, limit, total: Number(countRow?.total ?? 0) }
  };
}

async function listSubmissionReviews(db, url) {
  const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 100);
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 100000);
  const requestedStatus = String(url.searchParams.get("status") ?? "held_duplicate");
  if (!new Set(["accepted", "held_duplicate", "all"]).has(requestedStatus)) {
    throw new RequestError(400, "INVALID_PUBLICATION_STATUS", "publication status filter is invalid");
  }
  const where = requestedStatus === "all" ? "" : "WHERE r.publication_status = ?";
  const countStatement = db.prepare(`SELECT COUNT(*) AS total FROM responses r ${where}`);
  const rowsStatement = db.prepare(`
    SELECT r.id, r.created_at AS createdAt, r.updated_at AS updatedAt,
           r.revision, r.analysis_status AS analysisStatus,
           r.publication_status AS publicationStatus,
           f.normalized_length AS normalizedLength,
           a.name AS accountName
    FROM responses r
    LEFT JOIN response_text_fingerprints f ON f.response_id = r.id
    LEFT JOIN account_responses ar ON ar.response_id = r.id
    LEFT JOIN accounts a ON a.id = ar.account_id
    ${where}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `);
  const count = requestedStatus === "all"
    ? await countStatement.first()
    : await countStatement.bind(requestedStatus).first();
  const rows = requestedStatus === "all"
    ? await rowsStatement.bind(limit, offset).all()
    : await rowsStatement.bind(requestedStatus, limit, offset).all();
  return {
    reviews: (rows.results ?? []).map(row => ({
      responseId: row.id,
      accountName: row.accountName ?? null,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      revision: Number(row.revision ?? 1),
      analysisStatus: row.analysisStatus,
      publicationStatus: row.publicationStatus,
      normalizedLength: row.normalizedLength == null ? null : Number(row.normalizedLength)
    })),
    page: { offset, limit, total: Number(count?.total ?? 0), status: requestedStatus }
  };
}

function responseReviewIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/staging-admin\/submission-reviews\/(r_[A-Za-z0-9_-]{12,62})$/u);
  return match ? match[1] : null;
}

async function updateSubmissionReview(db, responseId, request) {
  const body = await readAdminJson(request);
  const publicationStatus = String(body?.publicationStatus ?? "");
  if (!new Set(["accepted", "held_duplicate"]).has(publicationStatus)) {
    throw new RequestError(400, "INVALID_PUBLICATION_STATUS", "publication status is invalid");
  }
  const current = await db.prepare(`
    SELECT publication_status AS publicationStatus, analysis_status AS analysisStatus, revision
    FROM responses WHERE id = ?
  `).bind(responseId).first();
  if (!current) throw new RequestError(404, "RESPONSE_NOT_FOUND", "response was not found");
  if (current.publicationStatus === publicationStatus) {
    return {
      responseId,
      publicationStatus,
      previousPublicationStatus: current.publicationStatus,
      analysisStatus: current.analysisStatus,
      revision: Number(current.revision ?? 1),
      changed: false
    };
  }
  const result = await db.prepare(`
    UPDATE responses
    SET publication_status = ?
    WHERE id = ? AND publication_status = ? AND revision = ?
  `).bind(publicationStatus, responseId, current.publicationStatus, current.revision).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) {
    throw new RequestError(409, "SUBMISSION_REVIEW_CONFLICT", "submission review changed; reload before editing");
  }
  return {
    responseId,
    publicationStatus,
    previousPublicationStatus: current.publicationStatus,
    analysisStatus: current.analysisStatus,
    revision: Number(current.revision ?? 1),
    changed: true
  };
}

async function applySubmissionReview(env, responseId, request, enqueueAnalysis) {
  const outcome = await updateSubmissionReview(env.DB, responseId, request);
  const shouldEnqueue = outcome.changed
    && outcome.previousPublicationStatus === "held_duplicate"
    && outcome.publicationStatus === "accepted"
    && outcome.analysisStatus !== "completed"
    && String(env.AI_ANALYSIS_ENABLED ?? "").toLowerCase() === "true";
  if (!shouldEnqueue) return { ...outcome, enqueued: false };
  if (typeof enqueueAnalysis !== "function") {
    await env.DB.prepare(`
      UPDATE responses SET publication_status = 'held_duplicate'
      WHERE id = ? AND revision = ? AND publication_status = 'accepted'
    `).bind(responseId, outcome.revision).run();
    throw new RequestError(503, "ANALYSIS_QUEUE_UNAVAILABLE", "analysis queue is not available");
  }
  try {
    await enqueueAnalysis(responseId, outcome.revision);
  } catch (error) {
    await env.DB.prepare(`
      UPDATE responses SET publication_status = 'held_duplicate'
      WHERE id = ? AND revision = ? AND publication_status = 'accepted'
    `).bind(responseId, outcome.revision).run();
    throw error;
  }
  return { ...outcome, analysisStatus: "pending", enqueued: true };
}

async function backfillSubmissionReviews(env, request) {
  if ([...String(env.SUBMISSION_FINGERPRINT_HMAC_SECRET ?? "")].length < 32) {
    throw new RequestError(503, "SUBMISSION_REVIEW_NOT_CONFIGURED", "submission review secret is not configured");
  }
  const body = await readAdminJson(request);
  const limit = boundedInteger(body?.limit, 50, 1, 100);
  const rows = await env.DB.prepare(`
    SELECT r.id, r.free_text AS freeText, r.follow_up_text AS followUpText
    FROM responses r
    LEFT JOIN response_text_fingerprints f ON f.response_id = r.id
    WHERE f.response_id IS NULL
      AND length(trim(coalesce(r.free_text, '') || coalesce(r.follow_up_text, ''))) >= 40
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT ?
  `).bind(limit).all();
  let processed = 0;
  let held = 0;
  for (const row of rows.results ?? []) {
    const fingerprint = await createSubmissionFingerprint(env, row.freeText, row.followUpText);
    if (!fingerprint) continue;
    const review = await refreshSubmissionReview(env.DB, row.id, fingerprint);
    processed++;
    if (review.publicationStatus === "held_duplicate") held++;
  }
  return { processed, held, remainingMayExist: (rows.results ?? []).length === limit };
}

function accountIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/staging-admin\/accounts\/(u_[a-f0-9]{32})$/u);
  return match ? match[1] : null;
}

async function deleteAccountAndData(db, accountId, request) {
  const account = await db.prepare("SELECT id, name FROM accounts WHERE id = ?").bind(accountId).first();
  if (!account) throw new RequestError(404, "ACCOUNT_NOT_FOUND", "account was not found");
  const body = await readAdminJson(request);
  const confirmation = String(body?.confirmName ?? "").normalize("NFKC").trim();
  if (!confirmation || confirmation !== account.name) {
    throw new RequestError(409, "ACCOUNT_NAME_CONFIRMATION_FAILED", "account name confirmation did not match");
  }

  const linked = await db.prepare("SELECT response_id AS responseId FROM account_responses WHERE account_id = ? ORDER BY linked_at")
    .bind(accountId).all();
  const responseIds = (linked.results ?? []).map(row => row.responseId);
  const counts = {
    responses: responseIds.length,
    sessions: Number((await db.prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE account_id = ?").bind(accountId).first())?.count ?? 0),
    answers: 0,
    chunks: 0,
    analysisRuns: 0,
    questionSnapshots: 0,
    responseAccess: 0
  };
  for (const responseId of responseIds) {
    counts.answers += Number((await db.prepare("SELECT COUNT(*) AS count FROM answers WHERE response_id = ?").bind(responseId).first())?.count ?? 0);
    counts.chunks += Number((await db.prepare("SELECT COUNT(*) AS count FROM opinion_chunks WHERE response_id = ?").bind(responseId).first())?.count ?? 0);
    counts.analysisRuns += Number((await db.prepare("SELECT COUNT(*) AS count FROM analysis_runs WHERE response_id = ?").bind(responseId).first())?.count ?? 0);
    counts.questionSnapshots += Number((await db.prepare("SELECT COUNT(*) AS count FROM response_questions WHERE response_id = ?").bind(responseId).first())?.count ?? 0);
    counts.responseAccess += Number((await db.prepare("SELECT COUNT(*) AS count FROM response_access WHERE response_id = ?").bind(responseId).first())?.count ?? 0);
  }

  await db.batch([
    db.prepare("DELETE FROM responses WHERE id IN (SELECT response_id FROM account_responses WHERE account_id = ?)").bind(accountId),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId)
  ]);

  const remaining = await db.prepare("SELECT 1 AS found FROM accounts WHERE id = ?").bind(accountId).first();
  if (remaining) throw new RequestError(500, "STAGING_ADMIN_DELETE_FAILED", "account deletion did not complete");
  return { deleted: true, account: { id: account.id, name: account.name }, deletedRecords: counts };
}

function adminPage() {
  return new Response(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SEISEKI staging &#31649;&#29702;</title>
  <style>
    :root{font-family:"Zen Kaku Gothic New","Yu Gothic UI",sans-serif;color:#17221f;background:#f4f7f6}
    *{box-sizing:border-box}body{margin:0}header{padding:18px 24px;background:#153f36;color:#fff}
    header h1{font-size:18px;margin:0;font-weight:600}main{max-width:1100px;margin:0 auto;padding:24px}
    .toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:18px}
    label{font-size:12px;color:#4d5d58;display:grid;gap:5px}input{min-width:300px;padding:9px 10px;border:1px solid #aebbb7;border-radius:4px;background:#fff}
    button{border:1px solid #176755;border-radius:4px;padding:9px 13px;background:#176755;color:#fff;cursor:pointer}
    button.secondary{background:#fff;color:#176755}button.danger{border-color:#a22d36;background:#a22d36}
    button:disabled{opacity:.5;cursor:not-allowed}.status{min-height:22px;margin:8px 0;color:#4d5d58;font-size:13px}
    .table-wrap{overflow:auto;border:1px solid #cbd5d2;background:#fff}table{width:100%;border-collapse:collapse;min-width:760px}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e0e7e4;font-size:13px;vertical-align:top}
    th{background:#e8efed;font-size:12px}.muted{color:#687772}.empty{padding:24px;text-align:center;color:#687772}
  </style>
</head>
<body>
  <header><h1>SEISEKI staging &#31649;&#29702;</h1></header>
  <main>
    <div class="toolbar">
      <label>&#31649;&#29702;&#12488;&#12540;&#12463;&#12531;<input id="token" type="password" autocomplete="off" spellcheck="false"></label>
      <button id="load" type="button">&#12450;&#12459;&#12454;&#12531;&#12488;&#19968;&#35239;&#12434;&#21462;&#24471;</button>
      <button id="reviews" class="secondary" type="button">&#20445;&#30041;&#22238;&#31572;&#12434;&#21462;&#24471;</button>
      <button id="clear" class="secondary" type="button">&#12488;&#12540;&#12463;&#12531;&#12434;&#28040;&#21435;</button>
    </div>
    <div id="status" class="status" role="status"></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>&#12450;&#12459;&#12454;&#12531;&#12488;&#21517;</th><th>&#20316;&#25104;&#26085;&#26178;</th><th>&#22238;&#31572;</th><th>&#35299;&#26512;&#29366;&#24907;</th><th>&#25805;&#20316;</th></tr></thead>
        <tbody id="accounts"><tr><td class="empty" colspan="5">&#31649;&#29702;&#12488;&#12540;&#12463;&#12531;&#12434;&#20837;&#21147;&#12375;&#12390;&#21462;&#24471;&#12375;&#12390;&#12367;&#12384;&#12373;&#12356;&#12290;</td></tr></tbody>
      </table>
    </div>
    <h2 style="font-size:16px;margin:24px 0 10px">&#20445;&#30041;&#22238;&#31572;</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>&#22238;&#31572;ID</th><th>&#12450;&#12459;&#12454;&#12531;&#12488;</th><th>&#20316;&#25104;&#26085;&#26178;</th><th>&#29366;&#24907;</th><th>&#25805;&#20316;</th></tr></thead>
        <tbody id="reviewRows"><tr><td class="empty" colspan="5">&#20445;&#30041;&#22238;&#31572;&#12434;&#21462;&#24471;&#12375;&#12390;&#12367;&#12384;&#12373;&#12356;&#12290;</td></tr></tbody>
      </table>
    </div>
  </main>
  <script>
    const tokenInput=document.getElementById("token");const statusNode=document.getElementById("status");const rows=document.getElementById("accounts");const reviewRows=document.getElementById("reviewRows");
    const headers=()=>({"x-seiseki-admin-token":tokenInput.value});
    const date=value=>value?new Date(value).toLocaleString("ja-JP"):"-";
    function setStatus(value){statusNode.textContent=value}
    function cell(value,className){const node=document.createElement("td");node.textContent=value;if(className)node.className=className;return node}
    async function readError(response){try{const body=await response.json();return body.message||body.error}catch{return "\u64cd\u4f5c\u306b\u5931\u6557\u3057\u307e\u3057\u305f"}}
    async function loadAccounts(){
      if(!tokenInput.value){setStatus("\u7ba1\u7406\u30c8\u30fc\u30af\u30f3\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002");return}
      setStatus("\u53d6\u5f97\u4e2d...");
      const response=await fetch("/api/staging-admin/accounts?limit=100",{headers:headers(),cache:"no-store"});
      if(!response.ok){setStatus(await readError(response));return}
      const body=await response.json();rows.replaceChildren();
      for(const account of body.accounts){
        const tr=document.createElement("tr");tr.append(cell(account.name),cell(date(account.createdAt)));
        tr.append(cell(account.response?account.response.id:"\u306a\u3057",account.response?"":"muted"));
        tr.append(cell(account.response?account.response.analysisStatus+" / revision "+account.response.revision+" / "+account.response.publicationStatus:"-"));
        const action=document.createElement("td");const button=document.createElement("button");button.type="button";button.className="danger";button.textContent="\u95a2\u9023\u30c7\u30fc\u30bf\u3054\u3068\u524a\u9664";
        button.addEventListener("click",async()=>{
          const confirmation=prompt("\u524a\u9664\u78ba\u8a8d\u306e\u305f\u3081\u30a2\u30ab\u30a6\u30f3\u30c8\u540d\u3092\u6b63\u78ba\u306b\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002","");
          if(confirmation===null)return;button.disabled=true;setStatus("\u524a\u9664\u4e2d...");
          const deleted=await fetch("/api/staging-admin/accounts/"+encodeURIComponent(account.id),{method:"DELETE",headers:{...headers(),"content-type":"application/json"},body:JSON.stringify({confirmName:confirmation})});
          if(!deleted.ok){setStatus(await readError(deleted));button.disabled=false;return}
          setStatus(account.name+" \u3068\u7d10\u4ed8\u304f\u30c7\u30fc\u30bf\u3092\u524a\u9664\u3057\u307e\u3057\u305f\u3002");await loadAccounts();
        });action.append(button);tr.append(action);rows.append(tr);
      }
      if(!body.accounts.length){const tr=document.createElement("tr");const td=cell("\u30a2\u30ab\u30a6\u30f3\u30c8\u306f\u3042\u308a\u307e\u305b\u3093\u3002","empty");td.colSpan=5;tr.append(td);rows.append(tr)}
      setStatus(body.page.total+"\u4ef6\u4e2d "+body.accounts.length+"\u4ef6\u3092\u8868\u793a");
    }
    async function loadReviews(){
      if(!tokenInput.value){setStatus("\u7ba1\u7406\u30c8\u30fc\u30af\u30f3\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002");return}
      setStatus("\u4fdd\u7559\u56de\u7b54\u3092\u53d6\u5f97\u4e2d...");
      const response=await fetch("/api/staging-admin/submission-reviews?status=held_duplicate&limit=100",{headers:headers(),cache:"no-store"});
      if(!response.ok){setStatus(await readError(response));return}
      const body=await response.json();reviewRows.replaceChildren();
      for(const review of body.reviews){
        const tr=document.createElement("tr");tr.append(cell(review.responseId),cell(review.accountName||"\u533f\u540d"),cell(date(review.createdAt)),cell(review.analysisStatus+" / revision "+review.revision));
        const action=document.createElement("td");const button=document.createElement("button");button.type="button";button.textContent="\u63a1\u7528\u3057\u3066\u89e3\u6790";
        button.addEventListener("click",async()=>{
          button.disabled=true;setStatus("\u4fdd\u7559\u3092\u89e3\u9664\u3057\u3066\u3044\u307e\u3059...");
          const accepted=await fetch("/api/staging-admin/submission-reviews/"+encodeURIComponent(review.responseId),{method:"PATCH",headers:{...headers(),"content-type":"application/json"},body:JSON.stringify({publicationStatus:"accepted"})});
          if(!accepted.ok){setStatus(await readError(accepted));button.disabled=false;return}
          const result=await accepted.json();setStatus(result.enqueued?"\u4fdd\u7559\u3092\u89e3\u9664\u3057\u3001AI\u89e3\u6790\u3092\u958b\u59cb\u3057\u307e\u3057\u305f\u3002":"\u4fdd\u7559\u3092\u89e3\u9664\u3057\u307e\u3057\u305f\u3002");await loadReviews();
        });action.append(button);tr.append(action);reviewRows.append(tr);
      }
      if(!body.reviews.length){const tr=document.createElement("tr");const td=cell("\u4fdd\u7559\u4e2d\u306e\u56de\u7b54\u306f\u3042\u308a\u307e\u305b\u3093\u3002","empty");td.colSpan=5;tr.append(td);reviewRows.append(tr)}
      setStatus(body.page.total+"\u4ef6\u306e\u4fdd\u7559\u56de\u7b54\u3092\u8868\u793a");
    }
    document.getElementById("load").addEventListener("click",()=>loadAccounts().catch(()=>setStatus("\u901a\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002")));
    document.getElementById("reviews").addEventListener("click",()=>loadReviews().catch(()=>setStatus("\u901a\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002")));
    document.getElementById("clear").addEventListener("click",()=>{tokenInput.value="";setStatus("\u7ba1\u7406\u30c8\u30fc\u30af\u30f3\u3092\u6d88\u53bb\u3057\u307e\u3057\u305f\u3002");tokenInput.focus()});
  </script>
</body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer"
    }
  });
}

export async function handleStagingAdminRequest(request, env, url, options = {}) {
  if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return null;
  if (!adminEnabled(env)) throw new RequestError(404, "NOT_FOUND", "route was not found");
  if (request.method === "GET" && (url.pathname === ADMIN_PREFIX || url.pathname === `${ADMIN_PREFIX}/`)) {
    return adminPage();
  }

  await requireAdmin(request, env);
  if (request.method === "GET" && url.pathname === `${ADMIN_PREFIX}/accounts`) {
    return adminJson(await listAccounts(env.DB, url));
  }
  if (request.method === "GET" && url.pathname === `${ADMIN_PREFIX}/submission-reviews`) {
    return adminJson(await listSubmissionReviews(env.DB, url));
  }
  if (request.method === "POST" && url.pathname === `${ADMIN_PREFIX}/submission-reviews/backfill`) {
    return adminJson(await backfillSubmissionReviews(env, request));
  }
  const responseReviewId = responseReviewIdFromPath(url.pathname);
  if (request.method === "PATCH" && responseReviewId) {
    return adminJson(await applySubmissionReview(env, responseReviewId, request, options.enqueueAnalysis));
  }
  const accountId = accountIdFromPath(url.pathname);
  if (request.method === "DELETE" && accountId) {
    return adminJson(await deleteAccountAndData(env.DB, accountId, request));
  }
  throw new RequestError(404, "NOT_FOUND", "route was not found");
}
