import { readFileSync, writeFileSync } from "node:fs";

function read(path) { return readFileSync(path, "utf8"); }
function write(path, text) { writeFileSync(path, text, "utf8"); }
function replaceOnce(path, from, to) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one anchor, found ${count}: ${from.slice(0, 100)}`);
  write(path, source.replace(from, to));
}
function replaceRange(path, start, end, replacement) {
  const source = read(path);
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`${path}: missing start anchor: ${start}`);
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${path}: missing end anchor: ${end}`);
  write(path, source.slice(0, a) + replacement + source.slice(b));
}

// 1) Overview: restore the old draft-only resume bar and two-button layout.
replaceRange(
  "core/ui.jsx",
  '      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, margin: "18px 0" }}>',
  '      {chunkTotal > 0 ? (',
  String.raw`      {hasDraft ? (
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
        <Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述</Btn>
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

      {chunkTotal > 0 ? (`
);

// 2) Survey regains correction state used by the pre-follow-up UI.
replaceOnce(
  "core/ui.jsx",
  '  const [currentLoadNonce, setCurrentLoadNonce] = useState(0);\n  const busyRef = useRef(false);',
  '  const [currentLoadNonce, setCurrentLoadNonce] = useState(0);\n  const [editMode, setEditMode] = useState(null); // free | answers\n  const [editText, setEditText] = useState("");\n  const busyRef = useRef(false);'
);
replaceOnce(
  "core/ui.jsx",
  '    setCurrentLoadError("");\n    (async () => {',
  '    setCurrentLoadError("");\n    setEditMode(null);\n    (async () => {'
);

// 3) Reintroduce Survey correction helpers. Free-text correction still reanalyses; answer correction does not.
replaceOnce(
  "core/ui.jsx",
  '  async function resetAll() {',
  String.raw`  async function refreshCurrentResponse() {
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
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudPatchAnswers(id, revision, payload);
      const next = {
        ...currentResponse,
        answers: payload,
        updatedAt: Number(updated.updatedAt || Date.now())
      };
      await sSet("resp:" + id, next);
      setCurrentResponse(next); setEditMode(null);
      notify("アンケート回答を更新しました。AI解析結果は変更していません");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await handleRevisionConflict("別の更新が先に反映されました。最新の回答を読み直しました。");
      } else {
        setErr("アンケート回答の更新に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  async function resetAll() {`
);

// 4) Replace the submitted /survey dead-end with the old correction hub, adjusted for second free text.
replaceRange(
  "core/ui.jsx",
  '  /* 初回回答と提出後の修正は別機能。/survey は初回提出だけを担当する。 */',
  '  if (phase === "consent") {',
  String.raw`  /* 回答済みの場合は新規回答を作らず、同じ回答の続き・修正画面を開く。 */
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
          <H2 eyebrow="EDIT ANSWERS" sub={"回答ID " + id + " / revision " + revision}>アンケート回答を修正</H2>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            初回回答時に保存された設問スナップショットに対して回答だけを更新します。自由記述と現在のAI解析結果は変更しません。
          </div>
          {nonFreeQuestions.map((q, index) => (
            <Card key={q.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{index + 1}. {q.text}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(q.options || []).map(option => <Chip key={option} active={answers[q.id] === option} onClick={() => setAnswers({ ...answers, [q.id]: option })}>{option}</Chip>)}
              </div>
            </Card>
          ))}
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn disabled={!complete} onClick={submitCurrentAnswers}>変更を保存</Btn>
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
              ? <Btn small kind="ghost" onClick={() => goto("mine")}>2回目を確認・修正</Btn>
              : <Btn small onClick={() => goto("followup")}>二度目の自由記述へ</Btn>}
          </Card>
          <Card pad={13}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>自由記述を全文修正</div>
            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>現在の1回目自由記述全文を置き換え、置き換え後の全文を再解析します。</div>
            <Btn small kind="ghost" onClick={() => { setEditText(String(currentResponse.free || "")); setEditMode("free"); setErr(""); }}>全文を修正する</Btn>
          </Card>
          <Card pad={13}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>アンケート回答を修正</div>
            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>初回回答時に保存された選択式回答だけを変更します。AI解析は再実行しません。</div>
            <Btn small kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケートを修正する</Btn>
          </Card>
        </div>
        <div style={{ marginTop: 14 }}><Btn kind="ghost" onClick={() => goto("mine")}>自分の回答を確認</Btn></div>
      </div>
    );
  }

  if (phase === "consent") {`
);

// 5) Account page: keep free-text corrections, remove questionnaire correction entry.
replaceOnce(
  "core/ui.jsx",
  '              <Btn small kind="ghost" onClick={() => { setEditAnswers({ ...(r.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケートを修正</Btn>\n',
  ''
);

