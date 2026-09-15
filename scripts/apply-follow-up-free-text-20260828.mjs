import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function read(path) { return readFileSync(path, "utf8"); }
function write(path, value) { writeFileSync(path, value, "utf8"); }
function replaceOnce(path, from, to) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one anchor, found ${count}: ${from.slice(0, 80)}`);
  write(path, source.replace(from, to));
}
function replaceRange(path, start, end, replacement) {
  const source = read(path);
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`${path}: start anchor not found: ${start}`);
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${path}: end anchor not found: ${end}`);
  if (source.indexOf(start, a + 1) >= 0) throw new Error(`${path}: start anchor is not unique: ${start}`);
  write(path, source.slice(0, a) + replacement + source.slice(b));
}
function insertBefore(path, marker, addition) {
  replaceOnce(path, marker, addition + marker);
}

// 1. Additive D1 migration. Existing first free text remains untouched.
write("cloudflare/migrations/0008_response_follow_up_text.sql", String.raw`ALTER TABLE responses
ADD COLUMN follow_up_text TEXT NULL
CHECK (follow_up_text IS NULL OR length(follow_up_text) <= 1500);
`);

// 2. Request validation: second free text is its own resource, never an append operation.
insertBefore("cloudflare/src/validation.mjs", "export function normalizeAnswersUpdate(input) {", String.raw`function normalizeFollowUpTextBody(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "followUpText"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  return Object.freeze({
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
    followUpText: cleanText(body.followUpText, 1500, "followUpText", true)
  });
}

export function normalizeFollowUpTextCreate(input) {
  return normalizeFollowUpTextBody(input);
}

export function normalizeFollowUpTextUpdate(input) {
  return normalizeFollowUpTextBody(input);
}

`);

// 3. DB: load both texts for analysis, and create/update follow-up with the same revision guard.
replaceOnce(
  "cloudflare/src/db.mjs",
  "    SELECT id, free_text AS freeText, analysis_status AS analysisStatus,\n           age, gender, region, occupation, party, revision",
  "    SELECT id, free_text AS freeText, follow_up_text AS followUpText, analysis_status AS analysisStatus,\n           age, gender, region, occupation, party, revision"
);

insertBefore("cloudflare/src/db.mjs", "export async function updateResponseFreeText(db, id, expectedRevision, freeText) {", String.raw`async function mutateResponseFollowUpText(db, id, expectedRevision, followUpText, mode) {
  const now = Date.now();
  const createOnly = mode === "create";
  const condition = createOnly ? "follow_up_text IS NULL" : "follow_up_text IS NOT NULL";
  const guard = "EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ? AND " + condition + ")";
  const statements = [
    db.prepare(
      "DELETE FROM opinion_chunks WHERE response_id = ? AND " + guard
    ).bind(id, id, expectedRevision),
    db.prepare(
      "UPDATE analysis_runs SET status = 'failed', completed_at = ?, error_code = 'SUPERSEDED_REVISION', lease_until = NULL " +
      "WHERE response_id = ? AND response_revision = ? AND status = 'running' AND " + guard
    ).bind(now, id, expectedRevision, id, expectedRevision),
    db.prepare(
      "UPDATE responses SET follow_up_text = ?, updated_at = ?, revision = revision + 1, " +
      "analysis_status = 'pending', analysis_json = NULL WHERE id = ? AND revision = ? AND " + condition
    ).bind(followUpText, now, id, expectedRevision)
  ];
  const results = await db.batch(statements);
  if (Number(results?.[2]?.meta?.changes ?? 0) === 1) {
    return { status: "updated", revision: expectedRevision + 1, updatedAt: now };
  }
  const current = await db.prepare(
    "SELECT revision, follow_up_text AS followUpText FROM responses WHERE id = ?"
  ).bind(id).first();
  if (!current) return { status: "not_found" };
  if (Number(current.revision ?? 1) !== Number(expectedRevision)) return { status: "stale" };
  if (createOnly && current.followUpText != null) return { status: "exists" };
  if (!createOnly && current.followUpText == null) return { status: "missing" };
  return { status: "conflict" };
}

export function createResponseFollowUpText(db, id, expectedRevision, followUpText) {
  return mutateResponseFollowUpText(db, id, expectedRevision, followUpText, "create");
}

export function updateResponseFollowUpText(db, id, expectedRevision, followUpText) {
  return mutateResponseFollowUpText(db, id, expectedRevision, followUpText, "update");
}

`);

