
/* ============================================================
   UI層 — ストレージアダプタ / ローカル解析呼び出し / デザイン / 部品
   ============================================================ */

/* ---------- ストレージアダプタ(本番移行時はこの4関数のみ差し替え) ---------- */
/* メモリ内実装。共有ストレージが無い/応答しない環境では、これに自動退避する。 */
const __mem = {};
const __memStore = {
  async get(k) { if (!(k in __mem)) throw new Error("not found"); return { key: k, value: __mem[k] }; },
  async set(k, v) { __mem[k] = v; return { key: k, value: v }; },
  async delete(k) { delete __mem[k]; return { key: k, deleted: true }; },
  async list(p) { return { keys: Object.keys(__mem).filter(x => x.indexOf(p || "") === 0) }; }
};
let __store = (typeof window !== "undefined" && window.storage) ? window.storage : __memStore;
let __degraded = (__store === __memStore);
const STORE_TIMEOUT = 6000;

/* ---------- Cloudflare APIアダプター(設定時だけ有効) ---------- */
const __apiConfig = (() => {
  if (typeof window === "undefined" || !window.SEISEKI_API_CONFIG) return { baseUrl: "", required: false };
  const input = window.SEISEKI_API_CONFIG;
  try {
    const url = new URL(String(input.baseUrl || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return { baseUrl: "", required: false };
    }
    return { baseUrl: url.href.replace(/\/+$/u, ""), required: input.required === true };
  } catch (e) {
    return { baseUrl: "", required: false };
  }
})();
const API_TIMEOUT = 10000;
const CLOUD_ANALYSIS_POLL_DELAYS = [500, 800, 1200, 1800, 2600, 3600, 5000, 5000];

function cloudApiEnabled() { return !!__apiConfig.baseUrl; }

function analysisDiagnosticsVisible() {
  return /seiseki-api-staging\./u.test(String(__apiConfig.baseUrl || ""));
}

function analysisValueSnapshot(value) {
  const params = value && value.params || {};
  const emotion = params && params.emo || {};
  const ideology = value && value.ideology || {};
  const finite = input => {
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  return {
    params: {
      emo: { pol: finite(emotion.pol) },
      valid: finite(params.valid),
      crit: finite(params.crit),
      motiv: finite(params.motiv)
    },
    ideology: {
      econ: finite(ideology.econ),
      soc: finite(ideology.soc),
      confidence: finite(ideology.confidence)
    }
  };
}

function normalizeAnalysisValueTrace(payload, uiAnalysis, revision) {
  const apiAnalysis = payload && payload.analysis;
  const rawTrace = apiAnalysis && apiAnalysis.diagnostics && apiAnalysis.diagnostics.valueTrace;
  if (!rawTrace || typeof rawTrace !== "object") return null;
  const source = rawTrace.source === "workers-ai" || rawTrace.source === "rules-fallback"
    ? rawTrace.source
    : "unknown";
  return {
    responseRevision: Number(rawTrace.responseRevision || revision || 0),
    source: source,
    raw: analysisValueSnapshot(rawTrace.raw),
    sanitized: analysisValueSnapshot(rawTrace.sanitized),
    api: analysisValueSnapshot(apiAnalysis),
    ui: analysisValueSnapshot(uiAnalysis)
  };
}

async function cloudApiRequest(path, options) {
  if (!cloudApiEnabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const response = await fetch(__apiConfig.baseUrl + path, { ...(options || {}), signal: controller.signal });
    let payload = null;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch (e) { payload = null; }
    }
    if (!response.ok) {
      const error = new Error((payload && payload.message) || "Cloudflare API request failed");
      error.status = response.status;
      error.code = payload && payload.error;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function cloudCreateInitialResponse(resp, token) {
  if (!cloudApiEnabled()) return null;
  const freeQids = new Set(Array.isArray(resp.freeQids) ? resp.freeQids : []);
  const answers = Object.fromEntries(
    Object.entries(resp.answers || {}).filter(([qid]) => !freeQids.has(qid))
  );
  const payload = {
    appVersion: resp.ver,
    consent: { accepted: true, version: resp.consent.version, at: resp.consent.ts },
    demo: resp.demo || {},
    answers: answers,
    freeText: resp.free || "",
    demoFlag: resp.demoFlag === true
  };
  const created = await cloudApiRequest("/api/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!created || !created.id) return null;
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

async function cloudCreateFollowUp(id, expectedRevision, followUpText) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, followUpText: followUpText })
  });
}

async function cloudPatchFollowUp(id, expectedRevision, followUpText) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, followUpText: followUpText })
  });
}

async function cloudDeleteFollowUp(id, expectedRevision) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision })
  });
}

async function cloudPatchFreeText(id, expectedRevision, freeText) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/free-text", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, freeText: freeText })
  });
}

async function cloudPatchInitial(id, expectedRevision, answers, freeText) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/initial", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, answers: answers, freeText: freeText })
  });
}

async function cloudPatchAnswers(id, expectedRevision, answers) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/answers", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, answers: answers })
  });
}

async function cloudRequeueAnalysis(id, expectedRevision) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/analysis/requeue", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision })
  });
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
}

function normalizeCloudAnalysisResult(payload) {
  const knownStatuses = new Set(["pending", "running", "failed", "completed"]);
  const rawStatus = String(payload && payload.analysisStatus || "pending");
  const analysis = sanitizeAnalysis(payload && payload.analysis);
  const valueTrace = normalizeAnalysisValueTrace(payload, analysis, payload && payload.revision);
  if (valueTrace && analysisDiagnosticsVisible() && typeof console !== "undefined" && console.info) {
    console.info("[SEISEKI analysis value trace]", valueTrace);
  }
  return {
    status: knownStatuses.has(rawStatus) ? rawStatus : "pending",
    analysis: analysis,
    valueTrace: valueTrace,
    errorCode: String(payload && payload.errorCode || ""),
    revision: Number(payload && payload.revision || 0),
    updatedAt: Number(payload && payload.updatedAt || 0),
    lastActivityAt: Number(payload && payload.lastActivityAt || 0),
    startedAt: Number(payload && payload.startedAt || 0),
    completedAt: Number(payload && payload.completedAt || 0),
    leaseUntil: Number(payload && payload.leaseUntil || 0),
    stalled: payload && payload.stalled === true,
    retryable: payload && payload.retryable === true,
    mode: analysis && analysis.engine === "rules-fallback-v1" ? "fallback" : "ai"
  };
}

function analysisStateLabel(response) {
  if (!response) return null;
  if (response.analysis && response.analysis.engine === "rules-fallback-v1") {
    return { tone: "warning", title: "規則による代替解析", detail: "AI解析が完了しなかったため、保存済み回答を規則解析で処理しました。" };
  }
  if (response.cloudAnalysisStalled === true) {
    return { tone: "warning", title: "AI解析が停止している可能性", detail: "回答本文は保存済みです。現在revisionだけを再試行できます。" };
  }
  if (response.cloudAnalysisStatus === "running") {
    return { tone: "neutral", title: "AI解析中", detail: "回答は保存済みです。解析完了後に結果と意見ノードへ反映されます。" };
  }
  if (response.cloudAnalysisStatus === "pending") {
    return { tone: "neutral", title: "AI解析待ち", detail: "回答は保存済みです。順番に解析されます。" };
  }
  if (response.cloudAnalysisStatus === "failed") {
    return { tone: "error", title: "AI解析に失敗", detail: "回答は保存されていますが、解析結果と意見ノードはまだ作成されていません。" };
  }
  if (response.analysisSource === "cloudflare") {
    return { tone: "success", title: "AI解析完了", detail: "解析結果と抽出された意見ノードを保存しました。" };
  }
  return null;
}

async function cloudLoadConfig() {
  if (!cloudApiEnabled()) return null;
  const payload = await cloudApiRequest("/api/config");
  const questions = sanitizeQuestions(payload && payload.questions);
  return questions ? { questions: questions } : null;
}

async function cloudWaitForResponseAnalysis(id) {
  for (let index = 0; index <= CLOUD_ANALYSIS_POLL_DELAYS.length; index += 1) {
    const result = await cloudLoadResponseAnalysis(id);
    if (result && result.status === "completed" && result.analysis) return result;
    if (result && result.status === "failed") return result;
    if (index < CLOUD_ANALYSIS_POLL_DELAYS.length) {
      await new Promise(resolve => setTimeout(resolve, CLOUD_ANALYSIS_POLL_DELAYS[index]));
    }
  }
  return { status: "pending", analysis: null, errorCode: "" };
}

/* 前回終了時にCloudflare解析がpendingだった回答を再照合する。
   更新があった場合は集計を回答原本から再構築し、暫定解析の二重計上を避ける。 */
async function reconcileCloudAnalyses() {
  if (!cloudApiEnabled()) return { checked: 0, updated: 0 };
  const keys = await sList("resp:");
  let checked = 0;
  let updated = 0;
  for (const key of keys) {
    const response = await sGet(key);
    if (!response || !response.remoteId || response.cloudAnalysisStatus === "completed") continue;
    checked += 1;
    try {
      const result = await cloudLoadResponseAnalysis(response.remoteId);
      if (!result) continue;
      if (result.status === "completed" && result.analysis) {
        await sSet(key, {
          ...response,
          analysis: result.analysis,
          analysisSource: "cloudflare",
          cloudAnalysisStatus: "completed",
          cloudAnalysisMode: result.mode,
          analysisValueTrace: result.valueTrace || null
        });
        updated += 1;
      } else if (result.status === "failed" || result.status === "running" || result.status === "pending") {
        await sSet(key, { ...response, cloudAnalysisStatus: result.status });
      }
    } catch (error) {
      console.warn("cloud analysis reconciliation failed", error);
    }
  }
  if (updated > 0) await rebuildAgg(null, { reanalyze: false });
  return { checked: checked, updated: updated };
}

async function cloudLoadDemoResponses() {
  if (!cloudApiEnabled()) return [];
  const payload = await cloudApiRequest("/api/demo-responses");
  return payload && Array.isArray(payload.responses) ? payload.responses : [];
}

async function cloudLoadPublicAggregate() {
  if (!cloudApiEnabled()) return null;
  const payload = await cloudApiRequest("/api/public-aggregate");
  if (!payload || typeof payload !== "object") return null;
  const base = newAgg();
  return {
    ...base,
    ...payload,
    demo: { ...base.demo, ...(payload.demo || {}) },
    questions: payload.questions || {},
    ideology: { ...base.ideology, ...(payload.ideology || {}), points: Array.isArray(payload.ideology && payload.ideology.points) ? payload.ideology.points : [] },
    topics: payload.topics || {},
    targets: payload.targets || {},
    cross: payload.cross || {},
    series: payload.series || {},
    rtree: payload.rtree || {},
    net: { ...base.net, ...(payload.net || {}), nodes: (payload.net && payload.net.nodes) || {}, links: (payload.net && payload.net.links) || {} },
    opinions: Array.isArray(payload.opinions) ? payload.opinions : []
  };
}

function withCloudDemos(base, demos) {
  const combined = JSON.parse(JSON.stringify(base || newAgg()));
  for (const raw of demos || []) {
    const response = sanitizeResponse(raw);
    if (response && response.demoFlag && response.analysis) mergeResponse(combined, response);
  }
  return combined;
}

function cloudAccountRecord(result, fallbackToken) {
  const account = result && result.account;
  if (!account || !account.name) return null;
  return {
    v: 2,
    name: account.name,
    respId: account.responseId || null,
    token: result.token || fallbackToken || "",
    expiresAt: result.expiresAt || 0,
    remote: true
  };
}

async function cloudAccountCall(path, method, body, token) {
  const headers = { ...(token ? { authorization: "Bearer " + token } : {}) };
  const options = { method: method, headers: headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return cloudApiRequest(path, options);
}

async function cloudLoadOwnResponse(id, token) {
  if (!cloudApiEnabled() || !id || !token) return null;
  const payload = await cloudAccountCall("/api/accounts/me/responses", "GET", undefined, token);
  const raw = payload && Array.isArray(payload.responses)
    ? payload.responses.find(response => response && response.id === id)
    : null;
  const response = sanitizeResponse(raw);
  if (response) {
    const rawRevision = Number(raw && raw.revision || response.revision || response.seq || 1);
    let state = normalizeCloudAnalysisResult(raw);
    try {
      const currentState = await cloudLoadResponseAnalysis(id);
      if (currentState && Number(currentState.revision || 0) === rawRevision) state = currentState;
    } catch (error) { console.warn("current analysis metadata load failed", error); }
    response.remoteId = id;
    response.seq = 1;
    response.remoteRevision = rawRevision;
    response.revision = response.remoteRevision;
    response.followUpText = raw && raw.followUpText == null ? "" : String(raw && raw.followUpText || "");
    response.followUpSubmitted = !!(raw && raw.followUpSubmitted === true);
    response.updatedAt = Number(raw && raw.updatedAt || response.updatedAt || response.ts || 0);
    response.analysis = state.analysis;
    response.analysisValueTrace = state.valueTrace || null;
    response.analysisSource = "cloudflare";
    response.cloudAnalysisStatus = state.status;
    response.cloudAnalysisMode = state.mode;
    response.cloudAnalysisErrorCode = state.errorCode;
    response.cloudAnalysisUpdatedAt = state.updatedAt || response.updatedAt;
    response.cloudAnalysisLastActivityAt = state.lastActivityAt;
    response.cloudAnalysisStartedAt = state.startedAt;
    response.cloudAnalysisCompletedAt = state.completedAt;
    response.cloudAnalysisLeaseUntil = state.leaseUntil;
    response.cloudAnalysisStalled = state.stalled;
    response.cloudAnalysisRetryable = state.retryable;
  }
  return response;
}

function cloudRegistrationError(error) {
  const code = String(error && error.code || "");
  if (code === "ACCOUNT_EXISTS") return "この名前は既に使われています";
  if (code === "ORIGIN_NOT_ALLOWED") return "この確認画面から登録APIへ接続できません (ORIGIN_NOT_ALLOWED)";
  if (code === "AUTH_KDF_FAILED") return "認証処理が実行環境の上限を超えました (AUTH_KDF_FAILED)";
  if (code === "AUTH_CONFIG_INVALID") return "認証設定が不正です (AUTH_CONFIG_INVALID)";
  if (Number(error && error.status) === 429) return "登録が混み合っています (HTTP 429)";
  if (code) return "登録に失敗しました (" + code + ")";
  if (error && error.name === "AbortError") return "登録APIが時間内に応答しませんでした";
  return "登録に失敗しました (HTTP " + String(error && error.status || "通信エラー") + ")";
}

async function cloudDeleteResponse(id) {
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
}

/* 応答が返らないと画面がロード中のまま固まるため、必ずタイムアウトさせる。
   一度でも無応答なら以降はメモリ内実装へ切り替え、アプリを継続動作させる。 */
function __call(method, args) {
  if (__store === __memStore) return __memStore[method].apply(__memStore, args);
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      __degraded = true;
      __store = __memStore;
      console.warn("storage timeout: メモリ内保存に切り替えました");
      __memStore[method].apply(__memStore, args).then(resolve, reject);
    }, STORE_TIMEOUT);
    Promise.resolve()
      .then(() => __store[method].apply(__store, args))
      .then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
            e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
function storageDegraded() { return __degraded; }

async function sGet(key) {
  try {
    const r = await __call("get", [PREFIX + key, true]);
    return (r && r.value !== undefined && r.value !== null) ? JSON.parse(r.value) : null;
  } catch (e) { return null; }
}
async function sSet(key, val) {
  try { const r = await __call("set", [PREFIX + key, JSON.stringify(val), true]); return !!r; }
  catch (e) { console.error("storage set:", key, e); return false; }
}
async function sDel(key) { try { await __call("delete", [PREFIX + key, true]); return true; } catch (e) { return false; } }
async function sList(prefix) {
  try {
    const r = await __call("list", [PREFIX + prefix, true]);
    return ((r && r.keys) || []).map(k => k.slice(PREFIX.length));
  } catch (e) { return []; }
}

/* ---------- 個人スコープ(shared=false)——本人だけが読める領域 ----------
   統計は共有スコープだが、書きかけの下書きや自分の回答IDは他人に見えてはならない。
   このアプリで個人を識別する情報を保存するのはここだけで、内容は端末内に閉じる。 */
async function pGet(key) {
  try {
    const r = await __call("get", [PREFIX + key, false]);
    return (r && r.value !== undefined && r.value !== null) ? JSON.parse(r.value) : null;
  } catch (e) { return null; }
}
async function pSet(key, val) {
  try { const r = await __call("set", [PREFIX + key, JSON.stringify(val), false]); return !!r; }
  catch (e) { return false; }
}
async function pDel(key) { try { await __call("delete", [PREFIX + key, false]); return true; } catch (e) { return false; } }

/* ---------- アカウント(v0.15) ----------
   基本方針: 「閲覧は誰でも・発言(回答)は登録者」。
   ニックネーム+パスワードのみで登録し、本名は使わない。パスワードは
   PBKDF2(12万回)のハッシュのみ保存。回答IDをアカウントに紐付けることで、
   端末が変わっても ログイン → 自分の回答の確認・追記・撤回 ができる。
   注意: 試作の保存領域は全クライアントから読めるため、これは攻撃コストを
   上げる措置にすぎない。パスワードの使い回し禁止をUIで必ず明示する。 */
async function acctStorageKey(name) {
  return "acct:" + (await sha256Hex("acct|" + name)).slice(0, 32);
}
function normAcctName(s) { return cleanStr(s, 20); }
async function acctGet(name, strictRemote) {
  const nm = normAcctName(name);
  if (!nm) return null;
  if (cloudApiEnabled()) {
    const session = await pGet("session:current");
    if (!session || !session.token) {
      if (strictRemote) {
        const error = new Error("remote account session is missing");
        error.status = 401;
        error.code = "AUTH_SESSION_MISSING";
        throw error;
      }
      return null;
    }
    try {
      const result = await cloudAccountCall("/api/accounts/me", "GET", undefined, session.token);
      const record = cloudAccountRecord(result, session.token);
      if (!record && strictRemote) {
        const error = new Error("remote account payload is invalid");
        error.code = "ACCOUNT_PAYLOAD_INVALID";
        throw error;
      }
      return record;
    } catch (e) {
      if (strictRemote) throw e;
      return null;
    }
  }
  return await sGet(await acctStorageKey(nm));
}
async function acctRegister(name, pass) {
  const nm = normAcctName(name);
  if (nm.length < 2) return { error: "名前は2〜20文字で入力してください(本名は使わないでください)" };
  if (String(pass).length < 8) return { error: "パスワードは8文字以上にしてください" };
  if (cloudApiEnabled()) {
    try {
      const result = await cloudAccountCall("/api/accounts/register", "POST", { name: nm, password: String(pass) });
      return { acct: cloudAccountRecord(result) };
    } catch (e) {
      return { error: cloudRegistrationError(e) };
    }
  }
  const key = await acctStorageKey(nm);
  if (await sGet(key)) return { error: "この名前は既に使われています" };
  const salt = randomSaltHex();
  const hash = await pbkdf2Hex(pass, salt, 120000);
  const rec = { v: 1, name: nm, salt: salt, iter: 120000, hash: hash, createdAt: Date.now(), respId: null };
  const ok = await sSet(key, rec);
  return ok ? { acct: rec } : { error: "登録の保存に失敗しました" };
}
async function acctLogin(name, pass) {
  if (cloudApiEnabled()) {
    try {
      const result = await cloudAccountCall("/api/accounts/login", "POST", { name: normAcctName(name), password: String(pass) });
      return { acct: cloudAccountRecord(result) };
    } catch (e) { return { error: "名前かパスワードが違います" }; }
  }
  const rec = await acctGet(name);
  if (!rec) return { error: "名前かパスワードが違います" };
  const hash = await pbkdf2Hex(pass, rec.salt, rec.iter || 120000);
  if (hash !== rec.hash) return { error: "名前かパスワードが違います" };
  return { acct: rec };
}
async function acctBindResp(name, respId) {
  if (cloudApiEnabled()) return true;
  const rec = await acctGet(name);
  if (!rec) return false;
  rec.respId = respId;
  return await sSet(await acctStorageKey(rec.name), rec);
}
async function acctUpdate(name, currentPass, nextName, nextPass) {
  if (cloudApiEnabled()) {
    const session = await pGet("session:current");
    if (!session || !session.token) return { error: "ログインし直してください" };
    try {
      const result = await cloudAccountCall("/api/accounts/me", "PATCH", {
        currentPassword: String(currentPass),
        name: normAcctName(nextName),
        newPassword: String(nextPass || "") || undefined
      }, session.token);
      return { acct: cloudAccountRecord(result) };
    } catch (e) {
      if (e && e.code === "ACCOUNT_EXISTS") return { error: "この名前は既に使われています" };
      if (e && e.code === "INVALID_CREDENTIALS") return { error: "現在のパスワードが違います" };
      return { error: "アカウント情報の更新に失敗しました" };
    }
  }
  const verified = await acctLogin(name, currentPass);
  if (verified.error) return { error: "現在のパスワードが違います" };
  const nm = normAcctName(nextName);
  if (nm.length < 2) return { error: "名前は2〜20文字で入力してください(本名は使わないでください)" };
  const replacement = String(nextPass || "");
  if (replacement && replacement.length < 8) return { error: "新しいパスワードは8文字以上にしてください" };

  const oldRec = verified.acct;
  const oldKey = await acctStorageKey(oldRec.name);
  const nextKey = await acctStorageKey(nm);
  if (nextKey !== oldKey && await sGet(nextKey)) return { error: "この名前は既に使われています" };

  const rec = { ...oldRec, name: nm, updatedAt: Date.now() };
  if (replacement) {
    rec.salt = randomSaltHex();
    rec.iter = 120000;
    rec.hash = await pbkdf2Hex(replacement, rec.salt, rec.iter);
  }
  if (!await sSet(nextKey, rec)) return { error: "アカウント情報の保存に失敗しました" };
  if (nextKey !== oldKey && !await sDel(oldKey)) {
    await sDel(nextKey);
    return { error: "名前の変更を完了できませんでした。元の名前でログインしてください" };
  }
  return { acct: rec };
}

/* ---------- 集計の再構築(全回答から作り直す共通処理) ----------
   通常は回答を変更しない。明示的に reanalyze=true が渡された場合だけ、
   旧フォールバックでチャンクが空になった回答をローカル規則解析で補完する。 */
async function rebuildAgg(onProg, options) {
  const opts = options || {};
  let qs = DEFAULT_QUESTIONS;
  if (opts.reanalyze) {
    qs = sanitizeQuestions(opts.questions) || sanitizeQuestions(await sGet("config:questions")) || DEFAULT_QUESTIONS;
  }
  const keys = await sList("resp:");
  const items = [];
  let reanalyzed = 0, failed = 0;
  for (let i = 0; i < keys.length; i++) {
    let r = await sGet(keys[i]);
    if (r && opts.reanalyze && needsLocalReanalysis(r)) {
      const repaired = { ...r, analysis: heuristicAnalysis(r, qs) };
      if (await sSet(keys[i], repaired)) { r = repaired; reanalyzed++; }
      else failed++;
    }
    if (r) items.push(r);
    if (onProg) onProg(i + 1, keys.length, reanalyzed);
  }
  items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const na = newAgg();
  for (const r of items) mergeResponse(na, r);
  await sSet("agg:summary", na);
  return { total: items.length, reanalyzed: reanalyzed, failed: failed };
}

/* ---------- 解析呼び出し(APIレス互換アダプタ) ----------
   呼び出し側の境界を残し、将来サーバー解析へ差し替えられるようにする。
   入力は外部送信しない。端末内で完結する。
     1) 声析ローカルモデル（20.6MB・学習した値）
     2) 受け取れていない/対応していない端末 → 従来の規則解析 */
async function callAI(resp, questions) {
  if (typeof SeisekiLocalBridge !== "undefined" && SeisekiLocalBridge.available()) {
    return SeisekiLocalBridge.analyze(resp, questions, heuristicAnalysis);
  }
  return heuristicAnalysis(resp, questions);
}

