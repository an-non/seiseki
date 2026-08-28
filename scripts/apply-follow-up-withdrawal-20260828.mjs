import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  let source = readFileSync(path, "utf8");
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, found ${count}: ${from.slice(0, 120)}`);
  source = source.replace(from, to);
  writeFileSync(path, source, "utf8");
}

function appendOnce(path, marker, addition) {
  let source = readFileSync(path, "utf8");
  if (!source.includes(marker)) source += addition;
  writeFileSync(path, source, "utf8");
}

// Validation: DELETE /follow-up accepts expectedRevision only.
replaceOnce(
  "cloudflare/src/validation.mjs",
  `export function normalizeFollowUpTextUpdate(input) {\n  return normalizeFollowUpTextBody(input);\n}\n\nexport function normalizeAnswersUpdate(input) {`,
  `export function normalizeFollowUpTextUpdate(input) {\n  return normalizeFollowUpTextBody(input);\n}\n\nexport function normalizeFollowUpTextDelete(input) {\n  const body = requireObject(input, "body");\n  const allowed = new Set(["expectedRevision"]);\n  for (const key of Object.keys(body)) {\n    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);\n  }\n  return Object.freeze({ expectedRevision: normalizeExpectedRevision(body.expectedRevision) });\n}\n\nexport function normalizeAnswersUpdate(input) {`
);

// DB: delete only the second free text, invalidate current analysis, increment same response revision.
replaceOnce(
  "cloudflare/src/db.mjs",
  `export function updateResponseFollowUpText(db, id, expectedRevision, followUpText) {\n  return mutateResponseFollowUpText(db, id, expectedRevision, followUpText, "update");\n}\n\nexport async function updateResponseFreeText`,
  `export function updateResponseFollowUpText(db, id, expectedRevision, followUpText) {\n  return mutateResponseFollowUpText(db, id, expectedRevision, followUpText, "update");\n}\n\nexport async function deleteResponseFollowUpText(db, id, expectedRevision) {\n  const now = Date.now();\n  const guard = "EXISTS (SELECT 1 FROM responses WHERE id = ? AND revision = ? AND follow_up_text IS NOT NULL)";\n  const statements = [\n    db.prepare("DELETE FROM opinion_chunks WHERE response_id = ? AND " + guard)\n      .bind(id, id, expectedRevision),\n    db.prepare(\n      "UPDATE analysis_runs SET status = 'failed', completed_at = ?, error_code = 'SUPERSEDED_REVISION', lease_until = NULL " +\n      "WHERE response_id = ? AND response_revision = ? AND status = 'running' AND " + guard\n    ).bind(now, id, expectedRevision, id, expectedRevision),\n    db.prepare(\n      "UPDATE responses SET follow_up_text = NULL, updated_at = ?, revision = revision + 1, " +\n      "analysis_status = 'pending', analysis_json = NULL WHERE id = ? AND revision = ? AND follow_up_text IS NOT NULL"\n    ).bind(now, id, expectedRevision)\n  ];\n  const results = await db.batch(statements);\n  if (Number(results?.[2]?.meta?.changes ?? 0) === 1) {\n    return { status: "updated", revision: Number(expectedRevision) + 1, updatedAt: now };\n  }\n  const current = await db.prepare(\n    "SELECT revision, follow_up_text AS followUpText FROM responses WHERE id = ?"\n  ).bind(id).first();\n  if (!current) return { status: "not_found" };\n  if (Number(current.revision ?? 1) !== Number(expectedRevision)) return { status: "stale" };\n  if (current.followUpText == null) return { status: "missing" };\n  return { status: "conflict" };\n}\n\nexport async function updateResponseFreeText`
);

// API route supports DELETE with ownership + revision guard and queues reanalysis.
replaceOnce(
  "cloudflare/src/index.mjs",
  `  createResponseFollowUpText,\n  deleteResponse,`,
  `  createResponseFollowUpText,\n  deleteResponseFollowUpText,\n  deleteResponse,`
);
replaceOnce(
  "cloudflare/src/index.mjs",
  `  normalizeExpectedRevision,\n  normalizeFollowUpTextCreate,\n  normalizeFollowUpTextUpdate,`,
  `  normalizeExpectedRevision,\n  normalizeFollowUpTextCreate,\n  normalizeFollowUpTextDelete,\n  normalizeFollowUpTextUpdate,`
);
replaceOnce(
  "cloudflare/src/index.mjs",
  `  if (followUpId && (request.method === "POST" || request.method === "PATCH")) {\n    await authorizeResponseAccess(env.DB, request, followUpId);\n    const input = request.method === "POST"\n      ? normalizeFollowUpTextCreate(await readJson(request))\n      : normalizeFollowUpTextUpdate(await readJson(request));\n    const outcome = request.method === "POST"\n      ? await createResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)\n      : await updateResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText);`,
  `  if (followUpId && (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE")) {\n    await authorizeResponseAccess(env.DB, request, followUpId);\n    const rawInput = await readJson(request);\n    const input = request.method === "POST"\n      ? normalizeFollowUpTextCreate(rawInput)\n      : request.method === "PATCH"\n        ? normalizeFollowUpTextUpdate(rawInput)\n        : normalizeFollowUpTextDelete(rawInput);\n    const outcome = request.method === "POST"\n      ? await createResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)\n      : request.method === "PATCH"\n        ? await updateResponseFollowUpText(env.DB, followUpId, input.expectedRevision, input.followUpText)\n        : await deleteResponseFollowUpText(env.DB, followUpId, input.expectedRevision);`
);
replaceOnce(
  "cloudflare/src/index.mjs",
  `      analysisStatus: "pending",\n      updatedAt: outcome.updatedAt\n    }, request.method === "POST" ? 201 : 200);`,
  `      analysisStatus: "pending",\n      followUpSubmitted: request.method === "DELETE" ? false : true,\n      updatedAt: outcome.updatedAt\n    }, request.method === "POST" ? 201 : 200);`
);

// UI API helper.
replaceOnce(
  "core/ui.jsx",
  `async function cloudPatchFollowUp(id, expectedRevision, followUpText) {\n  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {\n    method: "PATCH",\n    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },\n    body: JSON.stringify({ expectedRevision: expectedRevision, followUpText: followUpText })\n  });\n}\n\nasync function cloudPatchFreeText`,
  `async function cloudPatchFollowUp(id, expectedRevision, followUpText) {\n  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {\n    method: "PATCH",\n    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },\n    body: JSON.stringify({ expectedRevision: expectedRevision, followUpText: followUpText })\n  });\n}\n\nasync function cloudDeleteFollowUp(id, expectedRevision) {\n  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/follow-up", {\n    method: "DELETE",\n    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },\n    body: JSON.stringify({ expectedRevision: expectedRevision })\n  });\n}\n\nasync function cloudPatchFreeText`
);

replaceOnce(
  "core/ui.jsx",
  `  const [confirming, setConfirming] = useState(false);\n  const [editMode, setEditMode] = useState(null);`,
  `  const [confirming, setConfirming] = useState(false);\n  const [confirmSecondDelete, setConfirmSecondDelete] = useState(false);\n  const [editMode, setEditMode] = useState(null);`
);

replaceOnce(
  "core/ui.jsx",
  `  async function saveResponseEdit() {`,
  `  async function deleteSecondResponse() {\n    if (editBusyRef.current || !found || !found.r || !found.r.remoteId) return;\n    const r = found.r;\n    const id = r.remoteId || found.id;\n    const revision = Number(r.remoteRevision || r.revision || 1);\n    editBusyRef.current = true;\n    setErr("");\n    try {\n      const updated = await cloudDeleteFollowUp(id, revision);\n      let fresh = null;\n      if (session && session.token) {\n        try { fresh = await cloudLoadOwnResponse(id, session.token); }\n        catch (loadError) { console.warn("follow-up withdrawal refresh failed", loadError); }\n      }\n      if (fresh) {\n        setFound({ id: found.id, r: fresh, r2: null });\n      } else {\n        setFound({\n          ...found,\n          r: {\n            ...r,\n            followUpText: "",\n            followUpSubmitted: false,\n            revision: Number(updated && updated.revision || revision + 1),\n            remoteRevision: Number(updated && updated.revision || revision + 1),\n            analysis: null,\n            analysisSource: "cloudflare",\n            cloudAnalysisStatus: "pending"\n          },\n          r2: null\n        });\n      }\n      setConfirmSecondDelete(false);\n      setEditMode(null);\n      notify("2回目の自由記述を撤回しました。1回目の回答のみで再解析を開始します");\n    } catch (error) {\n      if (error && error.code === "REVISION_CONFLICT") {\n        setErr("回答が更新されています。再読み込みしてからもう一度お試しください。");\n      } else if (error && error.code === "FOLLOW_UP_NOT_SUBMITTED") {\n        setErr("2回目の自由記述はすでに撤回されています。");\n      } else {\n        setErr("2回目の自由記述の撤回に失敗しました。時間をおいて再度お試しください。");\n      }\n    } finally {\n      editBusyRef.current = false;\n    }\n  }\n\n  async function saveResponseEdit() {`
);

replaceOnce(
  "core/ui.jsx",
  `<div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.followUpText || "（記載なし）"}</div>`,
  `<div style={{ whiteSpace: "pre-wrap", fontSize: 13, background: C.soft, borderRadius: 5, padding: "9px 11px" }}>{r.followUpText || "（記載なし）"}</div>\n              {r.remoteId ? (\n                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>\n                  {confirmSecondDelete ? (\n                    <>\n                      <Btn small kind="danger" onClick={deleteSecondResponse}>2回目を本当に撤回する</Btn>\n                      <Btn small kind="ghost" onClick={() => setConfirmSecondDelete(false)}>やめる</Btn>\n                    </>\n                  ) : (\n                    <Btn small kind="ghost" onClick={() => setConfirmSecondDelete(true)}>2回目を撤回</Btn>\n                  )}\n                </div>\n              ) : null}`
);

replaceOnce(
  "core/ui.jsx",
  `<Btn kind="danger" onClick={() => setConfirming(true)}>この回答を撤回する</Btn>`,
  `<Btn kind="danger" onClick={() => setConfirming(true)}>回答、解析結果を削除する</Btn>`
);

// Backend test for withdrawal and revision/queue semantics.
appendOnce(
  "cloudflare/tests/follow-up-free-text.test.mjs",
  `test("second free text can be withdrawn without deleting the first response"`,
  `\n\ntest("second free text can be withdrawn without deleting the first response", async () => {\n  const database = db(); const queued = []; const waits = [];\n  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", AI_ANALYSIS_ENABLED: "true", ANALYSIS_QUEUE: { send: async item => queued.push(item) } };\n  const owner = await register(env, "二回目撤回者"); const created = await create(env, owner.token);\n  let response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "撤回対象の第二本文" }) }), env, { waitUntil: p => waits.push(p) });\n  assert.equal(response.status, 201); await Promise.all(waits); waits.length = 0; queued.length = 0;\n  database.prepare("UPDATE responses SET analysis_status='completed', analysis_json='{}' WHERE id=?").run(created.id);\n  database.prepare("INSERT INTO opinion_chunks (response_id,created_at,summary,category,topic,target_type,target_name,emotion,criticality,fact_status,provenance_json) VALUES (?,?,'第二込み','評価','その他','その他','',0,0,'意見','{}')").run(created.id, Date.now());\n  response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "DELETE", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2 }) }), env, { waitUntil: p => waits.push(p) });\n  assert.equal(response.status, 200); const body = await response.json();\n  assert.equal(body.revision, 3); assert.equal(body.followUpSubmitted, false); assert.equal(body.analysisStatus, "pending");\n  await Promise.all(waits);\n  const row = database.prepare("SELECT free_text AS firstText, follow_up_text AS secondText, revision, analysis_status AS status, analysis_json AS analysisJson FROM responses WHERE id=?").get(created.id);\n  assert.deepEqual([row.firstText, row.secondText, row.revision, row.status, row.analysisJson], ["初回本文", null, 3, "pending", null]);\n  assert.equal(database.prepare("SELECT count(*) AS n FROM opinion_chunks WHERE response_id=?").get(created.id).n, 0);\n  assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 3 }]);\n  const mine = await worker.fetch(new Request("http://local/api/accounts/me/responses", { headers: { authorization: "Bearer " + owner.token } }), env);\n  const payload = await mine.json();\n  assert.equal(payload.responses[0].followUpText, null);\n  assert.equal(payload.responses[0].followUpSubmitted, false);\n  database.close();\n});\n\ntest("stale second free text withdrawal is rejected without mutation", async () => {\n  const database = db(); const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };\n  const owner = await register(env, "二回目撤回競合"); const created = await create(env, owner.token);\n  await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 1, followUpText: "残る第二本文" }) }), env);\n  database.prepare("UPDATE responses SET revision=3 WHERE id=?").run(created.id);\n  const response = await worker.fetch(new Request("http://local/api/responses/" + created.id + "/follow-up", { method: "DELETE", headers: { "content-type": "application/json", authorization: "Bearer " + owner.token }, body: JSON.stringify({ expectedRevision: 2 }) }), env);\n  assert.equal(response.status, 409); assert.equal((await response.json()).error, "REVISION_CONFLICT");\n  const row = database.prepare("SELECT follow_up_text AS secondText, revision FROM responses WHERE id=?").get(created.id);\n  assert.deepEqual([row.secondText, row.revision], ["残る第二本文", 3]);\n  database.close();\n});\n`
);

appendOnce(
  "tests/follow-up-ui-contract.test.mjs",
  `test("my response exposes second free-text withdrawal"`,
  `\n\ntest("my response exposes second free-text withdrawal", () => {\n  assert.ok(ui.includes("2回目を撤回"));\n  assert.ok(ui.includes("2回目を本当に撤回する"));\n  assert.ok(ui.includes("cloudDeleteFollowUp"));\n  assert.ok(ui.includes("回答、解析結果を削除する"));\n});\n`
);

console.log("follow-up withdrawal patch applied");