// 4. Account payload exposes the two texts separately. seq remains legacy response-count semantics, not revision.
replaceOnce(
  "cloudflare/src/auth.mjs",
  "           r.free_text AS freeText, r.analysis_status AS analysisStatus,",
  "           r.free_text AS freeText, r.follow_up_text AS followUpText, r.analysis_status AS analysisStatus,"
);
replaceOnce(
  "cloudflare/src/auth.mjs",
  "      seq: Number(row.revision ?? 1),\n      revision: Number(row.revision ?? 1),",
  "      seq: 1,\n      revision: Number(row.revision ?? 1),"
);
replaceOnce(
  "cloudflare/src/auth.mjs",
  "      free: String(row.freeText ?? \"\"),\n      freeQids: [\"q_free\"],",
  "      free: String(row.freeText ?? \"\"),\n      followUpText: row.followUpText == null ? null : String(row.followUpText),\n      followUpSubmitted: row.followUpText != null,\n      freeQids: [\"q_free\"],"
);

// 5. Analysis input combines the two fields only at analysis time; DB originals stay separate.
replaceRange(
  "cloudflare/src/analysis.mjs",
  "function safeFreeText(value) {",
  "function countHits(text, words) {",
  String.raw`function safeFreeText(value, max = 1500) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[<>]{3,}/gu, match => match.slice(0, 2))
    .slice(0, max);
}

export function composeAnalysisText(record) {
  const first = safeFreeText(record?.freeText, 1500).trim();
  const second = safeFreeText(record?.followUpText, 1500).trim();
  return [
    first ? "[初回自由記述]\n" + first : "",
    second ? "[第二自由記述]\n" + second : ""
  ].filter(Boolean).join("\n\n");
}

function countHits(text, words) {`
);
replaceOnce("cloudflare/src/analysis.mjs", "  const source = safeFreeText(text).trim();", "  const source = safeFreeText(text, 3200).trim();");
replaceOnce("cloudflare/src/analysis.mjs", "function buildPrompt(record) {", "function buildPrompt(record, suppliedFreeText) {");
replaceOnce("cloudflare/src/analysis.mjs", "  const freeText = safeFreeText(record.freeText);\n  return [", "  const freeText = suppliedFreeText == null ? composeAnalysisText(record) : String(suppliedFreeText);\n  return [");
replaceOnce("cloudflare/src/analysis.mjs", "          { role: \"user\", content: buildPrompt(record) }", "          { role: \"user\", content: buildPrompt(record, freeText) }");
replaceOnce("cloudflare/src/analysis.mjs", "  const freeText = safeFreeText(record.freeText);\n  const finish = async", "  const freeText = composeAnalysisText(record);\n  const finish = async");

// 6. API routes for one-time creation and later correction of the second free text.
replaceOnce(
  "cloudflare/src/index.mjs",
  "  deleteResponse,\n  getBasicStats,",
  "  createResponseFollowUpText,\n  deleteResponse,\n  getBasicStats,"
);
replaceOnce(
  "cloudflare/src/index.mjs",
  "  updateResponseAnswers,\n  updateResponseFreeText",
  "  updateResponseAnswers,\n  updateResponseFollowUpText,\n  updateResponseFreeText"
);
replaceOnce(
  "cloudflare/src/index.mjs",
  "  normalizeAnswersUpdate,\n  normalizeExpectedRevision,\n  normalizeFreeTextUpdate,",
  "  normalizeAnswersUpdate,\n  normalizeExpectedRevision,\n  normalizeFollowUpTextCreate,\n  normalizeFollowUpTextUpdate,\n  normalizeFreeTextUpdate,"
);
insertBefore("cloudflare/src/index.mjs", "function routeAnswersId(pathname) {", String.raw`function routeFollowUpId(pathname) {
  const match = pathname.match(/^\/api\/responses\/(r_[A-Za-z0-9_-]{12,62})\/follow-up$/u);
  return match ? match[1] : null;
}

`);
insertBefore("cloudflare/src/index.mjs", "  const answersId = routeAnswersId(url.pathname);", String.raw`  const followUpId = routeFollowUpId(url.pathname);
  if (followUpId && (request.method === "POST" || request.method === "PATCH")) {
    await authorizeResponseAccess(env.DB, request, followUpId);
    const input = request.method === "POST"
      ? normalizeFollowUpTextCreate(await readJson(request))
      : normalizeFollowUpTextUpdate(await readJson(request));
    const outcome = request.method === "POST"
      ? await createResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)
      : await updateResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText);
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
      updatedAt: outcome.updatedAt
    }, request.method === "POST" ? 201 : 200);
  }

`);