/* 端末内解析の種別。画面の注記を出し分けるために使う */
const SEISEKI_LOCAL_ENGINE = "seiseki-local-v1";
function isLocalEngine(an) {
  return !!an && (an.engine === LOCAL_ANALYSIS_ENGINE || an.engine === SEISEKI_LOCAL_ENGINE);
}
function localEngineNote(an) {
  if (!an) return null;
  if (an.engine === SEISEKI_LOCAL_ENGINE) return "※ 端末内のモデルによる推定値です（AIより精度が落ちます）";
  if (an.engine === LOCAL_ANALYSIS_ENGINE) return "※ 端末内の規則解析による推定値です";
  return null;
}

/* ---------- デザイントークン(白書 × 計測器) ---------- */
const C = {
  paper: "#FAFAF9", ink: "#22211C", sub: "#8A8677", rule: "#E6E3DA", soft: "#F1EFE8",
  card: "#FFFFFF",
  green: "#175E54", greenSoft: "#E3EEEA",
  karashi: "#A8700F", karashiSoft: "#F6ECD7",
  bengara: "#A3512B", bengaraSoft: "#F4E4DB",
  slate: "#3D5573", slateSoft: "#E6EAF1",
  gray: "#9C988B"
};
const FONT_BODY = '"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif';
const FONT_DISP = '"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif';
const FONT_MONO = '"IBM Plex Mono","SF Mono","Consolas",monospace';

const SUP_COLORS = {
  "支持する": "#175E54",
  "どちらかといえば支持する": "#6FA294",
  "どちらかといえば支持しない": "#CE9B4E",
  "支持しない": "#A3512B",
  "わからない": "#9C988B"
};
const CAT_STYLE = {
  "提言": { bg: "#E3EEEA", fg: "#175E54" },
  "不満": { bg: "#F4E4DB", fg: "#A3512B" },
  "要望": { bg: "#F6ECD7", fg: "#A8700F" },
  "評価": { bg: "#ECEBE3", fg: "#5C594E" },
  "事実主張": { bg: "#E6EAF1", fg: "#3D5573" }
};
/* 選択肢の色: 基準設問(政権支持)は意味色、その他はパレット巡回 */
const OPT_PALETTE = ["#175E54", "#3D5573", "#A8700F", "#A3512B", "#6FA294", "#8896AB", "#CE9B4E", "#C08768", "#9C988B", "#5C594E"];
function colorForOpt(q, opt, idx) {
  if (q && q.id === ANCHOR_QID && SUP_COLORS[opt]) return SUP_COLORS[opt];
  return OPT_PALETTE[idx % OPT_PALETTE.length];
}

