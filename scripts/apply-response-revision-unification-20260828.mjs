import { readFileSync, writeFileSync } from "node:fs";

function read(path) { return readFileSync(path, "utf8"); }
function write(path, value) { writeFileSync(path, value, "utf8"); }
function replaceOnce(path, from, to) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(path + ": expected one match, found " + count + " for " + from.slice(0, 100));
  write(path, source.replace(from, to));
}
function insertBefore(path, marker, value) {
  const source = read(path);
  if (source.includes(value.trim())) return;
  const count = source.split(marker).length - 1;
  if (count !== 1) throw new Error(path + ": expected one marker, found " + count);
  write(path, source.replace(marker, value + marker));
}

// 1. Validation: one payload owns the initial questionnaire + first free text.
insertBefore(
  "cloudflare/src/validation.mjs",
  "export function normalizeAnswersUpdate(input) {",
  `export function normalizeInitialResponseUpdate(input) {\n  const body = requireObject(input, "body");\n  const allowed = new Set(["expectedRevision", "answers", "freeText"]);\n  for (const key of Object.keys(body)) {\n    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);\n  }\n  const answerInput = requireObject(body.answers, "answers");\n  const answers = [];\n  for (const [rawQid, rawValue] of Object.entries(answerInput)) {\n    const qid = cleanText(rawQid, 64, "answer qid", true);\n    const value = cleanText(rawValue, 60, "answers." + qid, true);\n    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(qid)) throw new RequestError(400, "INVALID_FIELD", "answers." + qid + " has an invalid qid");\n    answers.push(Object.freeze({ qid, value }));\n  }\n  if (answers.length > 100) throw new RequestError(400, "INVALID_FIELD", "too many answers");\n  return Object.freeze({\n    expectedRevision: normalizeExpectedRevision(body.expectedRevision),\n    answers: Object.freeze(answers),\n    freeText: cleanText(body.freeText, 1500, "freeText")\n  });\n}\n\n`
);

// 2. DB: questionnaire + first free text change atomically as one new response revision.
insertBefore(
  "cloudflare/src/db.mjs",
  "export async function updateResponseAnswers(db, id, expectedRevision, answers) {",
  `export async function updateInitialResponse(db, id, expectedRevision, answers, freeText) {\n  const revision = Number(expectedRevision);\n  const now = Date.now();\n  const current = await db.prepare("SELECT revision FROM responses WHERE id = ?").bind(id).first();\n  if (!current) return { status: "not_found" };\n  if (Number(current.revision ?? 1) !== revision) return { status: "stale" };\n  const guard = "EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ?)";\n  const statements = [\n    db.prepare("DELETE FROM opinion_chunks WHERE response_id = ? AND " + guard).bind(id, id, revision),\n    db.prepare(\n      "UPDATE analysis_runs SET status = 'failed', completed_at = ?, error_code = 'SUPERSEDED_REVISION', lease_until = NULL " +\n      "WHERE response_id = ? AND response_revision = ? AND status = 'running' AND " + guard\n    ).bind(now, id, revision, id, revision),\n    db.prepare("DELETE FROM answers WHERE response_id = ? AND " + guard).bind(id, id, revision)\n  ];\n  for (const answer of answers) {\n    statements.push(db.prepare(\n      "INSERT INTO answers (response_id, qid, value) SELECT ?, ?, ? WHERE " + guard\n    ).bind(id, answer.qid, answer.value, id, revision));\n  }\n  const responseIndex = statements.length;\n  statements.push(db.prepare(\n    "UPDATE responses SET free_text = ?, updated_at = ?, revision = revision + 1, analysis_status = 'pending', analysis_json = NULL " +\n    "WHERE id = ? AND revision = ?"\n  ).bind(freeText, now, id, revision));\n  const results = await db.batch(statements);\n  if (Number(results?.[responseIndex]?.meta?.changes ?? 0) !== 1) return { status: "stale" };\n  return { status: "updated", revision: revision + 1, updatedAt: now };\n}\n\n`
);

