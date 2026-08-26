import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content, "utf8");
}

function replaceOnce(content, needle, replacement, label) {
  const count = content.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, got ${count}`);
  }
  return content.replace(needle, replacement);
}

// 1) Requeue cooldown: keep authorization/revision/pending checks first, then rate-limit
// the exact response+revision so a retry button cannot flood the Queue.
{
  const path = "cloudflare/src/rate-limit.mjs";
  let content = read(path);
  if (!content.includes('requeue: Object.freeze({')) {
    const end = content.lastIndexOf("\n});");
    if (end < 0) throw new Error("rate-limit: policy object terminator not found");
    const addition = `,\n  requeue: Object.freeze({\n    name: "requeue",\n    network: Object.freeze([\n      Object.freeze({ label: "minute", limit: 30, windowMs: 60 * 1000 })\n    ]),\n    subject: Object.freeze([\n      Object.freeze({ label: "cooldown", limit: 1, windowMs: 15 * 1000 }),\n      Object.freeze({ label: "minute", limit: 3, windowMs: 60 * 1000 })\n    ])\n  })`;
    content = content.slice(0, end) + addition + content.slice(end);
    write(path, content);
  }
}

{
  const path = "cloudflare/src/index.mjs";
  let content = read(path);
  if (!content.includes("RATE_LIMIT_POLICIES.requeue")) {
    const needle = `    if (current.analysisStatus !== "pending") {\n      throw new RequestError(409, "ANALYSIS_NOT_PENDING", "only a pending analysis can be requeued");\n    }\n    await enqueueAnalysisRevision(env, requeueId, expectedRevision);`;
    const replacement = `    if (current.analysisStatus !== "pending") {\n      throw new RequestError(409, "ANALYSIS_NOT_PENDING", "only a pending analysis can be requeued");\n    }\n    await enforceRateLimit(\n      env.DB, request, RATE_LIMIT_POLICIES.requeue, \`${"${requeueId}:${expectedRevision}"}\`\n    );\n    await enqueueAnalysisRevision(env, requeueId, expectedRevision);`;
    content = replaceOnce(content, needle, replacement, "index requeue cooldown");
    write(path, content);
  }
}

// 2) Public clients must not be able to self-classify a response as demo. A future
// staging-admin route can set demo_flag server-side; the public POST always stores normal data.
{
  const path = "cloudflare/src/validation.mjs";
  let content = read(path);
  if (content.includes("demoFlag: body.demoFlag === true")) {
    content = replaceOnce(
      content,
      "    demoFlag: body.demoFlag === true",
      "    demoFlag: false",
      "validation public demo flag"
    );
    write(path, content);
  } else if (!content.includes("    demoFlag: false")) {
    throw new Error("validation: demoFlag assignment not found");
  }
}

// 3) Validation contract test for server-owned demo classification.
{
  const path = "cloudflare/tests/validation.test.mjs";
  let content = read(path);
  const marker = 'test("public submission cannot self-classify as demo"';
  if (!content.includes(marker)) {
    content += `\n\ntest("public submission cannot self-classify as demo", () => {\n  const result = normalizeSubmission(fixture({ demoFlag: true }));\n  assert.equal(result.demoFlag, false);\n});\n`;
    write(path, content);
  }
}

// 4) Stronger CAS/no-partial-mutation and requeue cooldown regression tests.
{
  const path = "cloudflare/tests/response-phase4-backend.test.mjs";
  let content = read(path);
  const marker = 'test("stale loser leaves response children completely untouched"';
  if (!content.includes(marker)) {
    content += `\n\ntest("stale loser leaves response children completely untouched", async () => {\n  const database = createDatabase();\n  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false" };\n  const owner = await register(env, "競合完全無変更");\n  const cr = await create(env, owner.token);\n  const created = await cr.json();\n  const now = Date.now();\n\n  database.prepare(\`INSERT INTO opinion_chunks (\n    response_id, created_at, summary, category, topic, target_type, target_name,\n    emotion, criticality, fact_status, provenance_json\n  ) VALUES (?, ?, '保持対象', '評価', 'その他', 'その他', '', 0, 0, '意見', '{}')\`).run(created.id, now);\n  database.prepare(\`INSERT INTO analysis_runs (\n    response_id, engine, model, prompt_version, status, started_at, response_revision, lease_until\n  ) VALUES (?, 'test', 'test', 'v1', 'running', ?, 1, ?)\`).run(created.id, now, now + 60000);\n  database.prepare("UPDATE responses SET revision = 2 WHERE id = ?").run(created.id);\n\n  const snapshot = () => ({\n    response: database.prepare("SELECT revision, free_text, analysis_status, analysis_json FROM responses WHERE id = ?").get(created.id),\n    answers: database.prepare("SELECT qid, value FROM answers WHERE response_id = ? ORDER BY qid").all(created.id),\n    chunks: database.prepare("SELECT summary, category, topic FROM opinion_chunks WHERE response_id = ? ORDER BY id").all(created.id),\n    runs: database.prepare("SELECT id, status, error_code, response_revision, lease_until FROM analysis_runs WHERE response_id = ? ORDER BY id").all(created.id)\n  });\n  const before = snapshot();\n\n  const staleText = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/free-text\`, {\n    method: "PATCH",\n    headers: { "content-type": "application/json", authorization: \`Bearer \${owner.token}\` },\n    body: JSON.stringify({ expectedRevision: 1, freeText: "敗者更新" })\n  }), env);\n  assert.equal(staleText.status, 409);\n  assert.equal((await staleText.json()).error, "REVISION_CONFLICT");\n  assert.deepEqual(snapshot(), before);\n\n  const staleAnswers = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/answers\`, {\n    method: "PATCH",\n    headers: { "content-type": "application/json", authorization: \`Bearer \${owner.token}\` },\n    body: JSON.stringify({\n      expectedRevision: 1,\n      answers: { q_support: "支持しない", q_priority: "経済・雇用", q_econ: "5" }\n    })\n  }), env);\n  assert.equal(staleAnswers.status, 409);\n  assert.equal((await staleAnswers.json()).error, "REVISION_CONFLICT");\n  assert.deepEqual(snapshot(), before);\n  database.close();\n});\n\ntest("analysis requeue has a short per-response revision cooldown", async () => {\n  const database = createDatabase();\n  const queued = [];\n  const env = {\n    DB: new D1(database),\n    TURNSTILE_REQUIRED: "false",\n    ANALYSIS_QUEUE: { send: async value => queued.push(value) }\n  };\n  const cr = await create(env, null);\n  const created = await cr.json();\n  const request = () => new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, {\n    method: "POST",\n    headers: {\n      "content-type": "application/json",\n      "x-response-manage-token": created.manageToken,\n      "x-forwarded-for": "203.0.113.25"\n    },\n    body: JSON.stringify({ expectedRevision: 1 })\n  });\n\n  const first = await worker.fetch(request(), env);\n  assert.equal(first.status, 202);\n  const second = await worker.fetch(request(), env);\n  assert.equal(second.status, 429);\n  assert.equal((await second.json()).error, "RATE_LIMITED");\n  assert.equal(queued.length, 1);\n  database.close();\n});\n`;
    write(path, content);
  }
}

console.log("Applied Phase 4 final hardening patch.");