// 7. UI API adapter: initial response and second response are distinct operations.
replaceRange(
  "core/ui.jsx",
  "async function cloudCreateInitialResponse(resp, token) {",
  "async function cloudPatchFreeText(id, expectedRevision, freeText) {",
  String.raw`async function cloudCreateInitialResponse(resp, token) {
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

async function cloudPatchFreeText(id, expectedRevision, freeText) {`
);

replaceOnce(
  "core/ui.jsx",
  "    response.remoteId = id;\n    response.remoteRevision = rawRevision;\n    response.revision = response.remoteRevision;",
  "    response.remoteId = id;\n    response.seq = 1;\n    response.remoteRevision = rawRevision;\n    response.revision = response.remoteRevision;\n    response.followUpText = raw && raw.followUpText == null ? \"\" : String(raw && raw.followUpText || \"\");\n    response.followUpSubmitted = !!(raw && raw.followUpSubmitted === true);"
);

replaceOnce("core/ui.jsx", "  survey: \"/survey\",\n  complete: \"/survey/complete\",", "  survey: \"/survey\",\n  followup: \"/survey/follow-up\",\n  complete: \"/survey/complete\",");

// Overview keeps fixed entry points; status changes labels, not the information architecture.
replaceRange(
  "core/ui.jsx",
  "      {hasDraft ? (\n        <Card pad={13} style={{ marginBottom: 10, borderColor: C.karashi }}>",
  "      {chunkTotal > 0 ? (",
  String.raw`      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, margin: "18px 0" }}>
        <Card pad={13}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>アンケート・1回目の自由記述</div>
          <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>
            属性・選択式アンケートと、最初の自由記述を提出します。{hasDraft ? " 書きかけは自動保存されています。" : ""}
          </div>
          <Btn small onClick={() => goto("survey")}>{hasDraft ? "回答の続きから" : "回答をはじめる"}</Btn>
        </Card>
        <Card pad={13}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>二度目の自由記述</div>
          <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>
            初回提出後に一度だけ、新しい自由記述を追加できます。初回本文とは別に保存します。
          </div>
          <Btn small kind="ghost" onClick={() => goto("followup")}>二度目の自由記述へ</Btn>
        </Card>
        <Card pad={13}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>回答内容の確認・修正</div>
          <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>
            提出済みのアンケート、1回目、2回目の内容を確認し、必要な箇所だけ修正します。
          </div>
          <Btn small kind="ghost" onClick={() => goto("mine")}>確認・修正する</Btn>
        </Card>
      </div>
      <div style={{ marginBottom: 18 }}>
        <Btn kind="ghost" onClick={() => goto("dash")}>統計ダッシュボードを見る</Btn>
      </div>

      {myId ? <div style={{ marginTop: -8, marginBottom: 12, fontSize: 12, color: C.sub }}>この端末から回答済みです。</div> : null}

      {chunkTotal > 0 ? (`
);

// First survey no longer contains post-submission correction/append controls.
replaceRange(
  "core/ui.jsx",
  "  /* 既存回答がある場合は初回アンケートを再表示せず、同じcurrent responseを編集する。 */",
  "  if (phase === \"consent\") {",
  String.raw`  /* 初回回答と提出後の修正は別機能。/survey は初回提出だけを担当する。 */
  if (currentResponse && phase === "consent") {
    const id = currentResponse.remoteId || currentResponse.id;
    return (
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <H2 eyebrow="FIRST RESPONSE" sub={"回答ID " + id}>最初の回答は提出済みです</H2>
        <Card>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.9, marginBottom: 12 }}>
            /survey はアンケートと1回目の自由記述を新規提出する画面です。提出済み内容の変更は「回答内容の確認・修正」、二度目の新規記述は専用画面から行います。
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => goto("followup")}>二度目の自由記述</Btn>
            <Btn kind="ghost" onClick={() => goto("mine")}>回答内容を確認・修正</Btn>
            <Btn kind="ghost" onClick={() => goto("home")}>概要へ戻る</Btn>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "consent") {`
);