// 6) Backend answer update: replace answers only. Keep revision, analysis, chunks and runs unchanged.
replaceRange(
  "cloudflare/src/db.mjs",
  'export async function updateResponseAnswers(db, id, expectedRevision, answers) {',
  'export async function deleteResponse(db, id) {',
  String.raw`export async function updateResponseAnswers(db, id, expectedRevision, answers) {
  const now = Date.now();
  const current = await db.prepare("SELECT revision FROM responses WHERE id = ?").bind(id).first();
  if (!current) return { status: "not_found" };
  if (Number(current.revision ?? 1) !== Number(expectedRevision)) return { status: "stale" };

  const statements = [db.prepare("DELETE FROM answers WHERE response_id = ?").bind(id)];
  for (const answer of answers) {
    statements.push(db.prepare("INSERT INTO answers (response_id, qid, value) VALUES (?, ?, ?)").bind(id, answer.qid, answer.value));
  }
  statements.push(db.prepare("UPDATE responses SET updated_at = ? WHERE id = ? AND revision = ?").bind(now, id, expectedRevision));
  const results = await db.batch(statements);
  const final = results?.[results.length - 1];
  if (Number(final?.meta?.changes ?? 0) !== 1) return { status: "stale" };
  return { status: "updated", revision: Number(expectedRevision), updatedAt: now };
}

export async function deleteResponse(db, id) {`
);

// 7) API: no dispatchUpdatedAnalysis for questionnaire-only edits.
replaceRange(
  "cloudflare/src/index.mjs",
  '  const answersId = routeAnswersId(url.pathname);',
  '  const requeueId = routeRequeueId(url.pathname);',
  String.raw`  const answersId = routeAnswersId(url.pathname);
  if (answersId && request.method === "PATCH") {
    await authorizeResponseAccess(env.DB, request, answersId);
    const input = normalizeAnswersUpdate(await readJson(request));
    const snapshot = await getResponseQuestionSnapshot(env.DB, answersId);
    if (!snapshot.length || input.answers.length !== snapshot.length ||
        !validateAnswersAgainstQuestions(input.answers, snapshot, false)) {
      throw new RequestError(400, "INVALID_ANSWER", "answers do not match the saved question snapshot");
    }
    const outcome = await updateResponseAnswers(env.DB, answersId, input.expectedRevision, input.answers);
    if (outcome.status === "not_found") throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (outcome.status !== "updated") {
      throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");
    }
    return json({
      id: answersId,
      revision: outcome.revision,
      analysisStatus: "unchanged",
      reanalysisQueued: false,
      updatedAt: outcome.updatedAt
    });
  }

  const requeueId = routeRequeueId(url.pathname);`
);

// 8) Tests: answers PATCH preserves current analysis state and revision.
const testPath = "cloudflare/tests/response-phase4-backend.test.mjs";
replaceRange(
  testPath,
  'test("answers PATCH validates saved question snapshot and replaces answers at one new revision", async () => {',
  'test("healthy pending current revision is not manually requeued", async () => {',
  String.raw`test("answers PATCH updates questionnaire data without changing revision or analysis", async () => {
  const database = createDatabase(); const queued = []; const waits = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const owner = await register(env, "回答編集者"); const cr = await create(env, owner.token); const created = await cr.json();
  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);
  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'保持','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());
  const before = database.prepare("SELECT revision, analysis_status AS status, analysis_json AS json FROM responses WHERE id=?").get(created.id);
  const good = await worker.fetch(new Request(`http://local/api/responses/${created.id}/answers`, {
    method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" } })
  }), env, { waitUntil: p => waits.push(p) });
  assert.equal(good.status, 200); const body = await good.json();
  assert.equal(body.revision, 1); assert.equal(body.analysisStatus, "unchanged"); assert.equal(body.reanalysisQueued, false);
  await Promise.all(waits);
  const rows = database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id);
  assert.deepEqual(rows.map(x => [x.qid,x.value]), [["q_econ","5"],["q_priority","経済・雇用"],["q_support","支持しない"]]);
  const after = database.prepare("SELECT revision, analysis_status AS status, analysis_json AS json FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([after.revision, after.status, after.json], [before.revision, before.status, before.json]);
  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 1);
  assert.deepEqual(queued, []);
  const bad = await worker.fetch(new Request(`http://local/api/responses/${created.id}/answers`, {
    method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "存在しない選択肢", q_priority: "経済・雇用", q_econ: "5" } })
  }), env);
  assert.equal(bad.status, 400);
  database.close();
});

test("healthy pending current revision is not manually requeued", async () => {`
);

// 9) UI contract reflects the deliberately asymmetric survey/mypage responsibilities.
replaceOnce(
  "tests/follow-up-ui-contract.test.mjs",
  'test("generic append UI is removed", () => {\n  assert.ok(!ui.includes("自由記述を追記"));\n  assert.ok(!ui.includes("追記する</Btn>"));\n});',
  'test("generic append UI is removed", () => {\n  assert.ok(!ui.includes("自由記述を追記"));\n  assert.ok(!ui.includes("追記する</Btn>"));\n});\n\ntest("survey owns questionnaire correction while account response keeps free-text correction", () => {\n  assert.ok(ui.includes("AI解析は再実行しません"));\n  assert.ok(ui.includes("アンケートを修正する"));\n  assert.ok(ui.includes("二度目の自由記述"));\n  assert.ok(ui.includes("書きかけの回答があります。"));\n});'
);

console.log("survey answer recovery patch applied");