// 3. Worker route /initial; old answers-only mutation is deliberately retired.
replaceOnce(
  "cloudflare/src/index.mjs",
  "  updateResponseAnswers,\n  updateResponseFollowUpText,",
  "  updateInitialResponse,\n  updateResponseAnswers,\n  updateResponseFollowUpText,"
);
replaceOnce(
  "cloudflare/src/index.mjs",
  "  normalizeFollowUpTextUpdate,\n  normalizeFreeTextUpdate,",
  "  normalizeFollowUpTextUpdate,\n  normalizeFreeTextUpdate,\n  normalizeInitialResponseUpdate,"
);
insertBefore(
  "cloudflare/src/index.mjs",
  "function routeAnswersId(pathname) {",
  `function routeInitialId(pathname) {\n  const match = pathname.match(/^\\/api\\/responses\\/(r_[A-Za-z0-9_-]{12,62})\\/initial$/u);\n  return match ? match[1] : null;\n}\n\n`
);
insertBefore(
  "cloudflare/src/index.mjs",
  "  const answersId = routeAnswersId(url.pathname);",
  `  const initialId = routeInitialId(url.pathname);\n  if (initialId && request.method === "PATCH") {\n    await authorizeResponseAccess(env.DB, request, initialId);\n    const input = normalizeInitialResponseUpdate(await readJson(request));\n    const snapshot = await getResponseQuestionSnapshot(env.DB, initialId);\n    if (!snapshot.length || input.answers.length !== snapshot.length || !validateAnswersAgainstQuestions(input.answers, snapshot, false)) {\n      throw new RequestError(400, "INVALID_ANSWER", "answers do not match the saved question snapshot");\n    }\n    const outcome = await updateInitialResponse(env.DB, initialId, input.expectedRevision, input.answers, input.freeText);\n    if (outcome.status === "not_found") throw new RequestError(404, "NOT_FOUND", "response was not found");\n    if (outcome.status !== "updated") throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before editing");\n    dispatchUpdatedAnalysis(env, ctx, initialId, outcome.revision);\n    return json({ id: initialId, revision: outcome.revision, analysisStatus: "pending", updatedAt: outcome.updatedAt });\n  }\n\n`
);
replaceOnce(
  "cloudflare/src/index.mjs",
  `  if (answersId && request.method === "PATCH") {\n    await authorizeResponseAccess(env.DB, request, answersId);`,
  `  if (answersId && request.method === "PATCH") {\n    await authorizeResponseAccess(env.DB, request, answersId);\n    throw new RequestError(410, "ANSWERS_ONLY_UPDATE_REMOVED", "questionnaire-only correction was removed; update the initial response as one revision");\n    /* legacy handler retained below only as unreachable reference during migration */`
);

// 4. UI transport helper.
insertBefore(
  "core/ui.jsx",
  "async function cloudPatchAnswers(id, expectedRevision, answers) {",
  `async function cloudPatchInitial(id, expectedRevision, answers, freeText) {\n  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/initial", {\n    method: "PATCH",\n    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },\n    body: JSON.stringify({ expectedRevision: expectedRevision, answers: answers, freeText: freeText })\n  });\n}\n\n`
);

// Survey: rename answers correction to initial response correction and include first free text in the same save.
replaceOnce(
  "core/ui.jsx",
  `>アンケート回答を修正</H2>\n          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>\n            初回回答時に保存された設問スナップショットに対して回答だけを更新します。自由記述と現在のAI解析結果は変更しません。\n          </div>`,
  `>初回回答を修正</H2>\n          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>\n            初回回答時の設問スナップショットと1回目自由記述を一つの回答revisionとして更新します。2回目が提出済みなら、保存後の再解析には2回目も自動的に含まれます。\n          </div>`
);
replaceOnce(
  "core/ui.jsx",
  `          {nonFreeQuestions.map((q, index) => (`,
  `          {nonFreeQuestions.map((q, index) => (`
);
// Add first-text textarea immediately before the save controls in the Survey answers edit view.
replaceOnce(
  "core/ui.jsx",
  `          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>\n            <Btn disabled={!complete || busyRef.current} onClick={saveEdit}>変更を保存</Btn>`,
  `          <Card style={{ marginBottom: 10 }}>\n            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>1回目の自由記述</div>\n            <textarea value={editText} maxLength={1500} onChange={e => setEditText(e.target.value)} style={{ width: "100%", minHeight: 180, resize: "vertical", padding: 12, border: "1px solid " + C.rule, borderRadius: 5, fontFamily: FONT_BODY, fontSize: 13, lineHeight: 1.7 }} />\n            <div style={{ textAlign: "right", fontSize: 10, color: C.sub, marginTop: 4 }}>{editText.length}/1500</div>\n          </Card>\n          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>\n            <Btn disabled={!complete || busyRef.current} onClick={saveEdit}>変更して再解析</Btn>`
);
replaceOnce(
  "core/ui.jsx",
  `        await cloudPatchAnswers(id, revision, payload);\n        notify("アンケート回答を修正しました。再解析を開始します");`,
  `        await cloudPatchInitial(id, revision, payload, sanitizeFreeText(editText, 1500));\n        notify("初回回答を修正しました。現在の回答全体で再解析を開始します");`
);
replaceOnce(
  "core/ui.jsx",
  `            <div style={{ fontSize: 13, fontWeight: 700 }}>自由記述を全文修正</div>\n            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>現在の1回目自由記述全文を置き換え、置き換え後の全文を再解析します。</div>\n            <Btn small kind="ghost" onClick={() => { setEditText(String(currentResponse.free || "")); setEditMode("free"); setErr(""); }}>全文を修正する</Btn>\n          </Card>\n          <Card pad={13}>\n            <div style={{ fontSize: 13, fontWeight: 700 }}>アンケート回答を修正</div>\n            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>初回回答時に保存された選択式回答だけを変更します。AI解析は再実行しません。</div>\n            <Btn small kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケートを修正する</Btn>`,
  `            <div style={{ fontSize: 13, fontWeight: 700 }}>初回回答を修正</div>\n            <div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>アンケートと1回目自由記述を一緒に更新し、その時点の2回目自由記述も含めた現在回答全体を再解析します。</div>\n            <Btn small kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditText(String(currentResponse.free || "")); setEditMode("answers"); setErr(""); }}>初回回答を修正する</Btn>`
);