// Remove dead edit helpers from Survey; MyResponse owns correction now.
replaceRange(
  "core/ui.jsx",
  "  async function refreshCurrentResponse() {",
  "  async function resetAll() {",
  "  async function resetAll() {"
);
replaceOnce("core/ui.jsx", "  const [editMode, setEditMode] = useState(null); // append | free | answers\n  const [editText, setEditText] = useState(\"\");\n", "");
replaceOnce("core/ui.jsx", "    setEditMode(null);\n", "");

// Initial free-text UI follows the 1500-character backend contract.
replaceOnce("core/ui.jsx", "              rows={7} maxLength={1200}", "              rows={7} maxLength={1500}");
replaceOnce("core/ui.jsx", "<span style={{ fontFamily: FONT_MONO }}>{String(val || \"\").length}/1200</span>", "<span style={{ fontFamily: FONT_MONO }}>{String(val || \"\").length}/1500</span>");

// Dedicated second free-text page, independent from /survey and from correction UI.
insertBefore("core/ui.jsx", "function Survey({ questions, policy, notify, onFinished, goto, onDraftChange, session, onAuthed }) {", String.raw`function FollowUpSurvey({ goto, session, onAuthed, notify }) {
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
    } catch (error) {
      setErr("現在の回答を確認できませんでした。通信状態を確認して、もう一度試してください。");
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [session && session.name, session && session.token]);

  async function submitFollowUp() {
    if (busyRef.current || !current) return;
    const body = sanitizeFreeText(text, 1500).trim();
    if (!body) { setErr("二度目の自由記述を入力してください。"); return; }
    const id = current.remoteId || current.id;
    const revision = Number(current.remoteRevision || current.revision || 1);
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudCreateFollowUp(id, revision, body);
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
      notify("二度目の自由記述を保存しました。再解析を開始します");
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
  if (done || current.followUpSubmitted) {
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
      <H2 eyebrow="SECOND FREE TEXT" sub="初回本文とは別に保存し、回答全体を再解析します">二度目の自由記述</H2>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.sub }}>1回目の自由記述</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 180, overflowY: "auto", marginTop: 5 }}>{current.free || "（記載なし）"}</div>
      </Card>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={9} maxLength={1500}
        placeholder="二度目に伝えたい意見・提言・不満を自由にお書きください"
        style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, color: C.sub, marginTop: 4 }}>
        <span>この新規提出は一度だけです。提出後の変更は修正機能から行えます。</span>
        <span style={{ fontFamily: FONT_MONO }}>{text.length}/1500</span>
      </div>
      {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <Btn disabled={!text.trim()} onClick={submitFollowUp}>二度目の自由記述を送信</Btn>
        <Btn kind="ghost" onClick={() => goto("home")}>概要へ戻る</Btn>
      </div>
    </div>
  );
}

`);

// Render the dedicated route.
replaceOnce(
  "core/ui.jsx",
  "        ) : view === \"survey\" ? (\n          <Survey questions={questions}",
  "        ) : view === \"followup\" ? (\n          <FollowUpSurvey goto={goView} session={session} onAuthed={onAuthed} notify={notify} />\n        ) : view === \"survey\" ? (\n          <Survey questions={questions}"
);

// MyResponse correction state and handlers.
replaceOnce(
  "core/ui.jsx",
  "  const [confirming, setConfirming] = useState(false);\n\n  const [noSelf, setNoSelf]",
  "  const [confirming, setConfirming] = useState(false);\n  const [editMode, setEditMode] = useState(null);\n  const [editText, setEditText] = useState(\"\");\n  const [editAnswers, setEditAnswers] = useState({});\n  const editBusyRef = useRef(false);\n\n  const [noSelf, setNoSelf]"
);
insertBefore("core/ui.jsx", "  if (stage === \"working\") {", String.raw`  async function refreshEditedResponse() {
    if (!found || !session || !session.token) return null;
    const id = found.r.remoteId || found.id;
    const fresh = await cloudLoadOwnResponse(id, session.token);
    if (fresh) {
      setFound({ id: found.id, r: fresh, r2: null });
      await sSet("resp:" + id, fresh);
    }
    return fresh;
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

`);