function fmtDT(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("ja-JP") + " " + d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
function emoColor(v) { return v > 0.15 ? C.green : (v < -0.15 ? C.bengara : C.gray); }
function emoToPos(v) { return Math.round((clamp(v, -1, 1) + 1) * 50); }

/* 感情極性(-1〜+1)を色に写す。不満=弁柄、中立=灰、好意=緑。 */
function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function lerpHex(a, b, t) {
  const x = hex2rgb(a), y = hex2rgb(b);
  const u = Math.max(0, Math.min(1, t));
  const c = [0, 1, 2].map(i => Math.round(x[i] + (y[i] - x[i]) * u));
  return "#" + c.map(v => ("0" + v.toString(16)).slice(-2)).join("");
}
function colorForEmo(e) {
  const v = clamp(e, -1, 1);
  if (v < 0) return lerpHex("#B4B0A4", C.bengara, Math.min(1, -v * 1.25));
  return lerpHex("#B4B0A4", C.green, Math.min(1, v * 1.25));
}
function paramView(p) {
  if (!p || !p.n) return null;
  return {
    n: p.n,
    emoPos: emoToPos(avg(p.emo, p.n)),
    valid: Math.round(avg(p.valid, p.n)),
    crit: Math.round(avg(p.crit, p.n)),
    motiv: Math.round(avg(p.motiv, p.n))
  };
}

/* ---------- 基本部品 ---------- */
function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      html, body { margin: 0; font-family: ${FONT_BODY}; -webkit-text-size-adjust: 100%; font-synthesis: none; }
      button { font-family: inherit; cursor: pointer; }
      textarea, input, select { font-family: inherit; font-size: 14px; color: inherit; }
      @keyframes skspin { to { transform: rotate(360deg); } }
      .skspin { animation: skspin 1s linear infinite; }
      @keyframes treeAmoeba { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.045, 0.96); } }
      .tree-amoeba { transform-box: fill-box; transform-origin: center; animation: treeAmoeba 6s ease-in-out infinite; }
      @keyframes networkDrift { 0%, 100% { opacity: .36; } 50% { opacity: .68; } }
      .network-drift { animation: networkDrift 8s ease-in-out infinite; }
      .visual-action { cursor: pointer; outline: none; }
      .visual-action > rect, .visual-action > circle, .visual-action > path {
        transition: filter 180ms ease, stroke 180ms ease, stroke-width 180ms ease, opacity 180ms ease;
      }
      .visual-action:hover > rect, .visual-action:hover > circle, .visual-action:hover > path,
      .visual-action:focus-visible > rect, .visual-action:focus-visible > circle, .visual-action:focus-visible > path {
        filter: brightness(1.08) saturate(1.16) drop-shadow(0 0 5px rgba(30, 91, 74, .3));
        stroke: #1E5B4A;
        stroke-width: 3px;
      }
      .target-tree-row { transition: background 160ms ease, box-shadow 160ms ease; }
      .target-tree-row:hover, .target-tree-row:focus-visible { background: #F7F4EA !important; box-shadow: inset 3px 0 #1E5B4A; outline: none; }
      @media (prefers-reduced-motion: reduce) { .skspin, .tree-amoeba, .network-drift { animation: none; } }
    `}</style>
  );
}
function IdeologyReading({ ideology, attrs }) {
  if (!ideology) return null;
  const econ = Number(ideology.econ || 0);
  const soc = Number(ideology.soc || 0);
  const econText = econ <= -15 ? "再分配・大きな政府寄り" : econ >= 15 ? "市場競争・小さな政府寄り" : "経済軸は中央付近";
  const socText = soc <= -15 ? "市民的自由・権利拡張寄り" : soc >= 15 ? "伝統・治安・安全保障寄り" : "社会軸は中央付近";
  const interests = Array.isArray(attrs) ? attrs.slice(0, 4).filter(Boolean) : [];
  return (
    <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.65, marginTop: 8 }}>
      <div><b style={{ color: C.ink }}>座標の読み方:</b> {econText} / {socText}</div>
      <div>推定は保存済みアンケート回答と自由記述全体を参照します。中央付近は中立だけでなく、根拠不足や複数方向の相殺も含みます。</div>
      {interests.length ? <div>解析で抽出された主な関心領域: {interests.join("・")}</div> : null}
    </div>
  );
}

function AnalysisValueTrace({ trace }) {
  if (!trace) return null;
  const fmt = value => Number.isFinite(Number(value)) ? String(Number(value)) : "—";
  const row = (label, snapshot) => {
    const params = snapshot && snapshot.params || {};
    const emotion = params.emo || {};
    const ideology = snapshot && snapshot.ideology || {};
    return <div style={{ padding: "3px 0" }}><b>{label}</b>: 感情 {fmt(emotion.pol)} / 妥当性 {fmt(params.valid)} / 切実度 {fmt(params.crit)} / 意欲 {fmt(params.motiv)} / 経済 {fmt(ideology.econ)} / 社会 {fmt(ideology.soc)} / 確信度 {fmt(ideology.confidence)}</div>;
  };
  const sourceLabel = trace.source === "workers-ai" ? "Workers AI" : trace.source === "rules-fallback" ? "規則fallback" : "不明";
  return (
    <details style={{ marginTop: 10, padding: "8px 10px", background: C.soft, borderRadius: 4, fontSize: 10.5, color: C.sub }}>
      <summary style={{ cursor: "pointer", fontWeight: 700, color: C.ink }}>解析値の診断 — revision {trace.responseRevision} / {sourceLabel}</summary>
      <div style={{ marginTop: 6 }}>本文やAIの生テキストは保存せず、数値だけを追跡します。</div>
      {row(trace.source === "workers-ai" ? "AI生値" : "fallback生成値", trace.raw)}
      {row("Worker正規化", trace.sanitized)}
      {row("D1 / API取得値", trace.api)}
      {row("UI表示値", trace.ui)}
    </details>
  );
}

function Eyebrow({ children }) {
  return <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "0.14em", color: C.green, marginBottom: 4 }}>{children}</div>;
}
function H2({ eyebrow, children, sub }) {
  return (
    <div style={{ margin: "28px 0 12px" }}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 style={{ fontFamily: FONT_DISP, fontWeight: 600, fontSize: 19, margin: 0, color: C.ink }}>{children}</h2>
      {sub ? <div style={{ fontSize: 12, color: C.sub, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}
function Card({ children, style, pad }) {
  return <div style={{ background: C.card, border: "1px solid " + C.rule, borderRadius: 6, padding: pad === undefined ? 16 : pad, ...style }}>{children}</div>;
}
function Btn({ children, onClick, kind, disabled, small, style, type }) {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: small ? "6px 12px" : "10px 18px", fontSize: small ? 12 : 14, fontWeight: 500,
    borderRadius: 4, border: "1px solid transparent",
    opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer"
  };
  const kinds = {
    primary: { background: C.green, color: "#fff", borderColor: C.green },
    ghost: { background: "transparent", color: C.ink, borderColor: C.rule },
    danger: { background: "transparent", color: C.bengara, borderColor: C.bengara }
  };
  return (
    <button type={type || "button"} onClick={disabled ? undefined : onClick} disabled={disabled} style={{ ...base, ...(kinds[kind || "primary"]), ...style }}>
      {children}
    </button>
  );
}
function Chip({ active, onClick, children, count }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 11px", fontSize: 12, borderRadius: 99,
      border: "1px solid " + (active ? C.green : C.rule),
      background: active ? C.green : C.card, color: active ? "#fff" : C.ink
    }}>
      {children}
      {count !== undefined ? <span style={{ fontFamily: FONT_MONO, fontSize: 10, marginLeft: 5, opacity: 0.75 }}>{count}</span> : null}
    </button>
  );
}
function Badge({ cat }) {
  const s = CAT_STYLE[cat] || CAT_STYLE["評価"];
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, background: s.bg, color: s.fg }}>{cat}</span>;
}
function FactBadge({ fact }) {
  if (fact !== "要検証") return null;
  return (
    <span title="事実関係が未確認の記述です(真偽の断定ではありません)"
      style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, border: "1px solid " + C.karashi, color: C.karashi }}>
      要検証
    </span>
  );
}
function MeterBar({ label, value, color, note, small }) {
  const v = Math.round(clamp(value, 0, 100));
  return (
    <div style={{ marginBottom: small ? 7 : 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
        <span style={{ fontSize: small ? 11 : 12, color: C.ink }}>
          {label}
          {note ? <span style={{ color: C.sub, fontSize: 10, marginLeft: 5 }}>{note}</span> : null}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: small ? 11 : 12, color: C.ink }}>{v}</span>
      </div>
      <div style={{ position: "relative", height: small ? 7 : 10, background: C.soft, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, display: "flex", width: "100%" }}>
          <div style={{ width: "25%", borderRight: "1px solid " + C.rule }} />
          <div style={{ width: "25%", borderRight: "1px solid " + C.rule }} />
          <div style={{ width: "25%", borderRight: "1px solid " + C.rule }} />
        </div>
        <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: v + "%", background: color || C.green }} />
      </div>
    </div>
  );
}
function IdeoMap({ points, me, avgPt, height, confidence }) {
  const h = height || 190;
  const px = v => ((clamp(v, -100, 100) + 100) / 200) * 100;
  const confidenceValue = Number.isFinite(Number(confidence)) ? Math.round(clamp(confidence, 0, 100)) : null;
  const confidenceLabel = confidenceValue == null ? "" : confidenceValue < 35 ? "低め" : confidenceValue < 70 ? "中程度" : "高め";
  const axisLabel = { position: "absolute", zIndex: 2, fontSize: 9, lineHeight: 1.25, color: C.sub, background: C.card, padding: "2px 4px", borderRadius: 3, pointerEvents: "none" };
  return (
    <div>
      <div style={{ position: "relative", width: "100%", height: h, background: C.soft, border: "1px solid " + C.rule, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.rule }} />
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: C.rule }} />
        <div style={{ ...axisLabel, left: 5, top: "50%", transform: "translateY(-50%)", maxWidth: "42%" }}>再分配・大きな政府</div>
        <div style={{ ...axisLabel, right: 5, top: "50%", transform: "translateY(-50%)", maxWidth: "42%", textAlign: "right" }}>市場競争・小さな政府</div>
        <div style={{ ...axisLabel, left: "50%", top: 5, transform: "translateX(-50%)", textAlign: "center", maxWidth: "72%" }}>伝統・治安・安全保障重視</div>
        <div style={{ ...axisLabel, left: "50%", bottom: 5, transform: "translateX(-50%)", textAlign: "center", maxWidth: "72%" }}>市民的自由・権利拡張</div>
        {(points || []).map((p, i) => (
          <div key={i} title={p.g + " / 経済" + p.e + " 社会" + p.s} style={{
            position: "absolute",
            left: "calc(" + px(p.e) + "% - 4px)",
            top: "calc(" + (100 - px(p.s)) + "% - 4px)",
            width: 8, height: 8, borderRadius: 99,
            background: SUP_COLORS[p.g] || C.gray, opacity: 0.75
          }} />
        ))}
        {avgPt ? (
          <div title={"全体平均 / 経済" + Math.round(avgPt.e) + " 社会" + Math.round(avgPt.s)} style={{
            position: "absolute",
            left: "calc(" + px(avgPt.e) + "% - 7px)",
            top: "calc(" + (100 - px(avgPt.s)) + "% - 7px)",
            width: 14, height: 14, borderRadius: 99, border: "2px solid " + C.ink, background: C.card
          }} />
        ) : null}
        {me ? (
          <div title={"あなた / 経済" + Math.round(me.e) + " 社会" + Math.round(me.s)} style={{
            position: "absolute",
            left: "calc(" + px(me.e) + "% - 7px)",
            top: "calc(" + (100 - px(me.s)) + "% - 7px)",
            width: 14, height: 14, borderRadius: 99, background: C.green, border: "2px solid #fff", boxShadow: "0 0 0 1px " + C.green
          }} />
        ) : null}
      </div>
      {confidenceValue == null ? null : (
        <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>推定確信度 {confidenceValue}%（{confidenceLabel}） — 根拠量と一貫性の目安で、正しさの確率ではありません。</div>
      )}
    </div>
  );
}
function Spinner() {
  return <div className="skspin" style={{ width: 34, height: 34, borderRadius: 99, border: "3px solid " + C.rule, borderTopColor: C.green }} />;
}
function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", fontSize: 13, padding: "9px 18px", borderRadius: 99, zIndex: 50, maxWidth: "90%" }}>
      {msg}
    </div>
  );
}
function OpinionCard({ o, compact }) {
  return (
    <Card pad={12}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 5 }}>
        <Badge cat={o.cat} />
        <FactBadge fact={o.fact} />
        <span style={{ fontSize: 11, color: C.green, background: C.greenSoft, padding: "2px 8px", borderRadius: 3 }}>{o.topic}</span>
        <span style={{ fontSize: 11, color: C.sub }}>{o.tt}{o.tn ? "・" + o.tn : ""}</span>
        {o.dm ? <span style={{ fontSize: 10, color: C.sub, border: "1px solid " + C.rule, padding: "1px 6px", borderRadius: 3 }}>デモ</span> : null}
      </div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{o.s}</div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 6, fontSize: 11, color: C.sub, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: emoColor(o.emo), display: "inline-block" }} />
          感情 <span style={{ fontFamily: FONT_MONO }}>{o.emo > 0 ? "+" : ""}{Number(o.emo).toFixed(1)}</span>
        </span>
        <span>切実度 <span style={{ fontFamily: FONT_MONO }}>{o.crit}</span></span>
        {!compact && o.ts ? <span style={{ marginLeft: "auto" }}>{o.age}{o.region ? "・" + o.region : ""} / {fmtDT(o.ts)}</span> : null}
      </div>
    </Card>
  );
}
function KPI({ label, value, unit }) {
  return (
    <Card pad={14} style={{ flex: "1 1 130px", minWidth: 130 }}>
      <div style={{ fontSize: 11, color: C.sub }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 26, fontWeight: 500, color: C.ink, lineHeight: 1.3 }}>
        {value}<span style={{ fontSize: 12, color: C.sub, marginLeft: 3 }}>{unit}</span>
      </div>
    </Card>
  );
}

/* ============================================================
   ルート
   ============================================================ */
const NAVS = [["survey", "回答する"], ["home", "概要"], ["dash", "ダッシュボード"], ["tree", "意見ツリー"], ["quantum", "量子観測"], ["opinions", "意見一覧"]];
const VIEW_PATHS = {
  entry: "/",
  home: "/app",
  survey: "/survey",
  surveyEdit: "/survey/edit-initial",
  followup: "/survey/follow-up",
  followupEdit: "/survey/follow-up/edit",
  complete: "/survey/complete",
  dash: "/app/dashboard",
  tree: "/app/tree",
  quantum: "/app/quantum",
  opinions: "/app/opinions",
  mine: "/account/response",
  admin: "/admin"
};
const VIEW_PATH_ALIASES = { "/app/network": "tree", "/app/stats": "dash" };

function viewFromPath(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  for (const key of Object.keys(VIEW_PATHS)) {
    if (VIEW_PATHS[key] === path) return key;
  }
  return VIEW_PATH_ALIASES[path] || "entry";
}

function currentPath() {
  return typeof window !== "undefined" && window.location ? window.location.pathname : "/";
}

const QUANTUM_PREVIEW_URL = "/quantum/chunk-network-entanglement-preview.html?count=10000&seed=prototype-10000&theme=dark&rev=quantum-embedded-v1";

function QuantumObservation() {
  return (
    <section aria-label="量子観測" style={{ width: "100%", height: "calc(100vh - 72px)", minHeight: 640, background: "#03060b" }}>
      <iframe
        title="SEISEKI 量子観測"
        src={QUANTUM_PREVIEW_URL}
        style={{ display: "block", width: "100%", height: "100%", border: 0, background: "#03060b" }}
        allowFullScreen
      />
    </section>
  );
}

function AccountMenu({ session, goto, onLogout }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [session && session.name]);

  if (!session) {
    return (
      <button onClick={() => goto("entry")} style={{
        marginLeft: "auto", padding: "6px 11px", borderRadius: 4,
        border: "1px solid " + C.rule, background: C.card, color: C.ink, fontSize: 12, whiteSpace: "nowrap"
      }}>ログイン</button>
    );
  }

  const initial = Array.from(String(session.name || "?"))[0] || "?";
  const menuAction = {
    width: "100%", border: "none", background: "transparent", color: C.ink,
    padding: "9px 10px", textAlign: "left", borderRadius: 4, fontSize: 13
  };

  return (
    <div style={{ position: "relative", marginLeft: "auto", zIndex: 36 }}>
      <button
        title="アカウントメニュー"
        aria-label={session.name + " のアカウントメニュー"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          width: 34, height: 34, borderRadius: "50%", border: "1px solid " + C.green,
          background: open ? C.green : C.card, color: open ? "#FFFFFF" : C.green,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontFamily: FONT_DISP, fontSize: 15, fontWeight: 700
        }}
      >{initial}</button>
      {open ? (
        <>
          <button aria-label="アカウントメニューを閉じる" onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 34, border: "none", background: "transparent", cursor: "default" }} />
          <div role="menu" style={{
            position: "absolute", right: 0, top: 42, zIndex: 35,
            width: "min(320px, calc(100vw - 32px))", padding: 10,
            background: C.card, border: "1px solid " + C.rule, borderRadius: 6,
            boxShadow: "0 12px 34px rgba(31, 35, 33, .16)"
          }}>
            <div style={{ padding: "4px 10px 9px", borderBottom: "1px solid " + C.rule, marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: C.sub }}>ログイン中</div>
              <div style={{ fontWeight: 700 }}>{session.name}</div>
            </div>
            <button role="menuitem" onClick={() => { setOpen(false); goto("mine"); }} style={menuAction}>自分の回答・アカウント設定</button>
            <button role="menuitem" onClick={() => { setOpen(false); onLogout(); }}
              style={{ ...menuAction, color: C.bengara, borderTop: "1px solid " + C.rule, marginTop: 4, borderRadius: 0 }}>ログアウト</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------- オフライン解析用データ(端末内モデル) ----------
   約20MB。受け取ると、通信が届かないときでも自由記述をこの端末で解析できる。
   受け取りは利用者が[受け取る]を押したときだけ始まる。画面を開いただけでは始まらない。
   「持っているか」は置き場を実際に見て判定するので、キャッシュを消せば未取得に戻る
   (端末側に別の旗を置くと、キャッシュだけ消えたときに嘘になる)。 */
const MODEL_SIZE_LABEL = "約20MB";

function modelBridge() {
  return (typeof SeisekiLocalBridge !== "undefined" && SeisekiLocalBridge.available())
    ? SeisekiLocalBridge : null;
}

function modelStateLabel(st) {
  const pct = st.total ? Math.round(100 * st.have / st.total) : 0;
  if (st.state === "ready") return "利用可能";
  if (st.state === "downloading") return "受信中 " + pct + "%";
  if (st.state === "partial") return "途中まで受信 " + pct + "%";
  return "未取得";
}

function useModelData() {
  const [st, setSt] = useState({ state: "unknown", have: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [justDone, setJustDone] = useState(false);   // この画面で受け取り終えたか
  const alive = useRef(true);

  function refresh() {
    const b = modelBridge();
    if (!b) { setSt({ state: "unsupported", have: 0, total: 0 }); return Promise.resolve(); }
    return b.status().then(s => { if (alive.current) setSt(s); });
  }
  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, []);

  async function start() {
    const b = modelBridge();
    if (!b || busy) return;
    setBusy(true); setMsg("");
    setSt(prev => ({ state: "downloading", have: prev.have || 0, total: prev.total || 0 }));
    await b.begin({
      onProgress: (d, t) => { if (alive.current) setSt({ state: "downloading", have: d, total: t }); },
      onError: e => { if (alive.current) setMsg((e && e.message) || "受け取れませんでした"); }
    });
    if (!alive.current) return;
    setBusy(false);
    await refresh();
    if (alive.current) setJustDone(true);
  }
  function cancel() {
    const b = modelBridge();
    if (b) b.cancel();
    setBusy(false);
    refresh();
  }
  async function drop() {
    const b = modelBridge();
    if (!b || busy) return;
    setBusy(true);
    await b.remove();
    if (!alive.current) return;
    setBusy(false); setMsg(""); setJustDone(false);
    await refresh();
  }
  return { st, busy, msg, justDone, start, cancel, drop, refresh };
}

/* プロフィール欄に置く操作盤。状態の確認・受け取り・中止・削除 */
function ModelDataPanel() {
  const m = useModelData();
  if (m.st.state === "unknown" || m.st.state === "unsupported") return null;
  const mb = v => (Number(v || 0) / 1048576).toFixed(1);
  const pct = m.st.total ? (100 * m.st.have / m.st.total) : 0;
  return (
    <div style={{ borderTop: "1px solid " + C.rule, marginTop: 16, paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>オフライン解析用データ</div>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 8, lineHeight: 1.8 }}>
        受け取ると、通信が届かないときでも自由記述をこの端末で解析できます({MODEL_SIZE_LABEL})。
        受け取らなくても回答はできます。削除すればいつでも消せます。
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>{modelStateLabel(m.st)}</span>
        {m.st.total ? <span style={{ fontSize: 11, color: C.sub }}>{mb(m.st.have)} / {mb(m.st.total)} MB</span> : null}
      </div>
      {m.st.state === "downloading" ? <MeterBar small label="受信中" value={pct} /> : null}
      {m.msg ? <div role="alert" style={{ fontSize: 11, color: C.bengara, marginBottom: 8 }}>{m.msg}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {m.st.state !== "ready" && m.st.state !== "downloading"
          ? <Btn small onClick={m.start} disabled={m.busy}>{m.st.state === "partial" ? "続きから受け取る" : "受け取る"}</Btn>
          : null}
        {m.st.state === "downloading" ? <Btn small kind="ghost" onClick={m.cancel}>中止</Btn> : null}
        {m.st.have > 0 && m.st.state !== "downloading"
          ? <Btn small kind="ghost" onClick={m.drop} disabled={m.busy}>削除</Btn> : null}
      </div>
    </div>
  );
}

/* 登録・ログインの直後、ホームに出す誘い。[あとで]を押したら以後は出さない
   (プロフィール欄からはいつでも受け取れる)。 */
function ModelDataOffer({ session }) {
  const m = useModelData();
  const [hidden, setHidden] = useState(true);   // 問い合わせが返るまでは出さない
  useEffect(() => {
    let alive = true;
    pGet("model:ask").then(v => { if (alive) setHidden(!!(v && v.declined)); });
    return () => { alive = false; };
  }, []);
  if (!session || hidden) return null;
  if (m.st.state === "unknown" || m.st.state === "unsupported") return null;
  /* 受け取り終えたら、黙って消えずに一度だけ知らせる。
     次に画面を開いたときは justDone が false なので、もう出ない。 */
  if (m.st.state === "ready") {
    if (!m.justDone) return null;
    return (
      <Card pad={12} style={{ marginBottom: 12, borderColor: C.green, background: C.greenSoft || C.soft }}>
        <div style={{ fontSize: 12, lineHeight: 1.8 }}>
          <b>オフライン解析用データを受け取りました。</b>
          <div style={{ color: C.sub }}>
            通信が届かないときでも、この端末で自由記述を解析できます。
            消したいときは「自分の回答・アカウント設定」から削除できます。
          </div>
        </div>
      </Card>
    );
  }
  const pct = m.st.total ? Math.round(100 * m.st.have / m.st.total) : 0;
  const dl = m.st.state === "downloading";
  return (
    <Card pad={12} style={{ marginBottom: 12, borderColor: C.green, background: C.greenSoft || C.soft }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, flex: 1, minWidth: 220, lineHeight: 1.8 }}>
          <b>オフライン解析用データを受け取りますか？({MODEL_SIZE_LABEL})</b>
          <div style={{ color: C.sub }}>
            受け取ると、通信が届かないときでも自由記述をこの端末で解析できます。
            あとから「自分の回答・アカウント設定」でも受け取れます。
          </div>
          {dl ? <div style={{ color: C.sub }}>受信中 {pct}% …</div> : null}
          {m.msg ? <div role="alert" style={{ color: C.bengara }}>{m.msg}</div> : null}
        </div>
        {dl ? <Btn small kind="ghost" onClick={m.cancel}>中止</Btn> : null}
        {!dl ? <Btn small onClick={m.start} disabled={m.busy}>受け取る</Btn> : null}
        {!dl ? <Btn small kind="ghost" onClick={async () => {
          await pSet("model:ask", { declined: true, ts: Date.now() });
          setHidden(true);
        }}>あとで</Btn> : null}
      </div>
    </Card>
  );
}

/* 端末内で解析したときの注記。規則解析だったときは、その旨と受け取りの入口も出す */
function LocalEngineNote({ an }) {
  const m = useModelData();
  const offer = an && an.engine === LOCAL_ANALYSIS_ENGINE
    && m.st.state !== "unknown" && m.st.state !== "unsupported" && m.st.state !== "ready";
  const pct = m.st.total ? Math.round(100 * m.st.have / m.st.total) : 0;
  return (
    <div style={{ fontSize: 11, color: C.karashi, marginTop: 8, lineHeight: 1.8 }}>
      <div>{localEngineNote(an)}</div>
      {offer ? <div style={{ color: C.sub }}>
        オフライン解析用データがまだありません。規則による簡易解析で表示しています。
      </div> : null}
      {offer && m.st.state === "downloading"
        ? <div style={{ color: C.sub }}>受信中 {pct}% …</div> : null}
      {offer && m.st.state !== "downloading"
        ? <div style={{ marginTop: 6 }}>
            <Btn small onClick={m.start} disabled={m.busy}>受け取る({MODEL_SIZE_LABEL})</Btn>
          </div> : null}
    </div>
  );
}

function AccountSettings({ session, onUpdated }) {
  const [name, setName] = useState(session.name);
  const [currentPass, setCurrentPass] = useState("");
  const [nextPass, setNextPass] = useState("");
  const [nextPass2, setNextPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(session.name); }, [session.name]);

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    if (nextPass !== nextPass2) { setErr("新しいパスワードの確認が一致しません"); return; }
    setErr(""); setBusy(true);
    const result = await acctUpdate(session.name, currentPass, name, nextPass);
    setBusy(false);
    if (result.error) { setErr(result.error); return; }
    setCurrentPass(""); setNextPass(""); setNextPass2("");
    await onUpdated(result.acct);
  }

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>アカウント設定</div>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 12 }}>名前またはパスワードを変更できます。保存には現在のパスワードが必要です。</div>
      <form onSubmit={save}>
        <Field label="名前" sub="2〜20文字。本名は使わないでください">
          <input value={name} onChange={e => setName(e.target.value)} style={{ ...INPUT_STYLE }} autoComplete="off" />
        </Field>
        <Field label="現在のパスワード">
          <input type="password" value={currentPass} onChange={e => setCurrentPass(e.target.value)}
            style={{ ...INPUT_STYLE }} autoComplete="current-password" />
        </Field>
        <Field label="新しいパスワード" sub="変更しない場合は空欄">
          <input type="password" value={nextPass} onChange={e => setNextPass(e.target.value)}
            style={{ ...INPUT_STYLE }} autoComplete="new-password" />
        </Field>
        {nextPass ? (
          <Field label="新しいパスワード(確認)">
            <input type="password" value={nextPass2} onChange={e => setNextPass2(e.target.value)}
              style={{ ...INPUT_STYLE }} autoComplete="new-password" />
          </Field>
        ) : null}
        {err ? <div role="alert" style={{ fontSize: 12, color: C.bengara, marginBottom: 10 }}>{err}</div> : null}
        <Btn type="submit" small disabled={busy || !name.trim() || !currentPass}>
          {busy ? "更新しています…" : "変更を保存"}
        </Btn>
      </form>
      <ModelDataPanel />
    </Card>
  );
}

export default function App() {
  const [view, setView] = useState(() => viewFromPath(currentPath()));
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [agg, setAgg] = useState(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const [hasDraft, setHasDraft] = useState(false);
  const [myId, setMyId] = useState("");
  const [opFilter, setOpFilter] = useState(null); // 意見ツリーから一覧へ渡す絞り込み
  const [session, setSession] = useState(null);   // ログイン中のアカウント { name, ts }
  const [completion, setCompletion] = useState(null);
  const [cloudDemos, setCloudDemos] = useState([]);
  const prevRef = useRef("home");                  // 「前の画面へ戻る」用

  useEffect(() => {
    function onPopState() { setView(viewFromPath(currentPath())); }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const q = sanitizeQuestions(await sGet("config:questions"));
      const p = sanitizePolicy(await sGet("config:policy"));
      const effectivePolicy = p && !(
        p.version === "1.3" && p.text.includes("外部AIへ送信しません")
      ) ? p : DEFAULT_POLICY;
      await reconcileCloudAnalyses();
      const a = await sGet("agg:summary");
      let demos = [];
      let cloudConfig = null;
      let cloudAggregate = null;
      if (cloudApiEnabled()) {
        const [aggregateResult, demoResult, configResult] = await Promise.allSettled([
          cloudLoadPublicAggregate(),
          cloudLoadDemoResponses(),
          cloudLoadConfig()
        ]);
        if (aggregateResult.status === "fulfilled") cloudAggregate = aggregateResult.value;
        else console.warn("cloud aggregate load failed", aggregateResult.reason);
        if (demoResult.status === "fulfilled") demos = demoResult.value;
        else console.warn("cloud demo load failed", demoResult.reason);
        if (configResult.status === "fulfilled") cloudConfig = configResult.value;
        else console.warn("cloud config load failed", configResult.reason);
      }
      if (!alive) return;
      if (cloudConfig && cloudConfig.questions) setQuestions(cloudConfig.questions);
      else if (q) setQuestions(q);
      setPolicy(effectivePolicy);
      setCloudDemos(demos);
      const visibleAggregate = withCloudDemos(cloudAggregate || a || newAgg(), demos);
      setAgg(visibleAggregate);
      /* 個人スコープ: セッション・下書き・自分の回答IDの有無を確認する */
      const dr = await pGet("draft:current");
      let ss = await pGet("session:current");
      let mid = "";
      if (ss && ss.name) {
        try {
          const rec = await acctGet(ss.name, cloudApiEnabled()); // アカウントに紐付いた回答IDを優先
          if (cloudApiEnabled() && !rec) {
            await pDel("session:current");
            ss = null;
          } else {
            mid = (rec && rec.respId) || "";
          }
        } catch (error) {
          if (Number(error && error.status) === 401) {
            await pDel("session:current");
            ss = null;
          } else {
            console.warn("account session check failed", error);
          }
        }
      } else {
        const last = await pGet("last:id");   // 旧バージョンからの引き継ぎ(端末ローカル)
        mid = (last && last.id) || "";
      }
      if (alive) {
        setHasDraft(!!dr);
        setSession(ss && ss.name ? ss : null);
        setMyId(mid);
        if (viewFromPath(currentPath()) === "complete" && mid) {
          const latest = (await sGet("resp:" + mid + "-2")) || (await sGet("resp:" + mid));
          if (latest) setCompletion({ resp: latest, agg: cloudAggregate || withCloudDemos(a || newAgg(), demos) });
        }
      }
      setReady(true);
      /* すでにオフライン解析用データを受け取っている端末なら、裏で読み込んでおく。
         持っていない端末では何も起きない(勝手に20.6MBを取りに行かない)。 */
      if (typeof SeisekiLocalBridge !== "undefined") SeisekiLocalBridge.resume();
      if (storageDegraded()) {
        notify("保存領域に接続できないため、このセッション内のみデータを保持します");
      }
    })();
    return () => { alive = false; };
  }, []);

  function notify(m) { setToast(m); window.setTimeout(() => setToast(""), 2800); }
  /* 画面遷移。前の画面を覚え、「前へ戻る」と「ホームへ」を明示的に分けられるようにする */
  function goView(v) {
    if (v !== view) prevRef.current = view;
    if (v !== "opinions") setOpFilter(null);
    const path = VIEW_PATHS[v] || VIEW_PATHS.entry;
    if (currentPath() !== path) window.history.pushState({ view: v }, "", path);
    setView(v);
    if (cloudApiEnabled() && ["home", "dash", "tree", "opinions"].includes(v)) {
      refreshAgg().catch(error => console.warn("aggregate navigation refresh failed", error));
    }
  }
  function goBack() {
    const p = prevRef.current;
    goView(p && p !== view ? p : "home");
  }

  async function onAuthed(rec) {
    const ss = { name: rec.name, ts: Date.now(), token: rec.token || "", remote: rec.remote === true };
    await pSet("session:current", ss);
    setSession(ss);
    setMyId(rec.respId || "");
    notify("ようこそ、" + rec.name + " さん");
  }
  async function onAccountUpdated(rec) {
    const ss = { name: rec.name, ts: Date.now(), token: rec.token || "", remote: rec.remote === true };
    await pSet("session:current", ss);
    setSession(ss);
    setMyId(rec.respId || "");
    notify("アカウント情報を更新しました");
  }
  async function doLogout() {
    /* セッションとの切り離し。共有端末を想定し、書きかけの下書きも消す */
    if (cloudApiEnabled() && session && session.token) {
      try { await cloudAccountCall("/api/accounts/logout", "POST", undefined, session.token); }
      catch (e) { console.warn("cloud logout failed"); }
    }
    await pDel("session:current");
    await pDel("draft:current");
    setSession(null); setHasDraft(false); setMyId("");
    if (view === "survey" || view === "mine" || view === "complete") goView("entry");
    notify("ログアウトしました(統計の閲覧は引き続きできます)");
  }

  async function refreshAgg() {
    if (cloudApiEnabled()) {
      try {
        const remote = await cloudLoadPublicAggregate();
        if (remote) { const shown = withCloudDemos(remote, cloudDemos); setAgg(shown); return shown; }
      } catch (error) {
        console.warn("cloud aggregate refresh failed", error);
      }
    }
    const a = await sGet("agg:summary");
    const local = withCloudDemos(a || newAgg(), cloudDemos);
    setAgg(local);
    return local;
  }

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: FONT_BODY, fontSize: 14, lineHeight: 1.75 }}>
      <GlobalStyle />
      <header style={{ position: "sticky", top: 0, zIndex: 30, background: "rgba(250,250,249,0.94)", backdropFilter: "blur(4px)", borderBottom: "1px solid " + C.rule }}>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "10px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button onClick={() => goView(view === "entry" ? "entry" : "home")} style={{ background: "none", border: "none", padding: 0, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: FONT_DISP, fontWeight: 700, fontSize: 20, color: C.ink }}>声析</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.18em", color: C.green }}>SEISEKI β</span>
          </button>
          {view !== "entry" ? <nav aria-label="主要メニュー" style={{ display: "flex", gap: 4, overflowX: "auto", flex: 1 }}>
            {NAVS.map(([k, label]) => {
              const active = view === k;
              const answerAction = k === "survey";
              return (
              <button key={k} onClick={() => goView(k)} style={{
                background: answerAction ? C.green : active ? C.ink : "transparent",
                color: answerAction || active ? "#fff" : C.sub,
                border: "none", borderRadius: 4, padding: "6px 11px", fontSize: 12, whiteSpace: "nowrap"
              }}>{label}{answerAction && hasDraft ? <span style={{ marginLeft: 5, color: "#fff" }}>●</span> : null}</button>
              );
            })}
          </nav> : null}
          <AccountMenu session={session} goto={goView} onLogout={doLogout} />
        </div>
      </header>

      {cloudApiEnabled() && typeof window !== "undefined" && window.SEISEKI_RUNTIME_MODE === "staging" ? (
        <div role="status" style={{ background: C.karashiSoft, borderBottom: "1px solid " + C.karashi, color: C.ink }}>
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "7px 16px", fontSize: 12 }}>
            <b>STAGING 検証環境</b> — 入力はCloudflare D1へ送信されます。実回答や個人情報は入力しないでください。
            {cloudDemos.length ? <span> 現在、合成デモ{cloudDemos.length}件を表示しています。</span> : null}
          </div>
        </div>
      ) : null}

      <main style={{ maxWidth: view === "quantum" ? "none" : 900, margin: "0 auto", padding: view === "quantum" ? 0 : "18px 16px 60px" }}>
        {!ready ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 80 }}><Spinner /></div>
        ) : view === "entry" ? (
          <Entry session={session} onAuthed={onAuthed} goto={goView} />
        ) : view === "home" ? (
          <Home agg={agg} goto={goView} hasDraft={hasDraft} myId={myId} session={session} />
        ) : view === "followup" || view === "followupEdit" ? (
          <FollowUpSurvey goto={goView} session={session} onAuthed={onAuthed} notify={notify} editExisting={view === "followupEdit"} />
        ) : view === "survey" || view === "surveyEdit" ? (
          <Survey questions={questions} policy={policy} notify={notify} onFinished={(a, result) => { const shown = withCloudDemos(a, cloudDemos); setAgg(shown); setCompletion({ ...result, agg: shown }); goView("complete"); }} goto={goView}
            startEditMode={view === "surveyEdit" ? "answers" : null}
            session={session} onAuthed={onAuthed}
            onDraftChange={d => {
              setHasDraft(d);
              if (!d && session) {
                acctGet(session.name, cloudApiEnabled())
                  .then(r => { if (r && r.respId) setMyId(r.respId); })
                  .catch(error => console.warn("account response refresh failed", error));
              }
            }} />
        ) : view === "complete" ? (
          completion ? <Completion result={completion} notify={notify} goto={goView} session={session} /> : <CompletionUnavailable goto={goView} />
        ) : view === "dash" ? (
          <Dashboard agg={agg} questions={questions} goto={goView} />
        ) : view === "tree" ? (
          <TreeView agg={agg} questions={questions} goto={goView} setOpFilter={setOpFilter} />
        ) : view === "quantum" ? (
          <QuantumObservation />
        ) : view === "opinions" ? (
          <Opinions agg={agg} initial={opFilter} goto={goView} />
        ) : view === "mine" ? (
          <MyResponse questions={questions} agg={agg} notify={notify} refreshAgg={refreshAgg} goto={goView} back={goBack} session={session} onAccountUpdated={onAccountUpdated} onResponseDeleted={() => { setMyId(""); setCompletion(null); }} />
        ) : view === "admin" ? (
          <Admin questions={questions} setQuestions={setQuestions} policy={policy} setPolicy={setPolicy} notify={notify} refreshAgg={refreshAgg} agg={agg} />
        ) : (
          <Entry session={session} onAuthed={onAuthed} goto={goView} />
        )}
      </main>

      <footer style={{ borderTop: "1px solid " + C.rule, padding: "18px 16px 26px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", fontSize: 11, color: C.sub }}>
          <div>本アプリの数値・分類は端末内の規則解析による推定であり、意味理解・事実確認・正確性を保証するものではありません。熱量は真偽や民意の強さを示しません。回答は自己選択によるもので、世論の統計的代表性はありません。声析は特定の政治的立場を支持・排除するものではありません。</div>
          <button onClick={() => goView("mine")}
            style={{ background: "none", border: "none", padding: 0, marginTop: 8, fontSize: 11, color: C.slate, textDecoration: "underline", cursor: "pointer" }}>
            自分の回答の確認・撤回(回答IDで照会できます)はこちら
          </button>
        </div>
      </footer>
      <Toast msg={toast} />
    </div>
  );
}

/* ============================================================
   入口
   ============================================================ */
function Entry({ session, onAuthed, goto }) {
  return (
    <div style={{ maxWidth: 620, margin: "22px auto 0" }}>
      <div style={{ padding: "20px 0 12px" }}>
        <Eyebrow>ACCESS</Eyebrow>
        <h1 style={{ fontFamily: FONT_DISP, fontWeight: 700, fontSize: 28, lineHeight: 1.45, margin: "0 0 8px", color: C.ink }}>
          声析を利用する
        </h1>
        <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.9 }}>
          登録・ログインすると回答の確認、二度目の自由記述、修正、撤回ができます。閲覧だけなら登録は必要ありません。
        </div>
      </div>
      <ModelDataOffer session={session} />
      {session ? (
        <Card>
          <div style={{ fontSize: 13, marginBottom: 14 }}>
            <b style={{ color: C.green }}>{session.name}</b> さんとしてログインしています。
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("home")}>概要へ進む</Btn>
            <Btn kind="ghost" onClick={() => goto("survey")}>回答する</Btn>
          </div>
        </Card>
      ) : (
        <AuthGate
          onAuthed={async rec => { await onAuthed(rec); goto("home"); }}
          goto={goto}
          destination="概要"
          guestView="home"
        />
      )}
    </div>
  );
}

/* ============================================================
   ホーム
   ============================================================ */
function Home({ agg, goto, hasDraft, myId, session }) {
  const chunkTotal = agg ? Object.values(agg.topics).reduce((s, t) => s + t.n, 0) : 0;
  const ov = agg ? overallParams(agg) : { n: 0 };
  return (
    <div>
      <ModelDataOffer session={session} />
      <div style={{ padding: "34px 0 10px" }}>
        <Eyebrow>POLITICAL OPINION QUANTIZATION</Eyebrow>
        <h1 style={{ fontFamily: FONT_DISP, fontWeight: 700, fontSize: 30, lineHeight: 1.45, margin: "0 0 10px", color: C.ink }}>
          政治への声を、<br />測れるかたちに。
        </h1>
        <p style={{ color: C.sub, maxWidth: 580, margin: 0 }}>
          声析(SEISEKI)は、アンケートと自由記述で寄せられた政治意見を端末内で規則解析し、
          感情・妥当性・切実度・意欲などのパラメータへ量子化して、匿名の統計データとして可視化する実験的プラットフォームです。
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "18px 0" }}>
        <KPI label="総回答数" value={agg ? agg.total : 0} unit="件" />
        <KPI label="抽出された意見" value={chunkTotal} unit="チャンク" />
        <KPI label="平均意欲" value={ov.n ? Math.round(ov.motiv) : "–"} unit="/100" />
        <KPI label="平均切実度" value={ov.n ? Math.round(ov.crit) : "–"} unit="/100" />
      </div>

      {hasDraft ? (
        <Card pad={13} style={{ marginBottom: 10, borderColor: C.karashi }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>
              <b>書きかけの回答があります。</b>入力は自動保存されています。続きから再開できます。
            </div>
            <Btn small onClick={() => goto("survey")}>続きから回答する</Btn>
          </div>
        </Card>
      ) : null}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Btn onClick={() => goto("survey")} style={{ flex: "1 1 200px" }}>{session && myId ? "二度目の自由記述、修正" : "最初の回答"}</Btn>
        <Btn kind="ghost" onClick={() => goto("dash")} style={{ flex: "1 1 200px" }}>統計ダッシュボードを見る</Btn>
      </div>

      {myId ? (
        <div style={{ marginTop: 10, fontSize: 12, color: C.sub }}>
          この端末から回答済みです。
          <button onClick={() => goto("mine")} style={{ background: "none", border: "none", padding: 0, marginLeft: 4, fontSize: 12, color: C.slate, textDecoration: "underline", cursor: "pointer" }}>
            自分の回答を確認・撤回する
          </button>
        </div>
      ) : null}

      {chunkTotal > 0 ? (
        <div>
          <H2 eyebrow="OPINION TREE" sub="面積は意見の数、色は平均感情。いま声が集まっている場所です">意見の広がり</H2>
          <Card pad={8} style={{ marginBottom: 8 }}>
            <TreeMap rows={topicTree(agg, 12)} w={1000} h={300} total={chunkTotal} showShare onPick={() => goto("tree")} />
          </Card>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <EmoLegend />
            <button onClick={() => goto("tree")}
              style={{ background: "none", border: "none", padding: 0, marginLeft: "auto", fontSize: 12, color: C.slate, textDecoration: "underline", cursor: "pointer" }}>
              意見ツリーを詳しく見る
            </button>
          </div>
        </div>
      ) : null}

      <H2 eyebrow="HOW IT WORKS" sub="回答は同意にもとづき匿名で処理されます">回答から統計までの流れ</H2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        {[
          ["1", "同意", "個人情報の取り扱いを確認し、同意した場合のみ回答へ進みます。"],
          ["2", "回答", "社会的属性と設問に答え、自由記述で意見・提言・不満を書きます。"],
          ["3", "ローカル解析", "語句と文型から感情・妥当性・切実度・意欲を推定し、意見をチャンクに分割します。"],
          ["4", "統計化", "似た意見や不満の対象ごとに集約し、匿名の統計として表示します。"]
        ].map(step => (
          <Card key={step[0]} pad={14}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.green }}>{step[0]}</div>
            <div style={{ fontWeight: 700, margin: "2px 0 4px" }}>{step[1]}</div>
            <div style={{ fontSize: 12, color: C.sub }}>{step[2]}</div>
          </Card>
        ))}
      </div>
      {agg && agg.total === 0 ? (
        <Card pad={14} style={{ marginTop: 18, background: C.karashiSoft, borderColor: C.karashi }}>
          <div style={{ fontSize: 13 }}>まだ回答がありません。動作確認には「管理」タブの<b>デモデータ投入</b>が便利です(架空データ・後から削除可)。</div>
        </Card>
      ) : null}
    </div>
  );
}

/* ============================================================
   回答フロー(同意 → 属性 → 設問 → ローカル解析 → 結果)
   ============================================================ */
function Progress({ idx, total }) {
  const p = Math.round((Math.min(idx, total) / total) * 100);
  return (
    <div style={{ margin: "6px 0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 10, color: C.sub, marginBottom: 3 }}>
        <span>STEP {Math.min(idx + 1, total)} / {total}</span><span>{p}%</span>
      </div>
      <div style={{ height: 3, background: C.soft, borderRadius: 2 }}>
        <div style={{ height: 3, width: p + "%", background: C.green, borderRadius: 2 }} />
      </div>
    </div>
  );
}

function FollowUpSurvey({ goto, session, onAuthed, notify, editExisting }) {
  const [current, setCurrent] = useState(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const busyRef = useRef(false);

  async function load() {
    if (!session) { setLoading(false); return; }
    setLoading(true); setErr("");
    try {
      const rec = await acctGet(session.name, true);
      if (!rec || !rec.respId) { setCurrent(null); return; }
      const response = cloudApiEnabled() && session.token
        ? await cloudLoadOwnResponse(rec.respId, session.token)
        : await sGet("resp:" + rec.respId);
      setCurrent(response || null);
      if (editExisting && response && response.followUpSubmitted) {
        setText(String(response.followUpText || ""));
      }
    } catch (error) {
      setErr("現在の回答を確認できませんでした。通信状態を確認して、もう一度試してください。");
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [session && session.name, session && session.token, editExisting]);

  async function submitFollowUp() {
    if (busyRef.current || !current) return;
    const body = sanitizeFreeText(text, 1500).trim();
    if (!body) { setErr("二度目の自由記述を入力してください。"); return; }
    const id = current.remoteId || current.id;
    const revision = Number(current.remoteRevision || current.revision || 1);
    busyRef.current = true; setErr("");
    try {
      const updated = editExisting
        ? await cloudPatchFollowUp(id, revision, body)
        : await cloudCreateFollowUp(id, revision, body);
      const next = {
        ...current,
        id: id,
        remoteId: id,
        seq: 1,
        followUpText: body,
        followUpSubmitted: true,
        revision: Number(updated.revision),
        remoteRevision: Number(updated.revision),
        analysis: null,
        analysisSource: "cloudflare",
        cloudAnalysisStatus: "pending",
        updatedAt: Number(updated.updatedAt || Date.now())
      };
      await sSet("resp:" + id, next);
      setCurrent(next); setDone(true); setText("");
      notify(editExisting
        ? "2回目の自由記述を修正しました。再解析を開始します"
        : "二度目の自由記述を保存しました。再解析を開始します");
    } catch (error) {
      if (error && error.code === "FOLLOW_UP_ALREADY_EXISTS") {
        setErr("二度目の自由記述はすでに提出済みです。変更は「回答内容の確認・修正」から行ってください。");
        await load();
      } else if (error && error.code === "REVISION_CONFLICT") {
        setErr("別の更新が先に反映されました。最新状態を読み直しました。内容を確認して再度お試しください。");
        await load();
      } else {
        setErr("二度目の自由記述を保存できませんでした" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  if (!session) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <H2 eyebrow="SECOND FREE TEXT" sub="初回回答と同じアカウントに保存します">二度目の自由記述</H2>
        <AuthGate onAuthed={onAuthed} goto={goto} />
      </div>
    );
  }
  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}><Spinner /></div>;
  if (!current) {
    return (
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <H2 eyebrow="SECOND FREE TEXT" sub="初回回答の後に一度だけ利用できます">二度目の自由記述</H2>
        <Card>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>先にアンケートと1回目の自由記述を提出してください。</div>
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginBottom: 10 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("survey")}>最初の回答へ</Btn>
            <Btn kind="ghost" onClick={load}>もう一度確認する</Btn>
          </div>
        </Card>
      </div>
    );
  }
  if (done || (current.followUpSubmitted && !editExisting)) {
    return (
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <H2 eyebrow="SECOND FREE TEXT" sub="新規提出は一度だけです">二度目の自由記述は提出済みです</H2>
        <Card>
          {current.followUpText ? <div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px", marginBottom: 12 }}>{current.followUpText}</div> : null}
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>内容を変更したい場合は、新規提出ではなく修正機能を使います。</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("mine")}>回答内容を確認・修正</Btn>
            <Btn kind="ghost" onClick={() => goto("home")}>概要へ戻る</Btn>
          </div>
        </Card>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <H2 eyebrow="SECOND FREE TEXT" sub="初回本文とは別に保存し、回答全体を再解析します">{editExisting ? "二度目の自由記述を修正" : "二度目の自由記述"}</H2>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.sub }}>1回目の自由記述</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 180, overflowY: "auto", marginTop: 5 }}>{current.free || "（記載なし）"}</div>
      </Card>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={9} maxLength={1500}
        placeholder="二度目に伝えたい意見・提言・不満を自由にお書きください"
        style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, color: C.sub, marginTop: 4 }}>
        <span>{editExisting ? "提出済みの2回目だけを書き換えます。保存すると現在回答全体を再解析します。" : "この新規提出は一度だけです。提出後の変更は修正機能から行えます。"}</span>
        <span style={{ fontFamily: FONT_MONO }}>{text.length}/1500</span>
      </div>
      {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <Btn disabled={!text.trim()} onClick={submitFollowUp}>{editExisting ? "修正を保存して再解析" : "二度目の自由記述を送信"}</Btn>
        <Btn kind="ghost" onClick={() => goto("home")}>概要へ戻る</Btn>
      </div>
    </div>
  );
}

function Survey({ questions, policy, notify, onFinished, goto, onDraftChange, session, onAuthed, startEditMode }) {
  const [phase, setPhase] = useState("consent");
  const [qi, setQi] = useState(0);
  const [agree, setAgree] = useState(false);
  const [demo, setDemo] = useState({});
  const [answers, setAnswers] = useState({});
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const [restored, setRestored] = useState(false);
  const [currentResponse, setCurrentResponse] = useState(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [currentLoadError, setCurrentLoadError] = useState("");
  const [currentLoadNonce, setCurrentLoadNonce] = useState(0);
  const [editMode, setEditMode] = useState(null); // free | answers
  const [editText, setEditText] = useState("");
  const busyRef = useRef(false);
  const loadedRef = useRef(false);
  const autoEditRef = useRef(false);
  const timerRef = useRef(null);

  const freeQids = useMemo(() => questions.filter(q => q.type === "free").map(q => q.id), [questions]);
  const totalSteps = questions.length + 2;
  const stepIdx = phase === "consent" ? 0 : phase === "demo" ? 1 : phase === "q" ? 2 + qi : totalSteps;

  /* 回答済み判定の正本はremote account responseとする。
     localStorageの有無では初回回答へ戻さない。 */
  useEffect(() => {
    let alive = true;
    setCurrentResponse(null);
    setCurrentLoadError("");
    setEditMode(null);
    autoEditRef.current = false;
    (async () => {
      if (!session) return;
      setCurrentLoading(true);
      try {
        const rec = await acctGet(session.name, true);
        if (!alive || !rec || !rec.respId) return;
        let current = null;
        if (cloudApiEnabled() && session.token) {
          current = await cloudLoadOwnResponse(rec.respId, session.token);
        }
        if (!current) current = await sGet("resp:" + rec.respId);
        if (!alive || !current) return;
        current.remoteId = current.remoteId || rec.respId;
        current.remoteRevision = Number(current.remoteRevision || current.revision || current.seq || 1);
        current.revision = current.remoteRevision;
        setCurrentResponse(current);
      } catch (error) {
        console.warn("current response load failed", error);
        if (alive) setCurrentLoadError("現在の回答を確認できませんでした。重複回答を避けるため、初回アンケートは開始していません。");
      } finally {
        if (alive) setCurrentLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [session, currentLoadNonce]);

  useEffect(() => {
    if (startEditMode !== "answers" || !currentResponse || autoEditRef.current) return;
    autoEditRef.current = true;
    setAnswers({ ...(currentResponse.answers || {}) });
    setEditText(String(currentResponse.free || ""));
    setEditMode("answers");
    setErr("");
  }, [startEditMode, currentResponse]);

  /* PATCH/requeue後は現在revisionの解析だけを追跡する。
     古いrevisionの完了通知で、編集中の回答を巻き戻さない。 */
  useEffect(() => {
    if (!session || !session.token || !currentResponse || !cloudApiEnabled()) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const status = currentResponse.cloudAnalysisStatus || currentResponse.analysisStatus || "pending";
    if (!id || (status !== "pending" && status !== "running")) return;
    let alive = true;
    let timer = null;
    async function poll() {
      try {
        const fresh = await cloudLoadOwnResponse(id, session.token);
        if (!alive || !fresh) return;
        const freshRevision = Number(fresh.remoteRevision || fresh.revision || fresh.seq || 1);
        if (freshRevision < revision) return;
        await sSet("resp:" + id, fresh);
        setCurrentResponse(fresh);
        const freshStatus = fresh.cloudAnalysisStatus || fresh.analysisStatus || "pending";
        if (freshStatus === "pending" || freshStatus === "running") {
          timer = setTimeout(poll, freshStatus === "running" ? 1800 : 4000);
        }
      } catch (error) {
        if (alive) timer = setTimeout(poll, 5000);
      }
    }
    timer = setTimeout(poll, status === "running" ? 1000 : 2500);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [
    session && session.token,
    currentResponse && (currentResponse.remoteId || currentResponse.id),
    currentResponse && Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1),
    currentResponse && (currentResponse.cloudAnalysisStatus || currentResponse.analysisStatus || "pending")
  ]);

  /* 下書きの復元。タブを移動しても、閉じても、書きかけが消えないようにする。
     下書きは個人スコープに保存されるため、他の利用者からは見えない。 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await pGet("draft:current");
      if (!alive) { loadedRef.current = true; return; }
      if (d && d.v === 1) {
        setAgree(!!d.agree);
        setDemo(d.demo || {});
        setAnswers(d.answers || {});
        setQi(Math.max(0, Math.min(Number(d.qi) || 0, questions.length - 1)));
        if (d.phase === "demo" || d.phase === "q") setPhase(d.phase);
        setRestored(true);
      }
      loadedRef.current = true;
    })();
    return () => { alive = false; };
  }, []);

  /* 入力のたびに自動保存(1秒のデバウンス)。解析中・完了後は保存しない。 */
  useEffect(() => {
    if (!loadedRef.current) return;
    if (phase !== "consent" && phase !== "demo" && phase !== "q") return;
    const hasInput = agree || Object.keys(demo).length > 0 || Object.keys(answers).length > 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!hasInput) return;
      pSet("draft:current", {
        v: 1, ts: Date.now(), phase: phase, qi: qi,
        agree: agree, demo: demo, answers: answers, pol: policy.version
      });
      if (onDraftChange) onDraftChange(true);
    }, 1000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [phase, qi, agree, demo, answers]);

  async function clearDraft() {
    if (timerRef.current) clearTimeout(timerRef.current);
    await pDel("draft:current");
    if (onDraftChange) onDraftChange(false);
  }

  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("analyzing"); setErr("");
    const free = sanitizeFreeText(freeQids.map(id => String(answers[id] || "").trim()).filter(Boolean).join("\n"), 1500);
    const base = {
      id: uid(), seq: 1, ts: Date.now(), ver: APP_VER, consent: { version: policy.version, ts: Date.now() },
      demo: demo, answers: answers, free: free, freeQids: freeQids
    };
    let analysis = null;
    let analysisSource = "local";
    let cloudAnalysisStatus = null;
    let cloudAnalysisMode = null;
    let analysisValueTrace = null;
    let remoteId = null;
    let remoteRevision = null;
    /* Cloudflare作成結果には認可情報とrevisionが含まれる。匿名manage tokenはprivate scopeへ保存する。 */
    if (cloudApiEnabled()) {
      try {
        const createdRemote = await cloudCreateInitialResponse(base, session && session.token);
        remoteId = createdRemote && createdRemote.id;
        remoteRevision = createdRemote && createdRemote.revision;
        if (!remoteId) throw new Error("Cloudflare response id was not returned");
        const remote = await cloudWaitForResponseAnalysis(remoteId);
        cloudAnalysisStatus = remote.status;
        cloudAnalysisMode = remote.mode;
        analysisValueTrace = remote.valueTrace || null;
        if (remote.status === "completed" && remote.analysis) {
          analysis = remote.analysis;
          analysisSource = "cloudflare";
        }
      }
      catch (e) {
        if (__apiConfig.required) {
          busyRef.current = false;
          const detail = e && e.code ? " (" + e.code + ")" : "";
          setErr((e && e.status
            ? "回答サーバーが入力を受理できませんでした"
            : "回答サーバーへ接続できませんでした") + detail + "。入力内容は下書きに保持されています。");
          setPhase("aifail");
          return;
        }
        notify("クラウド同期に失敗したため、この端末だけに保存します");
      }
    }
    if (!analysis) {
      if (remoteId && __apiConfig.required) {
        busyRef.current = false;
        setErr(cloudAnalysisStatus === "failed"
          ? "Cloudflare AI解析に失敗しました。回答はサーバーに保持されています。"
          : "Cloudflare AI解析が混雑しています。回答はサーバーに保持されているため、少し待ってから再読み込みしてください。");
        setPhase("aifail");
        return;
      }
      try { analysis = await callAI(base, questions); }
      catch (e) {
        busyRef.current = false;
        setErr("端末内の解析処理でエラーが発生しました。");
        setPhase("aifail");
        return;
      }
      analysisSource = remoteId ? "local-provisional" : "local";
      if (remoteId && !cloudAnalysisStatus) cloudAnalysisStatus = "pending";
    }
    const resp = {
      ...base,
      analysis,
      analysisSource: analysisSource,
      remoteId: remoteId,
      ...(remoteRevision ? { remoteRevision: remoteRevision } : {}),
      ...(remoteId ? { cloudAnalysisStatus: cloudAnalysisStatus || "pending" } : {}),
      ...(remoteId && cloudAnalysisMode ? { cloudAnalysisMode: cloudAnalysisMode } : {}),
      ...(remoteId && analysisValueTrace ? { analysisValueTrace: analysisValueTrace } : {})
    };
    const okR = await sSet("resp:" + resp.id, resp);
    const cur = (await sGet("agg:summary")) || newAgg();
    mergeResponse(cur, resp);
    const okA = await sSet("agg:summary", cur);
    if ((!okR || !okA) && remoteId) {
      try { await cloudDeleteResponse(remoteId); } catch (e) { console.error("cloud compensation delete failed", e); }
    }
    busyRef.current = false;
    if (!okR || !okA) notify("保存中にエラーが発生した可能性があります");
    /* 送信できたので下書きは破棄し、代わりに回答IDを控える(自分の回答の確認に使う) */
    await clearDraft();
    const boundId = resp.id;
    await pSet("last:id", { id: boundId, ts: resp.ts });
    if (session) await acctBindResp(session.name, boundId); // アカウントに回答を紐付け
    setResult({ resp, agg: cur });
    onFinished(cur, { resp: resp, agg: cur });
    setPhase("done");
  }

  async function refreshCurrentResponse() {
    if (!currentResponse || !session || !session.token) return null;
    const id = currentResponse.remoteId || currentResponse.id;
    const fresh = await cloudLoadOwnResponse(id, session.token);
    if (fresh) {
      await sSet("resp:" + id, fresh);
      setCurrentResponse(fresh);
    }
    return fresh;
  }

  async function handleRevisionConflict(message) {
    await refreshCurrentResponse();
    setErr(message || "別の更新が先に反映されました。最新状態を読み直しました。");
  }

  async function submitCurrentFreeText() {
    if (busyRef.current || !currentResponse) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const body = sanitizeFreeText(editText, 1500);
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudPatchFreeText(id, revision, body);
      const next = {
        ...currentResponse, id, remoteId: id,
        free: body,
        revision: Number(updated.revision), remoteRevision: Number(updated.revision),
        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending",
        updatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisUpdatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisStalled: false, cloudAnalysisRetryable: false, cloudAnalysisErrorCode: ""
      };
      await sSet("resp:" + id, next);
      setCurrentResponse(next); setEditMode(null); setEditText("");
      notify("自由記述を更新しました。再解析を開始します");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await handleRevisionConflict("別の更新が先に反映されました。最新の回答を読み直したので、内容を確認して再度編集してください。");
      } else {
        setErr("自由記述の更新に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  async function submitCurrentAnswers() {
    if (busyRef.current || !currentResponse) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const responseQuestions = Array.isArray(currentResponse.questions) && currentResponse.questions.length ? currentResponse.questions : questions;
    const editable = responseQuestions.filter(q => q.type !== "free");
    const payload = Object.fromEntries(editable.map(q => [q.id, String(answers[q.id] || "")]).filter(([, value]) => value));
    if (Object.keys(payload).length !== editable.length) {
      setErr("すべての選択式設問に回答してください。"); return;
    }
    const firstText = sanitizeFreeText(editText, 1500);
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudPatchInitial(id, revision, payload, firstText);
      const next = {
        ...currentResponse, id, remoteId: id, answers: payload, free: firstText,
        revision: Number(updated.revision), remoteRevision: Number(updated.revision),
        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending",
        updatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisUpdatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisStalled: false, cloudAnalysisRetryable: false, cloudAnalysisErrorCode: ""
      };
      await sSet("resp:" + id, next);
      setCurrentResponse(next); setEditMode(null); setEditText("");
      notify("初回回答を更新しました。現在の回答全体で再解析を開始します");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await handleRevisionConflict("別の更新が先に反映されました。最新の回答を読み直したので、内容を確認して再度編集してください。");
      } else {
        setErr("初回回答の更新に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  async function resetAll() {
    await clearDraft();
    setPhase("consent"); setAgree(false); setDemo({}); setAnswers({}); setResult(null); setQi(0); setErr(""); setRestored(false);
  }

  /* 復元されたことを知らせる帯。破棄すれば最初から。 */
  const restoreBar = restored && phase !== "done" && phase !== "analyzing" ? (
    <Card pad={12} style={{ marginBottom: 12, background: C.greenSoft || C.soft, borderColor: C.green }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
          <b>前回の入力を復元しました。</b>続きから回答できます(入力は自動保存され、他のタブを見に行っても消えません)。
        </div>
        <Btn small kind="ghost" onClick={resetAll}>破棄して最初から</Btn>
      </div>
    </Card>
  ) : null;

  /* 回答(発言)にはログインが必要。閲覧は誰でも可能なので、ここでだけ求める。 */
  if (!session) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <H2 eyebrow="SIGN IN" sub="統計の閲覧は登録不要です。回答(発言)には、匿名のユーザー登録が必要です">回答にはログイン</H2>
        <AuthGate onAuthed={onAuthed} goto={goto} />
      </div>
    );
  }

  if (currentLoading && phase === "consent") {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}><Spinner /></div>
    );
  }

  if (currentLoadError && phase === "consent") {
    return (
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <H2 eyebrow="RESPONSE CHECK" sub="既存回答の有無を確認してから回答画面を開きます">回答状況を確認できません</H2>
        <Card>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>{currentLoadError}</div>
          <Btn onClick={() => setCurrentLoadNonce(currentLoadNonce + 1)}>もう一度確認する</Btn>
        </Card>
      </div>
    );
  }

  /* 回答済みの場合は新規回答を作らず、同じ回答の続き・修正画面を開く。 */
  if (currentResponse && phase === "consent") {
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const responseQuestions = Array.isArray(currentResponse.questions) && currentResponse.questions.length ? currentResponse.questions : questions;
    const nonFreeQuestions = responseQuestions.filter(q => q.type !== "free");

    if (editMode === "free") {
      return (
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <H2 eyebrow="EDIT" sub={"回答ID " + id + " / revision " + revision}>自由記述を修正</H2>
          <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={10} maxLength={1500}
            style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.sub, marginTop: 4 }}>
            <span>現在の1回目の自由記述全文を置き換えます。保存後は置き換え後の全文を再解析します。</span>
            <span style={{ fontFamily: FONT_MONO }}>{editText.length}/1500</span>
          </div>
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn onClick={submitCurrentFreeText}>保存して再解析</Btn>
            <Btn kind="ghost" onClick={() => { setEditMode(null); setErr(""); }}>戻る</Btn>
          </div>
        </div>
      );
    }

    if (editMode === "answers") {
      const complete = nonFreeQuestions.every(q => answers[q.id]);
      return (
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <H2 eyebrow="EDIT INITIAL RESPONSE" sub={"回答ID " + id + " / revision " + revision}>初回回答を修正</H2>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            初回回答時の設問スナップショットと1回目自由記述を一緒に更新します。2回目が提出済みなら、保存後の再解析には現在の2回目も自動的に含まれます。
          </div>
          {nonFreeQuestions.map((q, index) => (
            <Card key={q.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{index + 1}. {q.text}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(q.options || []).map(option => <Chip key={option} active={answers[q.id] === option} onClick={() => setAnswers({ ...answers, [q.id]: option })}>{option}</Chip>)}
              </div>
            </Card>
          ))}
          <Card style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>1回目の自由記述</div>
            <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={8} maxLength={1500}
              style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }} />
            <div style={{ textAlign: "right", fontSize: 11, color: C.sub, marginTop: 4, fontFamily: FONT_MONO }}>{editText.length}/1500</div>
          </Card>
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn disabled={!complete} onClick={submitCurrentAnswers}>変更して再解析</Btn>
            <Btn kind="ghost" onClick={() => { setEditMode(null); setErr(""); }}>戻る</Btn>
          </div>
        </div>
      );
    }

    return (
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <H2 eyebrow="CURRENT RESPONSE" sub={"回答ID " + id + " / revision " + revision}>現在の回答</H2>
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.8 }}>このアカウントには回答が1件あります。新しい初回回答は作らず、この回答を更新します。</div>
          <div style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 13 }}>{currentResponse.free || "（自由記述なし）"}</div>
          {currentResponse.followUpSubmitted ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>二度目の自由記述</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{currentResponse.followUpText || "（記載なし）"}</div>
            </div>
          ) : null}
        </Card>
        {err ? <div style={{ color: C.bengara, fontSize: 12, marginBottom: 10 }}>{err}</div> : null}
        <H2 eyebrow="UPDATE RESPONSE" sub="新規の二度目自由記述と、提出済み回答の修正を分けています。">回答を更新する</H2>
        <div style={{ display: "grid", gap: 10 }}>
          <Card pad={13}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>二度目の自由記述</div>
            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>
              {currentResponse.followUpSubmitted ? "二度目の自由記述は提出済みです。変更は自分の回答画面から行えます。" : "初回回答とは別の二度目自由記述を一度だけ提出できます。"}
            </div>
            {currentResponse.followUpSubmitted
              ? <Btn small kind="ghost" onClick={() => goto("followupEdit")}>2回目の回答を修正</Btn>
              : <Btn small onClick={() => goto("followup")}>二度目の自由記述へ</Btn>}
          </Card>
          <Card pad={13}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>初回回答を修正</div>
            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>アンケートと1回目自由記述を一緒に更新します。2回目がある場合は、その本文も含めた現在回答全体を再解析します。</div>
            <Btn small kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditText(String(currentResponse.free || "")); setEditMode("answers"); setErr(""); }}>初回回答を修正する</Btn>
          </Card>
        </div>
        <div style={{ marginTop: 14 }}><Btn kind="ghost" onClick={() => goto("mine")}>自分の回答、設定の確認</Btn></div>
      </div>
    );
  }

  if (phase === "consent") {
    return (
      <div>
        <Progress idx={stepIdx} total={totalSteps} />
        {restoreBar}
        <H2 eyebrow="CONSENT" sub={"個人情報取り扱い方針 v" + policy.version}>回答の前にご確認ください</H2>
        <Card>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, maxHeight: 320, overflowY: "auto", padding: "4px 6px", color: C.ink }}>{policy.text}</div>
        </Card>
        <label style={{ display: "flex", gap: 9, alignItems: "flex-start", margin: "14px 2px", cursor: "pointer" }}>
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 4 }} />
          <span style={{ fontSize: 13 }}>上記の取り扱い方針を読み、回答が匿名の統計データとして本アプリの全利用者に共有されることに同意します。</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn disabled={!agree} onClick={() => setPhase("demo")}>同意して回答をはじめる</Btn>
          <Btn kind="ghost" onClick={() => goto("home")}>同意しない(戻る)</Btn>
        </div>
      </div>
    );
  }

  if (phase === "demo") {
    const done = Object.keys(DEMO_OPTS).every(k => demo[k]);
    return (
      <div>
        <Progress idx={stepIdx} total={totalSteps} />
        {restoreBar}
        <H2 eyebrow="ATTRIBUTES" sub="統計のグループ分けにのみ使用します(個人は特定されません)">あなたについて教えてください</H2>
        {Object.keys(DEMO_OPTS).map(k => (
          <div key={k} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>
              {DEMO_LABELS[k]}{(k === "gender" || k === "party") ? "(答えたくない場合は「回答しない」を選択)" : ""}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DEMO_OPTS[k].map(o => (
                <Chip key={o} active={demo[k] === o} onClick={() => setDemo({ ...demo, [k]: o })}>{o}</Chip>
              ))}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <Btn kind="ghost" onClick={() => setPhase("consent")}>戻る</Btn>
          <Btn disabled={!done} onClick={() => { setQi(0); setPhase("q"); }}>次へ</Btn>
        </div>
      </div>
    );
  }

  if (phase === "q") {
    const q = questions[qi];
    const val = answers[q.id];
    const canNext = q.type === "free" ? true : !!val;
    const last = qi === questions.length - 1;
    return (
      <div>
        <Progress idx={stepIdx} total={totalSteps} />
        {restoreBar}
        <Eyebrow>Q{qi + 1} / {questions.length}{q.type === "free" ? " — 自由記述(任意)" : ""}</Eyebrow>
        <h2 style={{ fontFamily: FONT_DISP, fontWeight: 600, fontSize: 20, margin: "0 0 16px", color: C.ink }}>{q.text}</h2>

        {q.type === "single" ? (
          <div style={{ display: "grid", gap: 8 }}>
            {(q.options || []).map(o => (
              <button key={o} onClick={() => setAnswers({ ...answers, [q.id]: o })} style={{
                textAlign: "left", padding: "12px 14px", fontSize: 14, borderRadius: 5,
                border: "1.5px solid " + (val === o ? C.green : C.rule),
                background: val === o ? C.greenSoft : C.card, color: C.ink
              }}>{o}</button>
            ))}
          </div>
        ) : q.type === "scale" ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, color: C.sub, marginBottom: 10 }}>
              <span style={{ maxWidth: "46%" }}>← {q.left}</span>
              <span style={{ maxWidth: "46%", textAlign: "right" }}>{q.right} →</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
              {(q.options || []).map(o => (
                <button key={o} onClick={() => setAnswers({ ...answers, [q.id]: o })} style={{
                  flex: 1, padding: "12px 0", fontFamily: FONT_MONO, fontSize: 15, borderRadius: 5,
                  border: "1.5px solid " + (val === o ? C.green : C.rule),
                  background: val === o ? C.green : C.card, color: val === o ? "#fff" : C.ink
                }}>{o}</button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <textarea
              value={val || ""}
              onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}
              rows={7} maxLength={1500}
              placeholder={q.placeholder || "自由にお書きください"}
              style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.sub, marginTop: 4, gap: 10 }}>
              <span>氏名・住所など個人を特定できる情報は書かないでください。</span>
              <span style={{ fontFamily: FONT_MONO }}>{String(val || "").length}/1500</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <Btn kind="ghost" onClick={() => (qi === 0 ? setPhase("demo") : setQi(qi - 1))}>戻る</Btn>
          {last ? (
            <Btn disabled={!canNext} onClick={submit}>{cloudApiEnabled() ? "AI解析して送信" : "端末内で解析して保存"}</Btn>
          ) : (
            <Btn disabled={!canNext} onClick={() => setQi(qi + 1)}>次へ</Btn>
          )}
        </div>
      </div>
    );
  }

  if (phase === "analyzing") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "70px 0", gap: 14 }}>
        <Spinner />
        <div style={{ fontFamily: FONT_DISP, fontSize: 17 }}>{cloudApiEnabled() ? "Cloudflare AIで回答を解析しています…" : "回答を端末内で解析しています…"}</div>
        <div style={{ fontSize: 12, color: C.sub, textAlign: "center" }}>感情・妥当性・切実度・意欲の推定と、<br />意見チャンクの抽出・分類を行っています{cloudApiEnabled() ? "(通常5〜30秒)" : ""}。</div>
      </div>
    );
  }

  if (phase === "aifail") {
    return (
      <div style={{ maxWidth: 560, margin: "40px auto" }}>
        <Card style={{ borderColor: C.bengara }}>
          <div style={{ fontWeight: 700, color: C.bengara, marginBottom: 6 }}>{cloudApiEnabled() ? "クラウドAI解析に失敗しました" : "ローカル解析に失敗しました"}</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>
            {err || "解析処理でエラーが発生しました。"} 下書きは端末内に保持されています。入力を確認して再試行してください。
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn onClick={submit}>再試行する</Btn>
          </div>
        </Card>
      </div>
    );
  }

  const an = result.resp.analysis;
  const analysisState = analysisStateLabel(result.resp);
  const ovAll = overallParams(result.agg);
  const avgPt = result.agg.ideology.n ? { e: result.agg.ideology.econSum / result.agg.ideology.n, s: result.agg.ideology.socSum / result.agg.ideology.n } : null;
  return (
    <div>
      <H2 eyebrow="COMPLETE" sub="ご協力ありがとうございました。以下はあなたの回答の解析結果です。">回答を受け付けました</H2>
      {analysisState ? (
        <Card pad={12} style={{ marginBottom: 12, borderColor: analysisState.tone === "error" ? C.bengara : analysisState.tone === "success" ? C.green : C.karashi }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{analysisState.title}</div>
          <div style={{ fontSize: 11, color: C.sub }}>{analysisState.detail}</div>
        </Card>
      ) : null}
      <Card pad={16} style={{ marginBottom: 12, borderColor: C.green, background: C.greenSoft }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, color: C.green, fontWeight: 700, letterSpacing: "0.14em" }}>
            {result.resp.seq === 2 ? "追記を受け付けました(回答IDは初回と同じです)" : "回答IDを発行しました"}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 21, margin: "10px 0 12px", wordBreak: "break-all" }}>
            {result.resp.seq === 2 ? result.resp.pid : result.resp.id}
          </div>
          <Btn small onClick={() => {
            const idv = result.resp.seq === 2 ? result.resp.pid : result.resp.id;
            try {
              navigator.clipboard.writeText(idv).then(
                () => notify("回答IDをコピーしました"),
                () => notify("コピーできません。手動で控えてください")
              );
            } catch (e) { notify("コピーできません。手動で控えてください"); }
          }}>回答IDをコピー</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 12, lineHeight: 1.9 }}>
          このIDはアカウント{session ? "「" + session.name + "」" : ""}に紐付きました。今後は<b>右上のアカウントメニューから「自分の回答」を開くだけ</b>で、内容の確認・追記・撤回ができます(IDの入力は不要です)。
          回答IDそのものは、アカウントに入れなくなった場合に回答を取り扱うための合鍵です。念のためコピーして控え、第三者には知られないようにしてください。
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>あなたのパラメータ</div>
          <MeterBar label="感情ポジ度" note={"主要感情: " + an.params.emo.label} value={emoToPos(an.params.emo.pol)} color={emoColor(an.params.emo.pol)} />
          <MeterBar label="妥当性" value={an.params.valid} />
          <MeterBar label="切実度" value={an.params.crit} color={C.karashi} />
          <MeterBar label="意欲" value={an.params.motiv} color={C.slate} />
          {an.attrs.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {an.attrs.map(a => <span key={a} style={{ fontSize: 11, padding: "2px 9px", borderRadius: 99, background: C.soft, color: C.sub }}>{a}</span>)}
            </div>
          ) : null}
          {isLocalEngine(an) ? <LocalEngineNote an={an} /> : null}
        </Card>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>イデオロギー座標(推定)</div>
          <IdeoMap me={{ e: an.ideology.econ, s: an.ideology.soc }} avgPt={avgPt} points={[]} height={190} confidence={an.ideology.confidence} />
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>● あなた / ◯ 全体平均(解析済み {result.agg.ideology.n}件)</div>
          <IdeologyReading ideology={an.ideology} attrs={an.attrs} />
        </Card>
      </div>

      {an.chunks.length ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>抽出された意見チャンク({an.chunks.length}件)</div>
          <div style={{ display: "grid", gap: 8 }}>
            {an.chunks.map((c, i) => <OpinionCard key={i} o={c} compact />)}
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
        <Btn onClick={() => goto("dash")}>統計ダッシュボードを見る</Btn>
        <Btn kind="ghost" onClick={resetAll}>続けて別の回答を入力する</Btn>
      </div>
    </div>
  );
}

function Completion({ result, notify, goto, session }) {
  const an = result.resp.analysis;
  const avgPt = result.agg.ideology.n
    ? { e: result.agg.ideology.econSum / result.agg.ideology.n, s: result.agg.ideology.socSum / result.agg.ideology.n }
    : null;
  return (
    <div>
      <H2 eyebrow="COMPLETE" sub="ご協力ありがとうございました。以下はあなたの回答のローカル解析結果です。">回答を受け付けました</H2>
      <Card pad={16} style={{ marginBottom: 12, borderColor: C.green, background: C.greenSoft }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, color: C.green, fontWeight: 700, letterSpacing: "0.14em" }}>
            {result.resp.seq === 2 ? "追記を受け付けました(回答IDは初回と同じです)" : "回答IDを発行しました"}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 21, margin: "10px 0 12px", wordBreak: "break-all" }}>
            {result.resp.seq === 2 ? result.resp.pid : result.resp.id}
          </div>
          <Btn small onClick={() => {
            const idv = result.resp.seq === 2 ? result.resp.pid : result.resp.id;
            try {
              navigator.clipboard.writeText(idv).then(
                () => notify("回答IDをコピーしました"),
                () => notify("コピーできません。手動で控えてください")
              );
            } catch (e) { notify("コピーできません。手動で控えてください"); }
          }}>回答IDをコピー</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 12, lineHeight: 1.9 }}>
          このIDはアカウント{session ? "「" + session.name + "」" : ""}に紐付きました。今後は<b>「自分の回答」からログインするだけ</b>で、内容の確認・追記・撤回ができます。
          回答IDは、アカウントに入れなくなった場合に回答を取り扱うための合鍵です。第三者には知られないよう控えてください。
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>あなたのパラメータ</div>
          <MeterBar label="感情ポジ度" note={"主要感情: " + an.params.emo.label} value={emoToPos(an.params.emo.pol)} color={emoColor(an.params.emo.pol)} />
          <MeterBar label="妥当性" value={an.params.valid} />
          <MeterBar label="切実度" value={an.params.crit} color={C.karashi} />
          <MeterBar label="意欲" value={an.params.motiv} color={C.slate} />
          {an.attrs.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {an.attrs.map(a => <span key={a} style={{ fontSize: 11, padding: "2px 9px", borderRadius: 99, background: C.soft, color: C.sub }}>{a}</span>)}
            </div>
          ) : null}
          {isLocalEngine(an) ? <LocalEngineNote an={an} /> : null}
        </Card>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>イデオロギー座標(推定)</div>
          <IdeoMap me={{ e: an.ideology.econ, s: an.ideology.soc }} avgPt={avgPt} points={[]} height={190} confidence={an.ideology.confidence} />
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>● あなた / ◯ 全体平均(解析済み {result.agg.ideology.n}件)</div>
          <IdeologyReading ideology={an.ideology} attrs={an.attrs} />
        </Card>
      </div>

      {an.chunks.length ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>抽出された意見チャンク({an.chunks.length}件)</div>
          <div style={{ display: "grid", gap: 8 }}>
            {an.chunks.map((c, i) => <OpinionCard key={i} o={c} compact />)}
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
        <Btn onClick={() => goto("dash")}>統計ダッシュボードを見る</Btn>
        <Btn kind="ghost" onClick={() => goto("survey")}>回答ページへ戻る</Btn>
      </div>
    </div>
  );
}

function CompletionUnavailable({ goto }) {
  return (
    <div style={{ maxWidth: 560, margin: "40px auto" }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>完了した回答を読み込めませんでした</div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
          回答ページを再読み込みした場合は、「自分の回答」から保存済み回答を確認してください。
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => goto("mine")}>自分の回答を確認する</Btn>
          <Btn kind="ghost" onClick={() => goto("home")}>概要へ戻る</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   統計ダッシュボード
   ============================================================ */
function DashEmpty({ goto }) {
  return (
    <div style={{ maxWidth: 560, margin: "50px auto", textAlign: "center" }}>
      <div style={{ fontFamily: FONT_DISP, fontSize: 20, marginBottom: 8 }}>まだ統計データがありません</div>
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 18 }}>
        回答が保存されると、ここに分布・パラメータ・意見の統計が表示されます。動作確認には管理タブの「デモデータ投入」が便利です。
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        <Btn onClick={() => goto("survey")}>回答をはじめる</Btn>
      </div>
    </div>
  );
}

function catTop(cats) {
  let best = null, bn = -1;
  for (const k of Object.keys(cats || {})) { if (cats[k] > bn) { bn = cats[k]; best = k; } }
  return best;
}

function Dashboard({ agg, questions, goto }) {
  const selectable = useMemo(() => questions.filter(q => q.type !== "free"), [questions]);
  const [selQ, setSelQ] = useState(() => {
    if (!selectable.length) return "";
    return selectable.some(q => q.id === ANCHOR_QID) ? ANCHOR_QID : selectable[0].id;
  });
  const [selOpt, setSelOpt] = useState("");
  const [openTopic, setOpenTopic] = useState("");
  const [tt, setTt] = useState("すべて");
  const [demoField, setDemoField] = useState("age");
  const [crossField, setCrossField] = useState("age");
  const [range, setRange] = useState(30);

  if (!agg || agg.total === 0) return <DashEmpty goto={goto} />;

  const ov = overallParams(agg);
  const chunkTotal = Object.values(agg.topics).reduce((s, t) => s + t.n, 0);

  const q = selectable.find(x => x.id === selQ) || selectable[0];
  const qa = (q && agg.questions[q.id]) || { counts: {}, params: {} };
  const optOrder = [];
  if (q && q.options) { for (const o of q.options) optOrder.push(String(o)); }
  for (const k of Object.keys(qa.counts)) { if (optOrder.indexOf(k) < 0) optOrder.push(k); }
  const barData = optOrder.map(o => ({ name: o, 回答数: qa.counts[o] || 0 }));

  const groupOpt = selOpt || optOrder.find(o => (qa.counts[o] || 0) > 0) || "";
  const gp = groupOpt ? paramView((qa.params || {})[groupOpt]) : null;
  const selColor = (q && q.id === ANCHOR_QID && SUP_COLORS[groupOpt]) || C.green;
  const radarData = gp ? [
    { k: "感情ポジ度", グループ: gp.emoPos, 全体: emoToPos(ov.emo) },
    { k: "妥当性", グループ: gp.valid, 全体: Math.round(ov.valid) },
    { k: "切実度", グループ: gp.crit, 全体: Math.round(ov.crit) },
    { k: "意欲", グループ: gp.motiv, 全体: Math.round(ov.motiv) }
  ] : null;

  const avgPt = agg.ideology.n ? { e: agg.ideology.econSum / agg.ideology.n, s: agg.ideology.socSum / agg.ideology.n } : null;

  const topics = Object.keys(agg.topics).map(name => {
    const t = agg.topics[name];
    return { name, n: t.n, cats: t.cats, ex: t.ex || [], avgCrit: Math.round(avg(t.crit, t.n)), avgEmo: avg(t.emo, t.n) };
  }).sort((a, b) => b.n - a.n).slice(0, 10);
  const topicMax = topics.length ? topics[0].n : 1;

  const targetsAll = Object.values(agg.targets).map(g => ({
    ...g,
    neg: Math.round(clamp((1 - avg(g.emo, g.n)) * 50, 0, 100)),
    avgCrit: Math.round(avg(g.crit, g.n)),
    main: catTop(g.cats)
  }));
  const ttCounts = {};
  let ttAll = 0;
  for (const g of targetsAll) { inc(ttCounts, g.tt, g.n); ttAll += g.n; }
  const targets = targetsAll.filter(g => tt === "すべて" || g.tt === tt).sort((a, b) => b.n - a.n).slice(0, 10);

  const dCounts = agg.demo[demoField] || {};
  const dOrder = (DEMO_OPTS[demoField] || []).filter(o => dCounts[o] !== undefined);
  for (const k of Object.keys(dCounts)) { if (dOrder.indexOf(k) < 0) dOrder.push(k); }
  const dMax = Math.max(1, ...dOrder.map(o => dCounts[o] || 0), 1);

  /* --- 属性クロス集計(v0.10) --- */
  const hasCross = !!agg.cross;
  const crossData = (hasCross && q) ? crossRows(agg, q.id, crossField, DEMO_OPTS[crossField] || [], optOrder) : [];

  /* --- 時系列トレンド(v0.10) --- */
  const hasSeries = !!agg.series;
  const tr = hasSeries ? seriesTrend(agg, range) : [];
  const trDays = tr.filter(r => r.n > 0).length;
  const anchorQ = questions.find(x => x.id === ANCHOR_QID);
  const supOpts = [];
  if (anchorQ && anchorQ.options) for (const o of anchorQ.options) supOpts.push(String(o));
  for (const r of tr) for (const kk of Object.keys(r.sup || {})) { if (supOpts.indexOf(kk) < 0) supOpts.push(kk); }
  const supData = tr.map(r => {
    const row = { label: r.label, n: r.n };
    for (const o of supOpts) row[o] = r.n ? Math.round(((r.sup && r.sup[o]) || 0) / r.n * 1000) / 10 : null;
    return row;
  });
  const PAR_LINES = [["感情ポジ度", C.green], ["妥当性", C.gray], ["切実度", C.karashi], ["意欲", C.slate]];
  const parData = tr.map(r => ({
    label: r.label, n: r.an,
    "感情ポジ度": r.emo == null ? null : emoToPos(r.emo),
    "妥当性": r.valid == null ? null : Math.round(r.valid),
    "切実度": r.crit == null ? null : Math.round(r.crit),
    "意欲": r.motiv == null ? null : Math.round(r.motiv)
  }));

  return (
    <div>
      <H2 eyebrow="DASHBOARD" sub="集計は匿名の統計データです。回答は自己選択によるサンプルで、世論の統計的代表性はありません。">統計ダッシュボード</H2>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <KPI label="総回答数" value={agg.total} unit="件" />
        <KPI label="意見チャンク" value={chunkTotal} unit="件" />
        <KPI label="平均意欲" value={ov.n ? Math.round(ov.motiv) : "–"} unit="/100" />
        <KPI label="平均切実度" value={ov.n ? Math.round(ov.crit) : "–"} unit="/100" />
      </div>

      <H2 eyebrow="DISTRIBUTION" sub="設問を選ぶと回答の分布を表示します">設問別の回答分布</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {selectable.map(qq => (
          <Chip key={qq.id} active={q && q.id === qq.id} onClick={() => { setSelQ(qq.id); setSelOpt(""); }}>
            {qq.text.length > 17 ? qq.text.slice(0, 17) + "…" : qq.text}
          </Chip>
        ))}
      </div>
      <Card style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{q ? q.text : ""}</div>
        <ResponsiveContainer width="100%" minWidth={620} height={optOrder.length * 40 + 24}>
          <BarChart data={barData} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 4 }}>
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={148} tick={{ fontSize: 11, fill: C.ink }} axisLine={{ stroke: C.rule }} tickLine={false} />
            <Tooltip cursor={{ fill: C.soft }} contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid " + C.rule }} />
            <Bar dataKey="回答数" radius={[0, 3, 3, 0]} label={{ position: "right", fontSize: 11, fill: C.sub, fontFamily: FONT_MONO }}>
              {barData.map((d, i) => (
                <Cell key={i} fill={q && q.id === ANCHOR_QID ? (SUP_COLORS[d.name] || C.gray) : C.green} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <H2 eyebrow="CROSS TAB" sub="上で選択中の設問について、回答者属性ごとの回答構成比を比較します(例: 年代×政権支持)">属性クロス集計</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {Object.keys(DEMO_LABELS).map(k => (
          <Chip key={k} active={crossField === k} onClick={() => setCrossField(k)}>{DEMO_LABELS[k]}</Chip>
        ))}
      </div>
      <Card style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {!hasCross ? (
          <div style={{ fontSize: 13, color: C.sub }}>
            この集計は旧バージョンのデータです。管理タブの「集計を再構築」を実行すると、既存の回答からクロス集計が生成されます。
          </div>
        ) : !crossData.length ? (
          <div style={{ fontSize: 13, color: C.sub }}>この属性のクロス集計データはまだありません。</div>
        ) : (
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{DEMO_LABELS[crossField]} × {q ? q.text : ""}</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
              {optOrder.map((o, i) => (
                <span key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sub }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: colorForOpt(q, o, i), display: "inline-block" }} />{o}
                </span>
              ))}
            </div>
            <ResponsiveContainer width="100%" minWidth={720} height={crossData.length * 42 + 34}>
              <BarChart data={crossData} layout="vertical" margin={{ top: 4, right: 14, left: 4, bottom: 4 }}>
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: C.sub, fontFamily: FONT_MONO }} tickFormatter={v => v + "%"} axisLine={{ stroke: C.rule }} tickLine={false} />
                <YAxis type="category" dataKey="name" width={148} tick={{ fontSize: 11, fill: C.ink }} axisLine={{ stroke: C.rule }} tickLine={false} />
                <Tooltip cursor={{ fill: C.soft }} contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid " + C.rule }}
                  formatter={(v, n, e) => [Math.round(v) + "%(" + ((e && e.payload && e.payload.counts && e.payload.counts[n]) || 0) + "件)", n]} />
                {optOrder.map((o, i) => (
                  <Bar key={o} dataKey={"p:" + o} name={o} stackId="a" fill={colorForOpt(q, o, i)} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
              帯は各属性グループ内での構成比(%)。( )内はグループの回答数で、少ないグループの値は参考程度にご覧ください。
            </div>
          </div>
        )}
      </Card>

      <H2 eyebrow="GROUP PARAMS" sub="選択肢を選ぶと、そのグループの平均パラメータを全体平均と比較します(例:「支持しない」人の統計)">回答グループ別パラメータ</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {optOrder.map(o => (
          <Chip key={o} active={groupOpt === o} count={qa.counts[o] || 0} onClick={() => setSelOpt(selOpt === o ? "" : o)}>{o}</Chip>
        ))}
      </div>
      {gp ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 12 }}>
          <Card>
            <ResponsiveContainer width="100%" height={250}>
              <RadarChart data={radarData} outerRadius="68%">
                <PolarGrid stroke={C.rule} />
                <PolarAngleAxis dataKey="k" tick={{ fontSize: 11, fill: C.ink }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: C.sub }} tickCount={5} stroke={C.rule} />
                <Radar name={"「" + groupOpt + "」グループ"} dataKey="グループ" stroke={selColor} fill={selColor} fillOpacity={0.3} />
                <Radar name="全体平均" dataKey="全体" stroke={C.gray} fill={C.gray} fillOpacity={0.15} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </RadarChart>
            </ResponsiveContainer>
          </Card>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
              「{groupOpt}」グループの平均 <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.sub }}>n={gp.n}(解析済み回答)</span>
            </div>
            <MeterBar label="感情ポジ度" value={gp.emoPos} color={emoColor((gp.emoPos - 50) / 50)} />
            <MeterBar label="妥当性" value={gp.valid} />
            <MeterBar label="切実度" value={gp.crit} color={C.karashi} />
            <MeterBar label="意欲" value={gp.motiv} color={C.slate} />
            <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>グレーの薄い面は全体平均(n={ov.n})との比較です。</div>
          </Card>
        </div>
      ) : groupOpt ? (
        <Card pad={14}><div style={{ fontSize: 13, color: C.sub }}>「{groupOpt}」にはまだ解析済みの回答がありません。</div></Card>
      ) : (
        <Card pad={14}><div style={{ fontSize: 13, color: C.sub }}>上の選択肢チップから比較したいグループを選んでください。</div></Card>
      )}

      <H2 eyebrow="TIME SERIES" sub="日別(日本時間)の回答から、支持の構成比と平均パラメータの推移を表示します">時系列トレンド</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {[[7, "7日"], [30, "30日"], [90, "90日"], [0, "全期間"]].map(rr => (
          <Chip key={rr[0]} active={range === rr[0]} onClick={() => setRange(rr[0])}>{rr[1]}</Chip>
        ))}
      </div>
      {!hasSeries ? (
        <Card pad={14}>
          <div style={{ fontSize: 13, color: C.sub }}>
            この集計は旧バージョンのデータです。管理タブの「集計を再構築」を実行すると、既存の回答から時系列データが生成されます。
          </div>
        </Card>
      ) : trDays < 2 ? (
        <Card pad={14}>
          <div style={{ fontSize: 13, color: C.sub }}>
            まだ推移を描くだけのデータがありません。回答が2日以上に分かれると折れ線が表示されます(この期間の回答日数: {trDays}日)。
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>政権支持の構成比の推移</div>
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={supData} margin={{ top: 6, right: 14, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={C.soft} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.sub, fontFamily: FONT_MONO }} minTickGap={26} axisLine={{ stroke: C.rule }} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: C.sub, fontFamily: FONT_MONO }} tickFormatter={v => v + "%"} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid " + C.rule }}
                  formatter={(v, n) => [v == null ? "—" : v + "%", n]} />
                {supOpts.map(o => (
                  <Line key={o} type="monotone" dataKey={o} stroke={SUP_COLORS[o] || C.gray} strokeWidth={2} dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
              {supOpts.map(o => (
                <span key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sub }}>
                  <span style={{ width: 12, height: 3, background: SUP_COLORS[o] || C.gray, display: "inline-block" }} />{o}
                </span>
              ))}
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>平均パラメータの推移(0〜100)</div>
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={parData} margin={{ top: 6, right: 14, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={C.soft} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.sub, fontFamily: FONT_MONO }} minTickGap={26} axisLine={{ stroke: C.rule }} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: C.sub, fontFamily: FONT_MONO }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid " + C.rule }}
                  formatter={(v, n) => [v == null ? "—" : v, n]} />
                {PAR_LINES.map(p => (
                  <Line key={p[0]} type="monotone" dataKey={p[0]} stroke={p[1]} strokeWidth={2} dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
              {PAR_LINES.map(p => (
                <span key={p[0]} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sub }}>
                  <span style={{ width: 12, height: 3, background: p[1], display: "inline-block" }} />{p[0]}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
              感情ポジ度は −1〜+1 を 0〜100 に換算した値。回答の少ない日は値が大きく振れます(解析済み回答のない日は線を補間)。
            </div>
          </Card>
        </div>
      )}

      <H2 eyebrow="IDEOLOGY MAP" sub="各回答の推定座標。色は政権支持の回答に対応します。">イデオロギー分布</H2>
      <Card>
        <IdeoMap points={agg.ideology.points} avgPt={avgPt} height={250} />
        <div style={{ fontSize: 11, color: C.sub, marginTop: 7 }}>横軸は経済政策、縦軸は社会・権利観です。◯は解析済み回答の全体平均。点の色は思想分類ではなく、政権支持の回答を表します。</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          {Object.keys(SUP_COLORS).map(k => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sub }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: SUP_COLORS[k], display: "inline-block" }} />{k}
            </span>
          ))}
          <span style={{ fontSize: 11, color: C.sub }}>◯ 全体平均</span>
        </div>
      </Card>

      <H2 eyebrow="TOPICS" sub="似た意見は規則解析が付与したトピック名で自動的に結合・集計されます(上位10件)">意見トピック</H2>
      <Card>
        {topics.length ? topics.map(t => (
          <div key={t.name}>
            <button onClick={() => setOpenTopic(openTopic === t.name ? "" : t.name)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "8px 2px", borderBottom: "1px solid " + C.soft }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13, marginBottom: 4, gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{t.name}<span style={{ fontSize: 10, color: C.sub, marginLeft: 7 }}>{openTopic === t.name ? "▲ 閉じる" : "▼ 詳細"}</span></span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.sub }}>{t.n}件</span>
              </div>
              <div style={{ height: 8, background: C.soft, borderRadius: 2 }}>
                <div style={{ height: 8, width: (t.n / topicMax * 100) + "%", background: C.green, borderRadius: 2 }} />
              </div>
            </button>
            {openTopic === t.name ? (
              <div style={{ padding: "10px 2px 14px", borderBottom: "1px solid " + C.soft }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                  {Object.keys(t.cats).map(c => (
                    <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Badge cat={c} /><span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.sub }}>{t.cats[c]}</span>
                    </span>
                  ))}
                </div>
                <div style={{ maxWidth: 360 }}>
                  <MeterBar small label="平均切実度" value={t.avgCrit} color={C.karashi} />
                  <MeterBar small label="感情ポジ度" value={emoToPos(t.avgEmo)} color={emoColor(t.avgEmo)} />
                </div>
                {t.ex.length ? <div style={{ fontSize: 12, color: C.sub }}>例: {t.ex.join(" ／ ")}</div> : null}
              </div>
            ) : null}
          </div>
        )) : <div style={{ fontSize: 13, color: C.sub }}>意見チャンクがまだありません。</div>}
      </Card>

      <H2 eyebrow="TARGETS" sub="不満・提言などの意見を「〜に対して」の対象別に量子化した統計です(上位10件)">意見・不満の対象</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <Chip active={tt === "すべて"} count={ttAll} onClick={() => setTt("すべて")}>すべて</Chip>
        {TT_TYPES.filter(t => ttCounts[t]).map(t => (
          <Chip key={t} active={tt === t} count={ttCounts[t]} onClick={() => setTt(t)}>{t}</Chip>
        ))}
      </div>
      {targets.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 10 }}>
          {targets.map(g => (
            <Card key={g.tt + "|" + g.tn} pad={12}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{g.tn}</span>
                <span style={{ fontSize: 11, color: C.sub, border: "1px solid " + C.rule, padding: "1px 7px", borderRadius: 3 }}>{g.tt}</span>
                {g.main ? <Badge cat={g.main} /> : null}
                <span style={{ marginLeft: "auto", fontFamily: FONT_MONO, fontSize: 12, color: C.sub }}>{g.n}件</span>
              </div>
              <MeterBar small label="ネガ度" note="0=好意的 / 100=強い不満" value={g.neg} color={C.bengara} />
              <MeterBar small label="平均切実度" value={g.avgCrit} color={C.karashi} />
            </Card>
          ))}
        </div>
      ) : (
        <Card pad={14}><div style={{ fontSize: 13, color: C.sub }}>この対象種別の意見はまだありません。</div></Card>
      )}

      <H2 eyebrow="ATTRIBUTES" sub="回答者の社会的属性の内訳です">回答者属性の内訳</H2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {Object.keys(DEMO_LABELS).map(k => (
          <Chip key={k} active={demoField === k} onClick={() => setDemoField(k)}>{DEMO_LABELS[k]}</Chip>
        ))}
      </div>
      <Card>
        {dOrder.length ? dOrder.map(o => (
          <div key={o} style={{ padding: "6px 2px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
              <span>{o}</span>
              <span style={{ fontFamily: FONT_MONO, color: C.sub }}>{dCounts[o] || 0}</span>
            </div>
            <div style={{ height: 7, background: C.soft, borderRadius: 2 }}>
              <div style={{ height: 7, width: ((dCounts[o] || 0) / dMax * 100) + "%", background: C.slate, borderRadius: 2 }} />
            </div>
          </div>
        )) : <div style={{ fontSize: 13, color: C.sub }}>属性データがまだありません。</div>}
      </Card>
    </div>
  );
}

/* ============================================================
   意見一覧
   ============================================================ */
function Opinions({ agg, initial, goto }) {
  const init = initial || {};
  const [cat, setCat] = useState(init.cat || "すべて");
  const [tt, setTt] = useState(init.tt || "すべて");
  const [kw, setKw] = useState(init.kw || "");
  const [sup, setSup] = useState(init.sup || "");
  const fromTree = !!(init.tt || init.kw || init.cat || init.sup);
  const src = (agg && agg.opinions) || [];
  const k = kw.trim();
  const list = src.filter(o =>
    (cat === "すべて" || o.cat === cat) &&
    (tt === "すべて" || o.tt === tt) &&
    (!sup || o.sup === sup) &&
    (!k || (o.s + " " + o.topic + " " + (o.tn || "")).indexOf(k) >= 0)
  );
  return (
    <div>
      <H2 eyebrow="OPINIONS" sub="自由記述から規則解析が抽出した意見チャンクの一覧です(直近120件を保持)">意見一覧</H2>
      {fromTree ? (
        <Card pad={11} style={{ marginBottom: 10, borderColor: C.green }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ flex: 1, minWidth: 180 }}>
              意見ツリーからの絞り込み中
              {sup ? "(立場: " + sup + ")" : ""}{tt !== "すべて" ? "(対象: " + tt + ")" : ""}
              {cat !== "すべて" ? "(種類: " + cat + ")" : ""}{k ? "(トピック: " + k + ")" : ""}
              — {list.length}件
            </span>
            <Btn small kind="ghost" onClick={() => { setCat("すべて"); setTt("すべて"); setKw(""); setSup(""); }}>絞り込みを解除</Btn>
            {goto ? <Btn small kind="ghost" onClick={() => goto("tree")}>ツリーへ戻る</Btn> : null}
          </div>
        </Card>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {["すべて"].concat(CATS).map(c => (
          <Chip key={c} active={cat === c} onClick={() => setCat(c)}>{c}</Chip>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <select value={tt} onChange={e => setTt(e.target.value)}
          style={{ padding: "8px 10px", borderRadius: 5, border: "1.5px solid " + C.rule, background: C.card }}>
          {["すべて"].concat(TT_TYPES).map(t => (
            <option key={t} value={t}>{t === "すべて" ? "対象: すべて" : "対象: " + t}</option>
          ))}
        </select>
        <input value={kw} onChange={e => setKw(e.target.value)} placeholder="キーワード検索(要約・トピック・対象名)"
          style={{ flex: "1 1 200px", padding: "8px 11px", borderRadius: 5, border: "1.5px solid " + C.rule, background: C.card }} />
      </div>
      {list.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          {list.map((o, i) => <OpinionCard key={i} o={o} />)}
        </div>
      ) : (
        <Card pad={14}><div style={{ fontSize: 13, color: C.sub }}>条件に一致する意見はありません。回答が増えるとここに意見チャンクが蓄積されます。</div></Card>
      )}
      <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>全件データが必要な場合は、管理タブの「JSONエクスポート」をご利用ください。</div>
    </div>
  );
}

/* ============================================================
   管理画面
   ============================================================ */
const INPUT_STYLE = { width: "100%", padding: "9px 11px", borderRadius: 5, border: "1.5px solid #E6E3DA", background: "#FFFFFF", fontSize: 13 };
function Field({ label, sub, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>
        {label}{sub ? <span style={{ fontSize: 10, marginLeft: 6 }}>{sub}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Admin({ questions, setQuestions, policy, setPolicy, notify, refreshAgg, agg }) {
  const [pass, setPass] = useState("");
  const [saved, setSaved] = useState({ pass: "admin" });
  const [locked, setLocked] = useState(true);
  const [dq, setDq] = useState(null);
  const [dp, setDp] = useState(null);
  const [prog, setProg] = useState(null);
  const [wipe, setWipe] = useState("");
  const [np, setNp] = useState("");
  const [delId, setDelId] = useState("");
  const [impInfo, setImpInfo] = useState(null);
  const busy = !!prog;

  useEffect(() => {
    let alive = true;
    (async () => {
      const a = await sGet("config:admin");
      if (alive && a && a.pass) setSaved(a);
    })();
    return () => { alive = false; };
  }, []);

  function unlock() {
    if (pass === saved.pass) {
      setLocked(false);
      setDq(JSON.parse(JSON.stringify(questions)));
      setDp({ version: policy.version, text: policy.text });
      setPass("");
    } else {
      notify("合言葉が違います");
    }
  }

  /* ---- データ操作 ---- */
  async function insertDemo() {
    setProg({ label: "デモデータ投入中", i: 0, n: DEMO_RESPONSES.length });
    const now = Date.now();
    const resps = [];
    for (let i = 0; i < DEMO_RESPONSES.length; i++) {
      const d = DEMO_RESPONSES[i];
      const resp = {
        id: uid(), ts: now - (DEMO_RESPONSES.length - i) * 3.4 * 86400 * 1000, ver: APP_VER, demoFlag: true,
        consent: { version: policy.version, ts: now }, demo: d.demo, answers: d.answers,
        free: d.free, freeQids: ["q_free"], analysis: sanitizeAnalysis(d.analysis)
      };
      await sSet("resp:" + resp.id, resp);
      resps.push(resp);
      setProg({ label: "デモデータ投入中", i: i + 1, n: DEMO_RESPONSES.length });
    }
    const cur = (await sGet("agg:summary")) || newAgg();
    for (const r of resps) mergeResponse(cur, r);
    await sSet("agg:summary", cur);
    await refreshAgg();
    setProg(null);
    notify("デモデータを" + resps.length + "件投入しました");
  }

  async function rebuild(silent, reanalyze) {
    const label = reanalyze ? "旧簡易解析を補完中" : "集計を再構築中";
    setProg({ label: label, i: 0, n: 0 });
    const info = await rebuildAgg((i, n) => setProg({ label: label, i: i, n: n }), {
      reanalyze: !!reanalyze,
      questions: questions
    });
    const count = info && typeof info === "object" ? info.total : Number(info) || 0;
    await refreshAgg();
    setProg(null);
    if (!silent && reanalyze) {
      const repaired = info && info.reanalyzed ? info.reanalyzed : 0;
      const failed = info && info.failed ? " / 保存失敗 " + info.failed + "件" : "";
      notify("旧簡易解析を" + repaired + "件補完し、集計を再構築しました" + failed);
    } else if (!silent) notify("集計を再構築しました(" + count + "件)");
    return count;
  }

  async function removeById() {
    const id = sanitizeId(delId);
    if (!id) { notify("回答IDの形式が正しくありません(半角英数と - _ のみ)"); return; }
    setProg({ label: "回答を照会中", i: 0, n: 1 });
    const r = await sGet("resp:" + id);
    if (!r) { setProg(null); notify("回答ID「" + id + "」は見つかりませんでした"); return; }
    await sDel("resp:" + id);
    setDelId("");
    await rebuild(true);
    notify("回答 " + id + " を削除し、集計を再構築しました");
  }

  async function removeDemo() {
    const keys = await sList("resp:");
    setProg({ label: "デモデータ削除中", i: 0, n: keys.length });
    let del = 0;
    for (let i = 0; i < keys.length; i++) {
      const r = await sGet(keys[i]);
      if (r && r.demoFlag) { await sDel(keys[i]); del++; }
      setProg({ label: "デモデータ削除中", i: i + 1, n: keys.length });
    }
    await rebuild(true);
    notify("デモデータを" + del + "件削除し、集計を再構築しました");
  }

  /* JSONインポート(限定的)
     取り込むのは「回答」だけ。設問・同意文などの設定は取り込まない
     (設定を上書きすると、現在運用中の設問と衝突するため)。
     すべて sanitizeResponse で検証し、重複IDはスキップして、最後に集計を作り直す。 */
  async function importJson(file) {
    if (!file) return;
    setImpInfo(null);
    setProg({ label: "ファイルを読み込み中", i: 0, n: 1 });
    let text = "";
    try { text = await file.text(); }
    catch (e) { setProg(null); notify("ファイルを読めませんでした"); return; }

    const knownQids = questions.map(q => q.id);
    const parsed = parseImport(text, knownQids);
    if (parsed.error) { setProg(null); notify("インポート失敗: " + parsed.error); return; }
    if (!parsed.items.length) { setProg(null); notify("取り込める回答がありませんでした(不正 " + parsed.bad + "件)"); return; }

    let added = 0, dup = 0;
    for (let i = 0; i < parsed.items.length; i++) {
      const r = parsed.items[i];
      setProg({ label: "回答を取り込み中", i: i + 1, n: parsed.items.length });
      const exists = await sGet("resp:" + r.id);
      if (exists) { dup++; continue; }
      const ok = await sSet("resp:" + r.id, r);
      if (ok) added++;
    }
    const count = await rebuild(true);
    setImpInfo({ added: added, dup: dup, bad: parsed.bad, foreign: parsed.foreign, total: count });
    notify("インポート完了: " + added + "件を追加しました");
  }

  async function exportJson() {
    const keys = await sList("resp:");
    setProg({ label: "エクスポート準備中", i: 0, n: keys.length });
    const responses = [];
    for (let i = 0; i < keys.length; i++) {
      const r = await sGet(keys[i]);
      if (r) responses.push(r);
      setProg({ label: "エクスポート準備中", i: i + 1, n: keys.length });
    }
    responses.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const data = {
      app: "声析 SEISEKI", ver: APP_VER, exportedAt: new Date().toISOString(),
      config: { questions: questions, policy: policy },
      agg: await sGet("agg:summary"),
      responses: responses
    };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = "seiseki-export-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(u), 4000);
      notify("エクスポートを開始しました(" + responses.length + "件)");
    } catch (e) {
      notify("エクスポートに失敗しました: " + (e && e.message ? e.message : e));
    }
    setProg(null);
  }

  async function wipeAll() {
    if (wipe !== "削除") { notify("確認のため「削除」と入力してください"); return; }
    const keys = await sList("resp:");
    setProg({ label: "全データ削除中", i: 0, n: keys.length });
    for (let i = 0; i < keys.length; i++) {
      await sDel(keys[i]);
      setProg({ label: "全データ削除中", i: i + 1, n: keys.length });
    }
    await sSet("agg:summary", newAgg());
    await refreshAgg();
    setWipe("");
    setProg(null);
    notify("全回答データを削除しました(設問・同意文は保持)");
  }

  /* ---- 設問エディタ ---- */
  function updQ(i, patch) { const a = dq.slice(); a[i] = { ...a[i], ...patch }; setDq(a); }
  function typeChange(i, t) {
    const q = dq[i];
    if (t === "single") {
      updQ(i, { type: t, options: (q.type === "single" && q.options && q.options.length >= 2) ? q.options : ["選択肢1", "選択肢2"] });
    } else if (t === "scale") {
      updQ(i, { type: t, options: ["1", "2", "3", "4", "5"], left: q.left || "そう思わない", right: q.right || "そう思う" });
    } else {
      updQ(i, { type: t, placeholder: q.placeholder || "" });
    }
  }
  function addQ(t) {
    const base = { id: "q_" + uid(), text: "", type: t };
    if (t === "single") base.options = ["選択肢1", "選択肢2"];
    if (t === "scale") { base.options = ["1", "2", "3", "4", "5"]; base.left = "そう思わない"; base.right = "そう思う"; }
    if (t === "free") base.placeholder = "";
    setDq(dq.concat([base]));
  }
  async function saveQuestions() {
    if (!dq || !dq.length) { notify("設問が1つもありません"); return; }
    for (const q0 of dq) {
      if (!String((q0 && q0.text) || "").trim()) { notify("設問文が空の項目があります"); return; }
      if (q0.type === "single") {
        const os = (q0.options || []).map(s => String(s).trim()).filter(Boolean);
        if (os.length < 2) { notify("選択式の設問には2つ以上の選択肢が必要です"); return; }
      }
    }
    const out = sanitizeQuestions(dq); // スキーマ検証(文字数クランプ・不正型除外・ID正規化)
    if (!out || out.length !== dq.length) { notify("形式が不正な設問があります(設問200字・選択肢60字×12個までです)"); return; }
    const ok = await sSet("config:questions", out);
    if (ok) { setQuestions(out); setDq(JSON.parse(JSON.stringify(out))); notify("設問を保存しました(" + out.length + "問)"); }
    else notify("設問の保存に失敗しました");
  }
  async function savePolicy() {
    const cp = sanitizePolicy(dp); // スキーマ検証(版20字・本文8000字)
    if (!cp) { notify("版と本文を入力してください(版20字・本文8000字まで)"); return; }
    const ok = await sSet("config:policy", cp);
    if (ok) { setPolicy(cp); setDp({ version: cp.version, text: cp.text }); notify("同意文を保存しました(v" + cp.version + ")"); }
    else notify("同意文の保存に失敗しました");
  }
  async function savePass() {
    const p = np.trim();
    if (p.length < 4) { notify("合言葉は4文字以上にしてください"); return; }
    const ok = await sSet("config:admin", { pass: p });
    if (ok) { setSaved({ pass: p }); setNp(""); notify("合言葉を変更しました"); }
    else notify("変更に失敗しました");
  }

  if (locked) {
    return (
      <div style={{ maxWidth: 460, margin: "50px auto" }}>
        <H2 eyebrow="ADMIN" sub="設問・同意文の編集とデータ操作を行います">管理画面</H2>
        <Card>
          <Field label="合言葉" sub="初期値は admin(解錠後に変更できます)">
            <input type="password" value={pass} onChange={e => setPass(e.target.value)} style={INPUT_STYLE} placeholder="合言葉を入力" />
          </Field>
          <Btn onClick={unlock}>解錠する</Btn>
          <div style={{ fontSize: 11, color: C.karashi, marginTop: 12 }}>
            ※ これは簡易ロックです。データは共有ストレージ上にあるため、本番運用ではサーバー側の認証・権限管理が必須です。
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <H2 eyebrow="ADMIN" sub={"現在の回答数: " + (agg ? agg.total : 0) + "件 / アプリ v" + APP_VER}>管理画面</H2>

      {prog ? (
        <Card pad={12} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, marginBottom: 5 }}>
            {prog.label}… <span style={{ fontFamily: FONT_MONO }}>{prog.i}/{prog.n}</span>
          </div>
          <div style={{ height: 6, background: C.soft, borderRadius: 3 }}>
            <div style={{ height: 6, width: (prog.n ? (prog.i / prog.n) * 100 : 100) + "%", background: C.green, borderRadius: 3 }} />
          </div>
        </Card>
      ) : null}

      <H2 eyebrow="DATA" sub="デモデータは架空の回答です。操作は全利用者の統計に反映されます。">データ操作</H2>
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn small onClick={insertDemo} disabled={busy}>デモデータ投入(9件)</Btn>
          <Btn small kind="ghost" onClick={removeDemo} disabled={busy}>デモデータ削除</Btn>
          <Btn small kind="ghost" onClick={() => rebuild(false, false)} disabled={busy}>集計を再構築</Btn>
          <Btn small kind="ghost" onClick={() => rebuild(false, true)} disabled={busy}>旧簡易解析を補完</Btn>
          <Btn small kind="ghost" onClick={exportJson} disabled={busy}>JSONエクスポート</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>
          「集計を再構築」は回答を変更せず統計だけを作り直します。「旧簡易解析を補完」は、自由記述があるのに旧フォールバックで意見チャンクが空になった回答だけを端末内で再解析してから集計します。旧AI解析、回答本文、ID、日時は変更しません。エクスポートは全回答・設問・同意文・集計を1つのJSONに出力します。
        </div>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid " + C.rule }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>JSONインポート(回答のみ)</div>
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.9 }}>
            エクスポートしたJSONから<b>回答だけ</b>を取り込みます。設問・同意文などの設定は取り込みません
            (現在運用中の設問と衝突するのを避けるためです)。全レコードを検証し、既に存在する回答IDはスキップします。
            設問を改訂した後に旧バージョンのデータを取り込むと、旧設問への回答は保持されますが、現在の設問の分布・クロス集計には反映されません。
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="file" accept="application/json,.json" disabled={busy}
              onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; importJson(f); }}
              style={{ fontSize: 12 }} />
          </div>
          {impInfo ? (
            <div style={{ marginTop: 10, background: C.soft, borderRadius: 5, padding: "9px 11px", fontSize: 12, lineHeight: 1.9 }}>
              <div><b>取り込み結果</b></div>
              <div>追加: {impInfo.added}件 ／ 重複でスキップ: {impInfo.dup}件 ／ 不正で除外: {impInfo.bad}件</div>
              {impInfo.foreign ? (
                <div style={{ color: C.karashi }}>
                  うち {impInfo.foreign}件は現在の設問に無い設問への回答です(自由記述・意見は統計に反映されますが、選択回答の分布には現れません)。
                </div>
              ) : null}
              <div style={{ color: C.sub }}>再構築後の総回答数: {impInfo.total}件</div>
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
          <input value={delId} onChange={e => setDelId(e.target.value)} placeholder="回答IDを入力して個別削除" style={{ ...INPUT_STYLE, width: 240, fontFamily: FONT_MONO }} />
          <Btn small kind="ghost" onClick={removeById} disabled={busy || !delId.trim()}>ID指定で削除</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
          撤回依頼を受けた回答などを、回答ID指定で1件だけ削除できます(削除後は集計を自動再構築)。
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
          <input value={wipe} onChange={e => setWipe(e.target.value)} placeholder="全削除するには「削除」と入力" style={{ ...INPUT_STYLE, width: 240 }} />
          <Btn small kind="danger" onClick={wipeAll} disabled={busy || wipe !== "削除"}>全回答データを削除</Btn>
        </div>
      </Card>

      <H2 eyebrow="QUESTIONS" sub="保存すると全利用者の設問が即時に切り替わります。選択肢の文言を変えると過去の回答とは別カウントになります。">設問エディタ</H2>
      {(dq || []).map((q, i) => (
        <Card key={q.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.sub }}>Q{i + 1} · {q.id}</span>
            <select value={q.type} onChange={e => typeChange(i, e.target.value)}
              style={{ padding: "6px 9px", borderRadius: 5, border: "1.5px solid " + C.rule, background: C.card, fontSize: 12 }}>
              <option value="single">選択式</option>
              <option value="scale">5段階</option>
              <option value="free">自由記述</option>
            </select>
            <Btn small kind="danger" style={{ marginLeft: "auto" }} onClick={() => setDq(dq.filter((x, j) => j !== i))}>削除</Btn>
          </div>
          <Field label="設問文">
            <input value={q.text} onChange={e => updQ(i, { text: e.target.value })} style={INPUT_STYLE} placeholder="設問文を入力" />
          </Field>
          {q.type === "single" ? (
            <Field label="選択肢" sub="1行に1つ">
              <textarea rows={4} value={(q.options || []).join("\n")} onChange={e => updQ(i, { options: e.target.value.split("\n") })}
                style={{ ...INPUT_STYLE, resize: "vertical", lineHeight: 1.7 }} />
            </Field>
          ) : q.type === "scale" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <Field label="1側のラベル">
                <input value={q.left || ""} onChange={e => updQ(i, { left: e.target.value })} style={INPUT_STYLE} />
              </Field>
              <Field label="5側のラベル">
                <input value={q.right || ""} onChange={e => updQ(i, { right: e.target.value })} style={INPUT_STYLE} />
              </Field>
            </div>
          ) : (
            <Field label="プレースホルダ(記入例)">
              <input value={q.placeholder || ""} onChange={e => updQ(i, { placeholder: e.target.value })} style={INPUT_STYLE} />
            </Field>
          )}
        </Card>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <Btn small kind="ghost" onClick={() => addQ("single")}>+ 選択式を追加</Btn>
        <Btn small kind="ghost" onClick={() => addQ("scale")}>+ 5段階を追加</Btn>
        <Btn small kind="ghost" onClick={() => addQ("free")}>+ 自由記述を追加</Btn>
      </div>
      <Btn onClick={saveQuestions} disabled={busy}>設問を保存する</Btn>

      <H2 eyebrow="POLICY" sub="版(version)を変えて保存すると、以後の回答時に新しい同意文が表示・記録されます。">同意文エディタ</H2>
      <Card>
        <Field label="版(version)">
          <input value={dp ? dp.version : ""} onChange={e => setDp({ ...dp, version: e.target.value })} style={{ ...INPUT_STYLE, width: 140 }} />
        </Field>
        <Field label="本文">
          <textarea rows={12} value={dp ? dp.text : ""} onChange={e => setDp({ ...dp, text: e.target.value })}
            style={{ ...INPUT_STYLE, resize: "vertical", lineHeight: 1.8 }} />
        </Field>
        <Btn onClick={savePolicy} disabled={busy}>同意文を保存する</Btn>
      </Card>

      <H2 eyebrow="SECURITY">合言葉の変更</H2>
      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="password" value={np} onChange={e => setNp(e.target.value)} placeholder="新しい合言葉(4文字以上)" style={{ ...INPUT_STYLE, width: 240 }} />
          <Btn small onClick={savePass} disabled={busy}>変更する</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>プロトタイプの簡易ロックであり、厳密なアクセス制御ではありません。</div>
      </Card>
    </div>
  );
}

/* ============================================================
   自分の回答(匿名・回答IDによる本人確認)
   アカウントを作らず、回答IDという合鍵だけで自分の回答を確認・撤回できる。
   IDは読み取り権限も兼ねるため、暗号強度の乱数で生成している(logic.js の uid)。
   ============================================================ */
function MyResponse({ questions, agg, notify, refreshAgg, goto, back, session, onAccountUpdated, onResponseDeleted }) {
  const [stage, setStage] = useState("input"); // input | view | working | done
  const [idv, setIdv] = useState("");
  const [err, setErr] = useState("");
  const [found, setFound] = useState(null);
  const [prog, setProg] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmSecondDelete, setConfirmSecondDelete] = useState(false);
  const [editMode, setEditMode] = useState(null);
  const [editText, setEditText] = useState("");
  const [editAnswers, setEditAnswers] = useState({});
  const editBusyRef = useRef(false);

  const [noSelf, setNoSelf] = useState(false); // ログイン済みだが未回答
  const [selfLookupError, setSelfLookupError] = useState("");
  const [selfLookupNonce, setSelfLookupNonce] = useState(0);

  /* ログイン中はアカウントに紐付いた回答を自動表示する(IDの入力は不要)。
     通信失敗と「回答なし」は分離し、失敗時に未回答扱いへ落とさない。 */
  useEffect(() => {
    let alive = true;
    setNoSelf(false);
    setSelfLookupError("");
    (async () => {
      if (session) {
        try {
          const rec = await acctGet(session.name, cloudApiEnabled());
          if (!alive) return;
          if (rec && rec.respId) { setIdv(rec.respId); lookup(rec.respId); }
          else setNoSelf(true);
        } catch (error) {
          if (!alive) return;
          console.warn("account response lookup failed", error);
          setSelfLookupError("本人回答を確認できませんでした。通信状態を確認して、もう一度試してください。");
        }
        return;
      }
      const last = await pGet("last:id");
      if (alive && last && last.id) setIdv(last.id);
    })();
    return () => { alive = false; };
  }, [session, selfLookupNonce]);

  async function lookup(idArg) {
    setErr("");
    const raw = sanitizeId(idArg !== undefined ? idArg : idv);
    if (!raw) { setErr("回答IDの形式が正しくありません。半角英数と「-」「_」のみ・4〜64文字です。"); return; }
    /* 追記のキー({元ID}-2)を入力された場合も元のIDとして扱う */
    const id = raw.slice(-2) === "-2" ? raw.slice(0, -2) : raw;
    setStage("working");
    if (cloudApiEnabled() && session && session.token) {
      try {
        const remote = await cloudLoadOwnResponse(id, session.token);
        if (remote) {
          setFound({ id: id, r: remote, r2: null });
          setConfirming(false);
          setStage("view");
          return;
        }
      } catch (error) {
        setErr("回答サーバーから自分の回答を読み込めませんでした。時間をおいて再度お試しください。");
        setStage("input");
        return;
      }
    }
    const r = await sGet("resp:" + id);
    if (!r) {
      setErr("この回答IDは見つかりませんでした。入力誤りか、すでに削除されている可能性があります。");
      setStage("input");
      return;
    }
    const r2 = await sGet("resp:" + id + "-2");
    setFound({ id: id, r: r, r2: r2 || null });
    setConfirming(false);
    setStage("view");
  }

  async function doDelete() {
    if (!found) return;
    setStage("working");
    if (found.r.remoteId) {
      try { await cloudDeleteResponse(found.r.remoteId); }
      catch (e) {
        setErr("回答サーバーからの削除に失敗しました。時間をおいて再度お試しください。");
        setStage("view");
        return;
      }
    }
    const ok = await sDel("resp:" + found.id);
    if (found.r2) await sDel("resp:" + found.id + "-2"); // 追記も一緒に撤回する
    if (!ok) {
      setErr("削除に失敗しました。時間をおいて再度お試しください。");
      setStage("view");
      return;
    }
    await rebuildAgg((i, n) => setProg({ i: i, n: n }));
    await refreshAgg();
    await pDel("last:id");
    if (onResponseDeleted) onResponseDeleted(found.id);
    setProg(null);
    setStage("done");
    notify("回答を撤回しました");
  }

  async function refreshEditedResponse() {
    if (!found || !session || !session.token) return null;
    const id = found.r.remoteId || found.id;
    const fresh = await cloudLoadOwnResponse(id, session.token);
    if (fresh) {
      setFound({ id: found.id, r: fresh, r2: null });
      await sSet("resp:" + id, fresh);
    }
    return fresh;
  }

  async function deleteSecondResponse() {
    if (editBusyRef.current || !found || !found.r || !found.r.remoteId) return;
    const r = found.r;
    const id = r.remoteId || found.id;
    const revision = Number(r.remoteRevision || r.revision || 1);
    editBusyRef.current = true;
    setErr("");
    try {
      const updated = await cloudDeleteFollowUp(id, revision);
      let fresh = null;
      if (session && session.token) {
        try { fresh = await cloudLoadOwnResponse(id, session.token); }
        catch (loadError) { console.warn("follow-up withdrawal refresh failed", loadError); }
      }
      if (fresh) {
        setFound({ id: found.id, r: fresh, r2: null });
      } else {
        setFound({
          ...found,
          r: {
            ...r,
            followUpText: "",
            followUpSubmitted: false,
            revision: Number(updated && updated.revision || revision + 1),
            remoteRevision: Number(updated && updated.revision || revision + 1),
            analysis: null,
            analysisSource: "cloudflare",
            cloudAnalysisStatus: "pending"
          },
          r2: null
        });
      }
      setConfirmSecondDelete(false);
      setEditMode(null);
      notify("2回目の自由記述を撤回しました。1回目の回答のみで再解析を開始します");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        setErr("回答が更新されています。再読み込みしてからもう一度お試しください。");
      } else if (error && error.code === "FOLLOW_UP_NOT_SUBMITTED") {
        setErr("2回目の自由記述はすでに撤回されています。");
      } else {
        setErr("2回目の自由記述の撤回に失敗しました。時間をおいて再度お試しください。");
      }
    } finally {
      editBusyRef.current = false;
    }
  }

  async function saveResponseEdit() {
    if (editBusyRef.current || !found || !session) return;
    const r = found.r;
    const id = r.remoteId || found.id;
    const revision = Number(r.remoteRevision || r.revision || 1);
    editBusyRef.current = true; setErr("");
    try {
      if (editMode === "free") {
        const body = sanitizeFreeText(editText, 1500);
        await cloudPatchFreeText(id, revision, body);
        notify("1回目の自由記述を修正しました。再解析を開始します");
      } else if (editMode === "followup") {
        const body = sanitizeFreeText(editText, 1500).trim();
        if (!body) { setErr("二度目の自由記述を入力してください。"); return; }
        await cloudPatchFollowUp(id, revision, body);
        notify("2回目の自由記述を修正しました。再解析を開始します");
      } else if (editMode === "answers") {
        const responseQuestions = Array.isArray(r.questions) && r.questions.length ? r.questions : questions;
        const editable = responseQuestions.filter(q => q.type !== "free");
        const payload = Object.fromEntries(editable.map(q => [q.id, String(editAnswers[q.id] || "")]).filter(([, value]) => value));
        if (Object.keys(payload).length !== editable.length) { setErr("すべての選択式設問に回答してください。"); return; }
        await cloudPatchAnswers(id, revision, payload);
        notify("アンケート回答を修正しました。再解析を開始します");
      }
      await refreshEditedResponse();
      setEditMode(null); setEditText(""); setEditAnswers({});
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await refreshEditedResponse();
        setErr("別の更新が先に反映されました。最新の回答を読み直したので、内容を確認してください。");
      } else {
        setErr("回答の修正に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { editBusyRef.current = false; }
  }

  if (stage === "view" && found && editMode) {
    const r = found.r;
    const id = r.remoteId || found.id;
    const revision = Number(r.remoteRevision || r.revision || 1);
    const responseQuestions = Array.isArray(r.questions) && r.questions.length ? r.questions : questions;
    const nonFreeQuestions = responseQuestions.filter(q => q.type !== "free");
    if (editMode === "answers") {
      const complete = nonFreeQuestions.every(q => editAnswers[q.id]);
      return (
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <H2 eyebrow="CORRECTION" sub={"回答ID " + id + " / revision " + revision}>アンケート回答を修正</H2>
          {nonFreeQuestions.map((q, index) => (
            <Card key={q.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{index + 1}. {q.text}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(q.options || []).map(option => <Chip key={option} active={editAnswers[q.id] === option} onClick={() => setEditAnswers({ ...editAnswers, [q.id]: option })}>{option}</Chip>)}
              </div>
            </Card>
          ))}
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn disabled={!complete} onClick={saveResponseEdit}>保存して再解析</Btn>
            <Btn kind="ghost" onClick={() => { setEditMode(null); setErr(""); }}>戻る</Btn>
          </div>
        </div>
      );
    }
    const second = editMode === "followup";
    return (
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <H2 eyebrow="CORRECTION" sub={"回答ID " + id + " / revision " + revision}>{second ? "2回目の自由記述を修正" : "1回目の自由記述を修正"}</H2>
        <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={10} maxLength={1500}
          style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.sub, marginTop: 4 }}>
          <span>提出済みの{second ? "2回目" : "1回目"}だけを書き換えます。新しい提出回数は増えません。</span>
          <span style={{ fontFamily: FONT_MONO }}>{editText.length}/1500</span>
        </div>
        {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Btn onClick={saveResponseEdit}>保存して再解析</Btn>
          <Btn kind="ghost" onClick={() => { setEditMode(null); setErr(""); }}>戻る</Btn>
        </div>
      </div>
    );
  }

  if (stage === "working") {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <H2 eyebrow="MY RESPONSE" sub="回答IDで自分の回答を確認・撤回できます">マイレスポンス確認・修正</H2>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "26px 0" }}>
            <Spinner />
            <div style={{ fontSize: 12, color: C.sub }}>
              {prog ? "統計を再計算しています… " + prog.i + "/" + prog.n : "処理しています…"}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <H2 eyebrow="MY RESPONSE" sub="回答IDで自分の回答を確認・撤回できます">マイレスポンス確認・修正</H2>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>回答を撤回しました</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            保存データから消去し、統計も撤回後の内容で再計算済みです。ご協力ありがとうございました。
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("home")}>ホームへ戻る</Btn>
            <Btn kind="ghost" onClick={() => { setFound(null); setIdv(""); setStage("input"); }}>別のIDを照会する</Btn>
          </div>
        </Card>
      </div>
    );
  }

  if (stage === "view" && found) {
    const r = found.r;
    const an = r.analysis;
    const analysisState = analysisStateLabel(r);
    const d = r.demo || {};
    const demoLine = Object.keys(DEMO_LABELS).map(k => (d[k] ? DEMO_LABELS[k] + ": " + d[k] : null)).filter(Boolean).join(" ／ ");
    const ov = agg && agg.total ? overallParams(agg) : null;
    const pubChunks = [].concat((an && an.chunks) || []);
    /* 全体平均は個人と同じ物差しに揃える。
       ov.emo は極性(-1〜+1)のままなので、emoToPos で 0〜100 に写してから並べる。
       これを忘れると「感情ポジ度 45 (全体 0)」のように、単位の違う数が並んでしまう。 */
    const rows = an ? [
      ["感情ポジ度", emoToPos(an.params.emo.pol), ov ? emoToPos(ov.emo) : null, emoColor(an.params.emo.pol)],
      ["妥当性", an.params.valid, ov ? ov.valid : null, null],
      ["切実度", an.params.crit, ov ? ov.crit : null, C.karashi],
      ["意欲", an.params.motiv, ov ? ov.motiv : null, C.slate]
    ] : [];

    return (
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <H2 eyebrow="MY RESPONSE" sub="回答IDで照会した、あなたの回答です">マイレスポンス確認・修正</H2>
        {session ? <AccountSettings session={session} onUpdated={onAccountUpdated} /> : null}

        <Card style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <div>
              <div style={{ fontSize: 11, color: C.sub }}>回答ID</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 14 }}>{found.id}</div>
            </div>
            <div style={{ fontSize: 12, color: C.sub }}>回答日時: {r.ts ? fmtDT(r.ts) : "不明"}</div>
          </div>
          {demoLine ? <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>{demoLine}</div> : null}
          {r.demoFlag ? <div style={{ fontSize: 12, color: C.karashi, marginTop: 6 }}>※ これは管理者が投入したデモデータです。</div> : null}
        </Card>

        {analysisState ? (
          <Card pad={12} style={{ marginBottom: 12, borderColor: analysisState.tone === "error" ? C.bengara : analysisState.tone === "success" ? C.green : C.karashi }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{analysisState.title}</div>
            <div style={{ fontSize: 11, color: C.sub }}>{analysisState.detail}</div>
          </Card>
        ) : null}

        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>あなたの回答内容</div>
          {questions.filter(q => q.type !== "free").map(q => (
            <div key={q.id} style={{ padding: "7px 0", borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 12, color: C.sub }}>{q.text}</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {r.answers && r.answers[q.id]
                  ? (q.type === "scale" ? r.answers[q.id] + " / 5" : r.answers[q.id])
                  : "未回答"}
              </div>
            </div>
          ))}
          {r.free ? (
            <div style={{ padding: "7px 0", borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>自由記述(1回目・原文)</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.free}</div>
            </div>
          ) : null}
          {r.followUpSubmitted ? (
            <div style={{ padding: "7px 0", borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>自由記述(2回目・原文)</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.followUpText || "（記載なし）"}</div>
              {r.remoteId ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {confirmSecondDelete ? (
                    <>
                      <Btn small kind="danger" onClick={deleteSecondResponse}>2回目を本当に撤回する</Btn>
                      <Btn small kind="ghost" onClick={() => setConfirmSecondDelete(false)}>やめる</Btn>
                    </>
                  ) : (
                    <Btn small kind="ghost" onClick={() => setConfirmSecondDelete(true)}>2回目を撤回</Btn>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.sub, marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.rule }}>二度目の自由記述はまだ提出していません。</div>
          )}
        </Card>

        {session && r.remoteId ? (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>回答内容を修正</div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>初回回答はアンケートと1回目自由記述を一緒に修正します。2回目は独立して修正・撤回できます。</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn small kind="ghost" onClick={() => goto("surveyEdit")}>初回回答を修正</Btn>
              {r.followUpSubmitted
                ? <Btn small kind="ghost" onClick={() => { setEditText(String(r.followUpText || "")); setEditMode("followup"); setErr(""); }}>2回目を修正</Btn>
                : <Btn small onClick={() => goto("followup")}>二度目の自由記述を書く</Btn>}
            </div>
          </Card>
        ) : null}

        {an ? (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>意見量子化の結果</div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>
              括弧内は全体平均です。数値はAI解析または規則fallbackによる推定であり、正確性を保証するものではありません。
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Badge>感情: {an.params.emo.label}</Badge>
              <Badge>イデオロギー: 経済 {an.ideology.econ} / 社会 {an.ideology.soc}</Badge>
              {Number.isFinite(Number(an.ideology.confidence)) ? <Badge>推定確信度: {Math.round(an.ideology.confidence)}%</Badge> : null}
              {an.engine === SEISEKI_LOCAL_ENGINE ? <Badge>端末内モデル</Badge>
                : an.engine === LOCAL_ANALYSIS_ENGINE ? <Badge>ローカル規則解析</Badge>
                : an.ai === false ? <Badge>旧簡易推定</Badge> : null}
            </div>
            <IdeologyReading ideology={an.ideology} attrs={an.attrs} />
            {analysisDiagnosticsVisible() && r.analysisValueTrace ? <AnalysisValueTrace trace={r.analysisValueTrace} /> : null}
            {/* MeterBar が受け取るのは value。v では届かず、clamp(undefined) が
                (0+100)/2 = 50 を返すため、どの項目も必ず 50 の半分バーになっていた。 */}
            {rows.map(row => (
              <MeterBar
                key={row[0]}
                label={row[0]}
                note={row[2] === null || row[2] === undefined ? "" : "全体 " + Math.round(row[2])}
                value={row[1]}
                color={row[3]}
              />
            ))}
          </Card>
        ) : null}

        {pubChunks.length ? (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>公開されている意見(この要約が統計に使われます)</div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>
              自由記述の原文は公開されません。規則解析が抽出した以下の要約のみが、他の利用者に表示されます。
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {pubChunks.map((c, i) => <OpinionCard key={i} o={c} />)}
            </div>
          </Card>
        ) : null}

        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>回答の撤回</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>
            この回答を削除すると元に戻せません。保存データから消去され、統計も削除後の内容で再計算されます。
          </div>
          {err ? <div style={{ fontSize: 12, color: C.bengara, marginBottom: 10 }}>{err}</div> : null}
          {confirming ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn kind="danger" onClick={doDelete}>本当に撤回する(取り消せません)</Btn>
              <Btn kind="ghost" onClick={() => setConfirming(false)}>やめる</Btn>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn kind="danger" onClick={() => setConfirming(true)}>回答、解析結果を削除する</Btn>
              <Btn kind="ghost" onClick={() => { setFound(null); setStage("input"); }}>別のIDを照会する</Btn>
              <Btn kind="ghost" onClick={() => goto("dash")}>ダッシュボードへ</Btn>
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <H2 eyebrow="MY RESPONSE" sub={session ? "ログイン中: アカウントに紐付いた回答を表示します" : "回答ID(合鍵)でも、ログインなしで照会できます"}>マイレスポンス確認・修正</H2>
      {session ? <AccountSettings session={session} onUpdated={onAccountUpdated} /> : null}
      {session && selfLookupError ? (
        <Card pad={13} style={{ marginBottom: 12, borderColor: C.bengara }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{selfLookupError}</div>
            <Btn small kind="ghost" onClick={() => setSelfLookupNonce(selfLookupNonce + 1)}>もう一度確認する</Btn>
          </div>
        </Card>
      ) : null}
      {session && noSelf && !selfLookupError ? (
        <Card pad={13} style={{ marginBottom: 12, borderColor: C.green }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>
              <b>{session.name}</b> さんのアカウントには、まだ回答がありません。
            </div>
            <Btn small onClick={() => goto("survey")}>回答する</Btn>
          </div>
        </Card>
      ) : null}
      {!session ? (
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>
          ログインすると、IDを入力しなくても自分の回答が自動で表示されます(「回答する」タブからログインできます)。
        </div>
      ) : null}
      <Card>
        <Field label="回答ID" sub="送信完了画面に表示されたIDです。この端末で回答した場合は自動で入ります">
          <input value={idv} onChange={e => setIdv(e.target.value)} placeholder="例: mrhwvr44-k3n7p2qa-t9wz4bxm" style={{ ...INPUT_STYLE, fontFamily: FONT_MONO }} />
        </Field>
        {err ? <div style={{ fontSize: 12, color: C.bengara, marginBottom: 10 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => lookup()} disabled={!idv.trim()}>自分の回答を表示する</Btn>
          <Btn kind="ghost" onClick={back}>前の画面へ</Btn>
          <Btn kind="ghost" onClick={() => goto("home")}>ホームへ</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 14, lineHeight: 1.8 }}>
          本アプリはアカウントを持ちません。回答は匿名で保存され、氏名などと結び付けられません。そのぶん、回答IDがあなた本人であることの唯一の証明になります。<br />
          回答IDを紛失すると、匿名設計のため本人でも回答を特定できません。第三者に知られると内容の閲覧や撤回をされる恐れがあるため、大切に保管してください。
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   イメージツリー(v0.13)
   面積=意見の数、色=平均感情。全体の「どこに声が集まり、どこが荒れているか」を一望させる。
   セルをクリックすると、そのトピック/対象で絞り込んだ意見一覧へ移動する。
   ============================================================ */
const TREE_W = 900, TREE_H = 420;

function TreeMap({ rows, w, h, onPick, total, showShare }) {
  const cells = useMemo(() => squarify(rows, 0, 0, w, h), [rows, w, h]);
  if (!cells.length) return null;
  const shareBase = Number(total) > 0 ? Number(total) : cells.reduce((sum, cell) => sum + Number(cell.n || 0), 0);
  return (
    <svg viewBox={"0 0 " + w + " " + h} style={{ width: "100%", maxWidth: 760, height: "auto", display: "block", margin: "0 auto", borderRadius: 6 }}>
      {cells.map(c => {
        const fill = colorForEmo(c.emo);
        const showName = c.w > 78 && c.h > 34;
        const showSub = c.w > 108 && c.h > 62;
        const showCompactShare = showShare && !showSub && c.w > 44 && c.h > 24;
        const fs = Math.max(12, Math.min(22, Math.round(Math.sqrt(c.w * c.h) / 7)));
        const share = shareBase ? (Number(c.n || 0) / shareBase) * 100 : 0;
        const shareLabel = (share < 1 ? share.toFixed(1) : share.toFixed(1).replace(/\.0$/, "")) + "%";
        return (
          <g key={c.name} className={onPick ? "visual-action" : undefined} role={onPick ? "button" : undefined} tabIndex={onPick ? 0 : undefined}
            onClick={() => onPick && onPick(c)}
            onKeyDown={e => { if (onPick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(c); } }}>
            <title>{c.name + " / " + c.n + "件" + (showShare ? " / 全体の " + shareLabel : "") + " / 感情ポジ度 " + emoToPos(c.emo) + " / 切実度 " + Math.round(c.crit) + "。クリックで詳しく表示"}</title>
            <rect x={c.x} y={c.y} width={c.w} height={c.h} fill={fill} stroke={C.paper} strokeWidth={2} />
            {showName ? (
              <text x={c.x + 10} y={c.y + fs + 6} fill="#FFFFFF" fontSize={fs} fontWeight="700" fontFamily={FONT_BODY}>
                {c.name}
              </text>
            ) : null}
            {showSub ? (
              <text x={c.x + 10} y={c.y + fs + 26} fill="rgba(255,255,255,0.82)" fontSize={12} fontFamily={FONT_MONO}>
                {showShare ? c.n + "件 / 全体の " + shareLabel : c.n + "件 / 切実度 " + Math.round(c.crit)}
              </text>
            ) : null}
            {showCompactShare ? (
              <text x={c.x + c.w / 2} y={c.y + c.h - 8} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize={10} fontWeight="700" fontFamily={FONT_MONO} style={{ pointerEvents: "none" }}>
                {shareLabel}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function EmoLegend() {
  const stops = [-1, -0.5, 0, 0.5, 1];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: C.sub }}>
      <span>不満・否定</span>
      <span style={{ display: "flex" }}>
        {stops.map(s => (
          <span key={s} style={{ width: 26, height: 10, background: colorForEmo(s), display: "inline-block" }} />
        ))}
      </span>
      <span>好意・肯定</span>
      <span style={{ marginLeft: 6 }}>／ 面積 = 意見の数</span>
    </div>
  );
}

/* 対象(政党・省庁…)の階層ツリー。折りたたみ式。 */
function TargetTree({ agg, onPick }) {
  const [open, setOpen] = useState({});
  const tree = useMemo(() => targetTree(agg), [agg]);
  if (!tree.length) {
    return <Card><div style={{ fontSize: 13, color: C.sub }}>まだ対象の抽出された意見がありません。</div></Card>;
  }
  const maxN = Math.max(...tree.map(g => g.n), 1);
  return (
    <Card pad={0}>
      {tree.map((g, gi) => {
        const isOpen = !!open[g.tt];
        return (
          <div key={g.tt} style={{ borderTop: gi ? "1px solid " + C.rule : "none" }}>
            <button onClick={() => setOpen({ ...open, [g.tt]: !isOpen })}
              style={{ width: "100%", background: "none", border: "none", padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.sub, width: 12 }}>{isOpen ? "−" : "+"}</span>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colorForEmo(g.emo), flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 14, minWidth: 96 }}>{g.tt}</span>
              <span style={{ flex: 1, minWidth: 60, height: 6, background: C.soft, borderRadius: 3, overflow: "hidden" }}>
                <span style={{ display: "block", width: (g.n / maxN * 100) + "%", height: "100%", background: colorForEmo(g.emo) }} />
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.sub, whiteSpace: "nowrap" }}>{g.n}件</span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 14px 12px 42px" }}>
                {g.children.map(ch => {
                  const cmax = Math.max(...g.children.map(x => x.n), 1);
                  return (
                    <div key={ch.tn} className="target-tree-row" role="button" tabIndex={0}
                      onClick={() => onPick && onPick(g.tt, ch.tn)}
                      onKeyDown={e => { if (onPick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(g.tt, ch.tn); } }}
                      style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", borderRadius: 5, cursor: "pointer", background: C.soft, marginBottom: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: colorForEmo(ch.emo), flexShrink: 0 }} />
                      <span style={{ fontSize: 13, flex: 1, minWidth: 80 }}>{ch.tn}</span>
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {Object.keys(ch.cats).map(k => (
                          <span key={k} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: (CAT_STYLE[k] || {}).bg || C.rule, color: (CAT_STYLE[k] || {}).fg || C.ink }}>
                            {k}{ch.cats[k]}
                          </span>
                        ))}
                      </span>
                      <span style={{ width: 54, height: 5, background: C.rule, borderRadius: 3, overflow: "hidden", flexShrink: 0 }}>
                        <span style={{ display: "block", width: (ch.n / cmax * 100) + "%", height: "100%", background: C.sub }} />
                      </span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.sub, width: 34, textAlign: "right", flexShrink: 0 }}>{ch.n}件</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>行をクリックすると、その対象への意見だけを一覧できます。</div>
              </div>
            ) : null}
          </div>
        );
      })}
    </Card>
  );
}

/* ============================================================
   ユーザー登録・ログイン(v0.15)
   「閲覧は誰でも・発言は登録者」。ニックネームのみ・本名禁止。
   ============================================================ */
function AuthGate({ onAuthed, goto, destination, guestView }) {
  const [mode, setMode] = useState("register"); // register | login
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setErr(""); setBusy(true);
    let r;
    if (mode === "register") {
      if (pass !== pass2) { setErr("確認用パスワードが一致しません"); setBusy(false); return; }
      r = await acctRegister(name, pass);
    } else {
      r = await acctLogin(name, pass);
    }
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onAuthed(r.acct);
  }

  return (
    <div>
      <Card>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <Chip active={mode === "register"} onClick={() => { setMode("register"); setErr(""); }}>はじめて(登録)</Chip>
          <Chip active={mode === "login"} onClick={() => { setMode("login"); setErr(""); }}>2回目以降(ログイン)</Chip>
        </div>
        <Field label="名前(ニックネーム)" sub="2〜20文字。本名や実在の氏名は使わないでください">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="例: 川辺の亀" style={{ ...INPUT_STYLE }} autoComplete="off" />
        </Field>
        <Field label="パスワード" sub={mode === "register" ? "8文字以上" : ""}>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} style={{ ...INPUT_STYLE }} />
        </Field>
        {mode === "register" ? (
          <Field label="パスワード(確認)">
            <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} style={{ ...INPUT_STYLE }} />
          </Field>
        ) : null}
        {err ? <div style={{ fontSize: 12, color: C.bengara, marginBottom: 10 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={go} disabled={busy || !name.trim() || !pass}>
            {busy ? "確認しています…" : mode === "register"
              ? "登録して" + (destination || "回答") + "へ進む"
              : "ログインして" + (destination || "回答") + "へ進む"}
          </Btn>
          <Btn kind="ghost" onClick={() => goto(guestView || "dash")}>登録せずに閲覧する</Btn>
        </div>
      </Card>
      <div style={{ fontSize: 11, color: C.sub, marginTop: 12, lineHeight: 2 }}>
        登録するのはニックネームとパスワードだけで、メールアドレス等は不要です。回答はアカウントに紐付き、別の端末でもログインすれば確認・追記・撤回ができます。<br />
        <b style={{ color: C.bengara }}>重要:</b> 本アプリは試作段階で、保存領域の秘匿性に限界があります。<b>他のサービスと同じパスワードは絶対に使わないでください</b>(パスワードは復元不能なハッシュとしてのみ保存します)。
      </div>
    </div>
  );
}

/* 極座標→直交座標。真上(-90度)を起点に時計回り。 */
function polar(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }

/* 扇形(ドーナツの一部)のSVGパス。全周のときは切れ目が出ないよう2分割する。 */
function arcPath(cx, cy, r0, r1, a0, a1) {
  const TAU = Math.PI * 2;
  const span = a1 - a0;
  if (span >= TAU - 1e-6) {
    const m = a0 + Math.PI;
    return arcPath(cx, cy, r0, r1, a0, m) + " " + arcPath(cx, cy, r0, r1, m, a0 + TAU - 1e-9);
  }
  const large = span > Math.PI ? 1 : 0;
  const p1 = polar(cx, cy, r1, a0), p2 = polar(cx, cy, r1, a1);
  const p3 = polar(cx, cy, r0, a1), p4 = polar(cx, cy, r0, a0);
  return "M" + p1[0] + " " + p1[1] +
    " A" + r1 + " " + r1 + " 0 " + large + " 1 " + p2[0] + " " + p2[1] +
    " L" + p3[0] + " " + p3[1] +
    " A" + r0 + " " + r0 + " 0 " + large + " 0 " + p4[0] + " " + p4[1] + " Z";
}

/* 放射ツリー(サンバースト)。中心=全意見、内側から
   政権支持グループ → トピック → 意見カテゴリ の順に細分化する。 */
function RadialTree({ agg, questions, onPick }) {
  const anchorQ = questions.find(q => q.id === ANCHOR_QID);
  const supOrder = (anchorQ && anchorQ.options) ? anchorQ.options.map(String) : [];
  const rt = useMemo(() => radialTree(agg, supOrder, 12), [agg, questions]);
  if (!rt.total) return null;

  const branchLoad = Math.max(rt.ring2.length, rt.ring3.length);
  const treeScale = Math.max(1, Math.min(1.9, 1 + Math.max(0, branchLoad - 18) * 0.018));
  const R0 = 62;
  const R1 = Math.round(128 * treeScale);
  const R2 = Math.round(218 * treeScale);
  const R3 = Math.round(268 * treeScale);
  const S = Math.max(640, R3 * 2 + 84), cx = S / 2, cy = S / 2;

  function label(arc, r, minSpan, size, fill) {
    const span = arc.a1 - arc.a0;
    if (span < minSpan) return null;
    const mid = (arc.a0 + arc.a1) / 2;
    const p = polar(cx, cy, r, mid);
    let deg = mid * 180 / Math.PI;
    if (deg > 90 || deg < -90) deg += 180; // 逆さ文字を防ぐ
    return (
      <text x={p[0]} y={p[1]} fill={fill} fontSize={size} fontWeight="700" fontFamily={FONT_BODY}
        textAnchor="middle" dominantBaseline="central" transform={"rotate(" + deg + " " + p[0] + " " + p[1] + ")"}
        style={{ pointerEvents: "none" }}>
        {arc.label}
      </text>
    );
  }

  return (
    <svg viewBox={"0 0 " + S + " " + S} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", maxWidth: 720, height: "auto", display: "block", margin: "0 auto" }}>
      {rt.ring1.map(arc => (
        <g key={arc.key} className="visual-action" role="button" tabIndex={0}
          onClick={() => onPick && onPick({ sup: arc.sup })}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick && onPick({ sup: arc.sup }); } }}>
          <title>{arc.label + " の人からの意見 " + arc.n + "件"}</title>
          <path d={arcPath(cx, cy, R0, R1, arc.a0, arc.a1)} fill={SUP_COLORS[arc.sup] || C.gray} stroke={C.paper} strokeWidth={2} />
          {label(arc, (R0 + R1) / 2, 0.30, Math.round(13 * treeScale), "#FFFFFF")}
        </g>
      ))}
      {rt.ring2.map(arc => (
        <g key={arc.key} className="visual-action" role="button" tabIndex={0}
          onClick={() => onPick && onPick({ sup: arc.sup, topic: arc.rest ? "" : arc.topic })}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick && onPick({ sup: arc.sup, topic: arc.rest ? "" : arc.topic }); } }}>
          <title>{arc.topic + " / " + arc.label + " " + arc.n + "件 / 感情ポジ度 " + emoToPos(arc.emo)}</title>
          <path d={arcPath(cx, cy, R1, R2, arc.a0, arc.a1)} fill={arc.rest ? C.rule : colorForEmo(arc.emo)} stroke={C.paper} strokeWidth={1.5} />
          {label(arc, (R1 + R2) / 2, 0.20, Math.round(12 * treeScale), arc.rest ? C.sub : "#FFFFFF")}
        </g>
      ))}
      {rt.ring3.map(arc => (
        <g key={arc.key} className="visual-action" role="button" tabIndex={0}
          onClick={() => onPick && onPick({ sup: arc.sup, topic: arc.topic, cat: arc.cat })}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick && onPick({ sup: arc.sup, topic: arc.topic, cat: arc.cat }); } }}>
          <title>{arc.sup + " → " + arc.topic + " → " + arc.cat + " " + arc.n + "件"}</title>
          <path d={arcPath(cx, cy, R2, R3, arc.a0, arc.a1)}
            fill={(CAT_STYLE[arc.cat] || {}).bg || C.soft} stroke={C.paper} strokeWidth={1} />
          {label(arc, (R2 + R3) / 2, 0.26, Math.round(10 * treeScale), (CAT_STYLE[arc.cat] || {}).fg || C.ink)}
        </g>
      ))}
      <circle cx={cx} cy={cy} r={R0 - 3} fill={C.card} stroke={C.rule} />
      <text x={cx} y={cy - 10} textAnchor="middle" fontSize={Math.round(12 * treeScale)} fill={C.sub} fontFamily={FONT_BODY}>意見の総数</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize={Math.round(26 * treeScale)} fontWeight="700" fill={C.ink} fontFamily={FONT_MONO}>{rt.total}</text>
    </svg>
  );
}

/* ============================================================
   意見ネットワーク(v0.15)— 参考図: 共起ネットワーク
   「政治」を中心に据え、意見トピックを円で配置する。
   円の大きさ=意見の数、色の濃さ=熱量(ネガ度×切実度×意欲)。
   熱量が高いトピックほど濃く、中心の近くに置かれる。
   トピック間の線は、同じ回答の中で併せて語られた回数(相関)。
   ============================================================ */
function heatColor(t) { return lerpHex("#EFEBE0", "#7A2E12", t); }

function NetGraph({ agg, onPick }) {
  const data = useMemo(() => opinionNetwork(agg), [agg]);
  if (!data.nodes.length) {
    return (
      <div style={{ minHeight: 150, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 18, fontSize: 13, color: C.sub, lineHeight: 1.9 }}>
        ネットワークに使える意見チャンクがありません。旧版で簡易保存した回答は、管理タブの「旧簡易解析を補完」で再解析できます。
      </div>
    );
  }
  const S = 680, cx = S / 2, cy = S / 2;
  const placed = networkLayout(data.nodes, cx, cy, 104, 274);
  const pos = {};
  for (const pn of placed) pos[pn.name] = pn;
  let maxN = 1, maxL = 1;
  for (const pn of placed) if (pn.n > maxN) maxN = pn.n;
  for (const l of data.links) if (l.n > maxL) maxL = l.n;
  const rOf = pn => 13 + Math.sqrt(pn.n / maxN) * 25;

  return (
    <svg viewBox={"0 0 " + S + " " + S} style={{ width: "100%", maxWidth: 680, height: "auto", display: "block", margin: "0 auto" }}>
      {placed.map((pn, i) => (
        <line className="network-drift" style={{ animationDelay: ((i % 9) * -0.7) + "s" }} key={"c" + pn.name} x1={cx} y1={cy} x2={pn.x} y2={pn.y} stroke={C.rule} strokeWidth={1} />
      ))}
      {data.links.map(l => {
        const a = pos[l.a], b = pos[l.b];
        if (!a || !b) return null;
        return (
          <line className="network-drift" style={{ animationDelay: ((l.n % 11) * -0.55) + "s" }} key={l.a + "__" + l.b} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={C.slate} strokeOpacity={0.5} strokeWidth={0.8 + (l.n / maxL) * 2.8}>
            <title>{"「" + l.a + "」と「" + l.b + "」を併せて語った回答: " + l.n + "件"}</title>
          </line>
        );
      })}
      {placed.map(pn => {
        const r = rOf(pn);
        return (
          <g key={pn.name} className="visual-action" role="button" tabIndex={0}
            onClick={() => onPick && onPick(pn)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick && onPick(pn); } }}>
            <title>{pn.name + " / " + pn.n + "件 / 熱量 " + Math.round(pn.hn * 100) + " / 感情ポジ度 " + emoToPos(pn.emo)}</title>
            <circle className="tree-amoeba" style={{ animationDelay: ((pn.name.length % 7) * -0.45) + "s" }} cx={pn.x} cy={pn.y} r={r} fill={heatColor(pn.hn)} stroke={C.paper} strokeWidth={2.5} />
            <text x={pn.x} y={pn.y + r + 13} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.ink} fontFamily={FONT_BODY} style={{ pointerEvents: "none" }}>{pn.name}</text>
            <text x={pn.x} y={pn.y + r + 26} textAnchor="middle" fontSize={10} fill={C.sub} fontFamily={FONT_MONO} style={{ pointerEvents: "none" }}>{pn.n + "件"}</text>
          </g>
        );
      })}
      <g>
        <rect x={cx - 36} y={cy - 21} width={72} height={42} rx={7} fill={C.bengara} stroke={C.paper} strokeWidth={2.5} />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="central" fontSize={17} fontWeight="700" fill="#FFFFFF" fontFamily={FONT_DISP}>政治</text>
      </g>
    </svg>
  );
}

function TreeView({ agg, questions, goto, setOpFilter }) {
  const rows = useMemo(() => topicTree(agg, 48), [agg]);
  const chunkTotal = agg ? Object.values(agg.topics).reduce((s, t) => s + t.n, 0) : 0;

  const hasRadial = !!(agg && agg.rtree && Object.keys(agg.rtree).length);

  function pickTopic(c) { setOpFilter({ kw: c.name }); goto("opinions"); }
  function pickRadial(sel) {
    setOpFilter({ sup: sel.sup || "", cat: sel.cat || "", kw: sel.topic || "" });
    goto("opinions");
  }
  function pickTarget(tt, tn) { setOpFilter({ tt: tt, kw: tn === "(対象名なし)" ? "" : tn }); goto("opinions"); }

  if (!chunkTotal) {
    return (
      <div>
        <H2 eyebrow="OPINION TREE" sub="意見の広がりを、面積と色で一望します">意見ツリー</H2>
        <Card>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>
            まだ意見が抽出されていません。新しく回答するか、管理タブからデモデータを投入すると表示されます。旧版で簡易保存した回答がある場合は、管理タブの「旧簡易解析を補完」を実行してください。
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("survey")}>回答する</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <H2 eyebrow="OPINION NETWORK" sub="「政治」を中心に、意見トピック同士の相関を描きます">意見ネットワーク</H2>
      {!agg.net ? (
        <Card pad={14} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.sub }}>
            この図は旧バージョンのデータでは表示できません。管理タブの「集計を再構築」を実行すると生成されます。
          </div>
        </Card>
      ) : (
        <Card pad={12} style={{ marginBottom: 8 }}>
          <OpinionNetwork agg={agg} onPick={pn => { setOpFilter({ kw: pn.name }); goto("opinions"); }} />
        </Card>
      )}
      <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.9, marginBottom: 6 }}>
        円の大きさは意見の数。<b>色の濃さは熱量(ネガ度 × 切実度 × 意欲)</b>で、熱量が高いトピックほど濃く、中心「政治」の近くに置かれます。
        トピック間の線は、同じ回答の中で併せて語られた回数です。円をクリックすると、そのトピックの意見一覧へ移動します。
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 18, fontSize: 11, color: C.sub }}>
        <span>熱量: 低</span>
        <span style={{ display: "flex" }}>
          {[0, 0.25, 0.5, 0.75, 1].map(t => (
            <span key={t} style={{ width: 24, height: 10, background: heatColor(t), display: "inline-block" }} />
          ))}
        </span>
        <span>高(中心寄り)</span>
      </div>

      <H2 eyebrow="OPINION TREE" sub="どの立場の人が、何について、どう言っているか。中心から外へ枝分かれします">立場からの枝分かれ</H2>

      {hasRadial ? (
        <Card pad={12} style={{ marginBottom: 8 }}>
          <RadialTree agg={agg} questions={questions} onPick={pickRadial} />
        </Card>
      ) : (
        <Card style={{ marginBottom: 8, borderColor: C.karashi }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            <b>この集計は旧バージョンのものです。</b>放射ツリーには「意見がどの回答グループから出たか」の情報が必要ですが、旧データはそれを持っていません。
          </div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>
            管理タブの「集計を再構築」を一度実行すると、保存済みの回答から結び付きが生成され、放射ツリーが表示されます(データは失われません)。
          </div>
          <div style={{ fontSize: 11, color: C.sub }}>再構築は管理者用ページから実行できます。</div>
        </Card>
      )}
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, lineHeight: 1.9 }}>
        中心から外へ、<b>回答グループ(政権支持)→ 政策トピック → 意見の種類</b>と枝分かれします。
        扇の広さは意見の数、内側の色は支持の選択肢、中間の色は平均感情(<span style={{ color: C.bengara }}>弁柄=不満</span>/<span style={{ color: C.green }}>緑=好意</span>)です。
        どの扇をクリックしても、その条件で絞り込んだ意見一覧へ移動します。
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {CATS.map(c => (
          <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.sub }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: (CAT_STYLE[c] || {}).bg }} />{c}
          </span>
        ))}
        <span style={{ fontSize: 11, color: C.sub }}>(いちばん外側の環)</span>
      </div>

      <H2 eyebrow="TREEMAP" sub="面積で意見の量を比べます">トピックの面積比較</H2>
      <div style={{ marginBottom: 10 }}><EmoLegend /></div>
      <Card pad={10} style={{ marginBottom: 8 }}>
        <TreeMap rows={rows} w={TREE_W} h={TREE_H} onPick={pickTopic} />
      </Card>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>
        政策トピック上位{rows.length}件(全{chunkTotal}チャンク)。セルをクリックすると、そのトピックの意見一覧へ移動します。
      </div>

      <H2 eyebrow="TARGET TREE" sub="「〜に対して」の対象を、種別ごとに掘り下げます">対象別のツリー</H2>
      <TargetTree agg={agg} onPick={pickTarget} />
    </div>
  );
}