// MyResponse: remove questionnaire-only correction entry; direct users to /survey for initial response correction.
replaceOnce(
  "core/ui.jsx",
  `              <Btn small kind="ghost" onClick={() => { setEditText(String(r.free || "")); setEditMode("free"); setErr(""); }}>1回目を修正</Btn>`,
  `              <Btn small kind="ghost" onClick={() => goto("survey")}>初回回答を修正</Btn>`
);

// 5. Contract assertions; backend test appended below.
let uiTest = read("tests/follow-up-ui-contract.test.mjs");
if (!uiTest.includes("initial response correction is unified")) {
  uiTest += `\n\ntest("initial response correction is unified", () => {\n  assert.ok(ui.includes("cloudPatchInitial"));\n  assert.ok(ui.includes("初回回答を修正"));\n  assert.ok(ui.includes("現在回答全体で再解析"));\n  assert.ok(!ui.includes("AI解析は再実行しません"));\n});\n`;
  write("tests/follow-up-ui-contract.test.mjs", uiTest);
}

let backendTest = read("cloudflare/tests/response-phase4-backend.test.mjs");
if (!backendTest.includes("initial response PATCH updates answers and first text as one revision")) {
  backendTest += `\n\ntest("initial response PATCH updates answers and first text as one revision", async () => {\n  const database = createDatabase(); const queued = []; const waits = [];\n  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };\n  const owner = await register(env, "初回統合修正者"); const cr = await create(env, owner.token); const created = await cr.json();\n  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);\n  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'旧','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());\n  const response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/initial", {\n    method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },\n    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" }, freeText: "修正された初回本文" })\n  }), env, { waitUntil: p => waits.push(p) });\n  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.revision, 2); assert.equal(body.analysisStatus, "pending");\n  await Promise.all(waits);\n  const row = database.prepare("SELECT free_text AS t, revision, analysis_status AS s, analysis_json AS a FROM responses WHERE id=?").get(created.id);\n  assert.deepEqual([row.t,row.revision,row.s,row.a], ["修正された初回本文",2,"pending",null]);\n  const answers = database.prepare("SELECT qid,value FROM answers WHERE response_id=? ORDER BY qid").all(created.id);\n  assert.deepEqual(answers.map(x => [x.qid,x.value]), [["q_econ","5"],["q_priority","経済・雇用"],["q_support","支持しない"]]);\n  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 0);\n  assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 2 }]);\n  database.close();\n});\n\ntest("questionnaire-only PATCH is retired", async () => {\n  const database = createDatabase(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };\n  const owner = await register(env, "単独修正廃止確認"); const cr = await create(env, owner.token); const created = await cr.json();\n  const response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/answers", {\n    method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token },\n    body: JSON.stringify({ expectedRevision: 1, answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" } })\n  }), env);\n  assert.equal(response.status, 410); assert.equal((await response.json()).error, "ANSWERS_ONLY_UPDATE_REMOVED");\n  assert.equal(database.prepare("SELECT revision FROM responses WHERE id=?").get(created.id).revision, 1);\n  database.close();\n});\n`;
  write("cloudflare/tests/response-phase4-backend.test.mjs", backendTest);
}

console.log("response revision unification patch applied");