// MyResponse shows the second field from the same response row and one combined current analysis.
replaceOnce(
  "core/ui.jsx",
  "    const pubChunks = []\n      .concat((an && an.chunks) || [])\n      .concat((found.r2 && found.r2.analysis && found.r2.analysis.chunks) || []);",
  "    const pubChunks = [].concat((an && an.chunks) || []);"
);
replaceRange(
  "core/ui.jsx",
  "          {r.free ? (\n            <div style={{ padding: \"7px 0\", borderTop: \"1px solid \" + C.rule }}>",
  "        {an ? (",
  String.raw`          {r.free ? (
            <div style={{ padding: "7px 0", borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>自由記述(1回目・原文)</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.free}</div>
            </div>
          ) : null}
          {r.followUpSubmitted ? (
            <div style={{ padding: "7px 0", borderTop: "1px solid " + C.rule }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>自由記述(2回目・原文)</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.followUpText || "（記載なし）"}</div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.sub, marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.rule }}>二度目の自由記述はまだ提出していません。</div>
          )}
        </Card>

        {session && r.remoteId ? (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>回答内容を修正</div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>新規提出とは別の操作です。修正した項目だけを書き換え、回答全体を新しいrevisionとして再解析します。</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn small kind="ghost" onClick={() => { setEditText(String(r.free || "")); setEditMode("free"); setErr(""); }}>1回目を修正</Btn>
              {r.followUpSubmitted
                ? <Btn small kind="ghost" onClick={() => { setEditText(String(r.followUpText || "")); setEditMode("followup"); setErr(""); }}>2回目を修正</Btn>
                : <Btn small onClick={() => goto("followup")}>二度目の自由記述を書く</Btn>}
              <Btn small kind="ghost" onClick={() => { setEditAnswers({ ...(r.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケートを修正</Btn>
            </div>
          </Card>
        ) : null}

        {an ? (`
);

// Wording: no generic append operation in the user-facing access copy.
replaceOnce("core/ui.jsx", "登録・ログインすると回答の確認、追記、撤回ができます。閲覧だけなら登録は必要ありません。", "登録・ログインすると回答の確認、二度目の自由記述、修正、撤回ができます。閲覧だけなら登録は必要ありません。");

// 8. Contract tests: routing + semantic separation.
replaceOnce("tests/page-routing.test.mjs", "    'survey: \"/survey\"',\n    'complete: \"/survey/complete\"',", "    'survey: \"/survey\"',\n    'followup: \"/survey/follow-up\"',\n    'complete: \"/survey/complete\"',");
replaceOnce(
  "tests/phase5-ui-contract.test.mjs",
  "test(\"Phase 5 response update operations are semantically separated\", () => { assert.ok(ui.includes(\"現在の全文を残し、新しい段落を末尾へ追加\")); assert.ok(ui.includes(\"現在の自由記述全文を置き換え\")); assert.ok(ui.includes(\"初回回答時に保存された設問スナップショット\")); assert.ok(ui.includes(\"currentResponse.cloudAnalysisRetryable === true\")); });",
  "test(\"Phase 5 response update operations are semantically separated\", () => { assert.ok(ui.includes('followup: \"/survey/follow-up\"')); assert.ok(ui.includes(\"二度目の自由記述\")); assert.ok(ui.includes(\"回答内容を確認・修正\")); assert.ok(!ui.includes(\"現在の全文を残し、新しい段落を末尾へ追加\")); });"
);

write("tests/follow-up-ui-contract.test.mjs", String.raw`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");
test("second free text is a dedicated route separate from first survey and correction", () => {
  assert.ok(ui.includes('followup: "/survey/follow-up"'));
  assert.ok(ui.includes("function FollowUpSurvey("));
  assert.ok(ui.includes("二度目の自由記述を送信"));
  assert.ok(ui.includes("回答内容を修正"));
});
test("generic append UI is removed", () => {
  assert.ok(!ui.includes("自由記述を追記"));
  assert.ok(!ui.includes("追記する</Btn>"));
});
`);

// 9. Backend tests and all existing sqlite test harnesses include the additive migration.
const testDir = "cloudflare/tests";
for (const name of readdirSync(testDir)) {
  if (!name.endsWith(".test.mjs")) continue;
  const path = join(testDir, name);
  const source = read(path);
  if (source.includes('"0007_response_updated_at.sql"') && !source.includes('"0008_response_follow_up_text.sql"')) {
    write(path, source.replaceAll('"0007_response_updated_at.sql"', '"0007_response_updated_at.sql", "0008_response_follow_up_text.sql"'));
  }
}

write("cloudflare/tests/follow-up-free-text.test.mjs", String.raw`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.mjs";
import { composeAnalysisText } from "../src/analysis.mjs";

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
function db() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql", "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql"]) {
    database.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  return database;
}
function submission() {
  return {
    appVersion: "0.16.0", consent: { accepted: true, version: "1.4", at: Date.now() },
    demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
    answers: { q_support: "わからない", q_priority: "子育て・教育", q_econ: "3" }, freeText: "初回本文"
  };
}
async function register(env, name) {
  const response = await worker.fetch(new Request("http://local/api/accounts/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password: "correct-horse-1" }) }), env);
  assert.equal(response.status, 201); return response.json();
}
async function create(env, token) {
  const response = await worker.fetch(new Request("http://local/api/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(submission()) }), env);
  assert.equal(response.status, 201); return response.json();
}

test("analysis input keeps first and second free text distinguishable", () => {
  assert.equal(composeAnalysisText({ freeText: "一回目", followUpText: "二回目" }), "[初回自由記述]\n一回目\n\n[第二自由記述]\n二回目");
});

test("second free text can be created once and increments the same response revision", async () => {
  const database = db(); const queued = []; const waits = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async item => queued.push(item) } };
  const owner = await register(env, "二回目作成者"); const created = await create(env, owner.token);
  const first = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env, { waitUntil: p => waits.push(p) });
  assert.equal(first.status, 201); assert.equal((await first.json()).revision, 2); await Promise.all(waits);
  const row = database.prepare("SELECT free_text AS firstText, follow_up_text AS secondText, revision FROM responses WHERE id=?").get(created.id);
  assert.deepEqual(row, { firstText: "初回本文", secondText: "第二本文", revision: 2 });
  assert.deepEqual(queued.at(-1), { type: "analyze-response", responseId: created.id, revision: 2 });
  const second = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2, followUpText: "三回目にはならない" }) }), env);
  assert.equal(second.status, 409); assert.equal((await second.json()).error, "FOLLOW_UP_ALREADY_EXISTS");
  assert.equal(database.prepare("SELECT follow_up_text AS t, revision FROM responses WHERE id=?").get(created.id).t, "第二本文");
  database.close();
});

test("second free text correction uses PATCH and does not create another submission slot", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目修正者"); const created = await create(env, owner.token);
  let response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env);
  assert.equal(response.status, 201);
  response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2, followUpText: "第二本文の修正版" }) }), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).revision, 3);
  const row = database.prepare("SELECT free_text AS firstText, follow_up_text AS secondText, revision FROM responses WHERE id=?").get(created.id);
  assert.deepEqual(row, { firstText: "初回本文", secondText: "第二本文の修正版", revision: 3 });
  database.close();
});

test("stale follow-up create does not invalidate current chunks or running analysis", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目競合者"); const created = await create(env, owner.token);
  database.prepare("UPDATE responses SET revision=2 WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'保持','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'t','t','v','running',?,2,?)").run(created.id, Date.now(), Date.now() + 300000);
  const response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "競合本文" }) }), env);
  assert.equal(response.status, 409); assert.equal((await response.json()).error, "REVISION_CONFLICT");
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 1);
  assert.equal(database.prepare("SELECT status FROM analysis_runs WHERE response_id=? AND response_revision=2").get(created.id).status, "running");
  assert.equal(database.prepare("SELECT follow_up_text AS t FROM responses WHERE id=?").get(created.id).t, null);
  database.close();
});

test("account response keeps first and second free texts as separate fields", async () => {
  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };
  const owner = await register(env, "二回目取得者"); const created = await create(env, owner.token);
  await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "第二本文" }) }), env);
  const response = await worker.fetch(new Request("http://local/api/accounts/me/responses", { headers: { authorization: "Bearer " + owner.token } }), env);
  assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.responses[0].free, "初回本文");
  assert.equal(payload.responses[0].followUpText, "第二本文");
  assert.equal(payload.responses[0].followUpSubmitted, true);
  assert.equal(payload.responses[0].seq, 1);
  assert.equal(payload.responses[0].revision, 2);
  database.close();
});
`);

console.log("follow-up free-text implementation applied");
