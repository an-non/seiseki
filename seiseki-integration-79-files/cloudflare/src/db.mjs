export async function insertPendingResponse(db, response, questionContext = []) {
  const statements = [
    db.prepare(`
      INSERT INTO responses (
        id, created_at, app_version, consent_version, consent_at,
        age, gender, region, occupation, party, free_text,
        analysis_status, analysis_json, demo_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
    `).bind(
      response.id,
      response.createdAt,
      response.appVersion,
      response.consentVersion,
      response.consentAt,
      response.demo.age,
      response.demo.gender,
      response.demo.region,
      response.demo.occupation,
      response.demo.party,
      response.freeText,
      response.demoFlag ? 1 : 0
    )
  ];

  for (const answer of response.answers) {
    statements.push(
      db.prepare("INSERT INTO answers (response_id, qid, value) VALUES (?, ?, ?)")
        .bind(response.id, answer.qid, answer.value)
    );
  }

  for (const question of questionContext) {
    statements.push(db.prepare(`
      INSERT INTO response_questions (
        response_id, qid, position, type, text, options_json, left_label, right_label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      response.id,
      question.qid,
      question.position,
      question.type,
      question.text,
      JSON.stringify(question.options),
      question.left,
      question.right
    ));
  }

  await db.batch(statements);
}

export async function getResponseMetadata(db, id) {
  return db.prepare(`
    SELECT id, created_at AS createdAt, app_version AS appVersion,
           consent_version AS consentVersion, analysis_status AS analysisStatus,
           demo_flag AS demoFlag
    FROM responses
    WHERE id = ?
  `).bind(id).first();
}

export async function getResponseForAnalysis(db, id) {
  const response = await db.prepare(`
    SELECT id, free_text AS freeText, analysis_status AS analysisStatus,
           age, gender, region, occupation, party
    FROM responses
    WHERE id = ?
  `).bind(id).first();
  if (!response) return null;
  const answers = await db.prepare(`
    SELECT qid, value
    FROM answers
    WHERE response_id = ?
    ORDER BY qid
  `).bind(id).all();
  const questions = await db.prepare(`
    SELECT qid, position, type, text, options_json AS optionsJson,
           left_label AS leftLabel, right_label AS rightLabel
    FROM response_questions
    WHERE response_id = ?
    ORDER BY position
  `).bind(id).all();
  return {
    ...response,
    answers: answers.results ?? [],
    questions: (questions.results ?? []).map(question => {
      let options = [];
      try { options = JSON.parse(question.optionsJson); } catch { options = []; }
      return { ...question, options };
    })
  };
}

export async function startAnalysisRun(db, responseId, engine, model, promptVersion) {
  const result = await db.prepare(`
    INSERT INTO analysis_runs (
      response_id, engine, model, prompt_version, status, started_at
    )
    SELECT ?, ?, ?, ?, 'running', ?
    WHERE EXISTS (
      SELECT 1 FROM responses WHERE id = ? AND analysis_status = 'pending'
    ) AND NOT EXISTS (
      SELECT 1 FROM analysis_runs WHERE response_id = ? AND status = 'running'
    )
  `).bind(
    responseId, engine, model, promptVersion, Date.now(), responseId, responseId
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function completeResponseAnalysis(db, responseId, analysis, metadata) {
  const completedAt = Date.now();
  const statements = [
    db.prepare("DELETE FROM opinion_chunks WHERE response_id = ?").bind(responseId),
    db.prepare(`
      UPDATE responses
      SET analysis_status = 'completed', analysis_json = ?
      WHERE id = ?
    `).bind(JSON.stringify(analysis), responseId)
  ];
  for (const chunk of analysis.chunks) {
    statements.push(db.prepare(`
      INSERT INTO opinion_chunks (
        response_id, created_at, summary, category, topic,
        target_type, target_name, emotion, criticality, fact_status, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      responseId,
      completedAt,
      chunk.s,
      chunk.cat,
      chunk.topic,
      chunk.tt,
      chunk.tn,
      chunk.emo,
      chunk.crit,
      chunk.fact,
      JSON.stringify(metadata)
    ));
  }
  statements.push(db.prepare(`
    UPDATE analysis_runs
    SET status = 'completed', completed_at = ?, error_code = NULL
    WHERE id = (
      SELECT id FROM analysis_runs
      WHERE response_id = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1
    )
  `).bind(completedAt, responseId));
  await db.batch(statements);
}

export async function failResponseAnalysis(db, responseId, errorCode) {
  const completedAt = Date.now();
  await db.batch([
    db.prepare(`
      UPDATE responses
      SET analysis_status = 'failed', analysis_json = NULL
      WHERE id = ?
    `).bind(responseId),
    db.prepare(`
      UPDATE analysis_runs
      SET status = 'failed', completed_at = ?, error_code = ?
      WHERE id = (
        SELECT id FROM analysis_runs
        WHERE response_id = ? AND status = 'running'
        ORDER BY id DESC LIMIT 1
      )
    `).bind(completedAt, String(errorCode || "ANALYSIS_FAILED").slice(0, 80), responseId)
  ]);
}

export async function getResponseAnalysis(db, id) {
  const row = await db.prepare(`
    SELECT analysis_status AS analysisStatus, analysis_json AS analysisJson
    FROM responses
    WHERE id = ?
  `).bind(id).first();
  if (!row) return null;
  const run = await db.prepare(`
    SELECT status, error_code AS errorCode
    FROM analysis_runs
    WHERE response_id = ?
    ORDER BY id DESC LIMIT 1
  `).bind(id).first();
  let analysis = null;
  if (row.analysisJson) {
    try { analysis = JSON.parse(row.analysisJson); } catch { analysis = null; }
  }
  return {
    analysisStatus: row.analysisStatus === "pending" && run?.status === "running"
      ? "running"
      : row.analysisStatus,
    analysis,
    ...(run?.errorCode ? { errorCode: run.errorCode } : {})
  };
}

export async function deleteResponse(db, id) {
  const result = await db.prepare("DELETE FROM responses WHERE id = ?").bind(id).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function getBasicStats(db) {
  const [responseRow, chunkRow, statusRows, answerRows] = await Promise.all([
    db.prepare("SELECT count(*) AS count FROM responses WHERE demo_flag = 0").first(),
    db.prepare("SELECT count(*) AS count FROM opinion_chunks c JOIN responses r ON r.id = c.response_id WHERE r.demo_flag = 0").first(),
    db.prepare("SELECT analysis_status AS status, count(*) AS count FROM responses WHERE demo_flag = 0 GROUP BY analysis_status").all(),
    db.prepare("SELECT qid, value, count(*) AS count FROM answers a JOIN responses r ON r.id = a.response_id WHERE r.demo_flag = 0 GROUP BY qid, value ORDER BY qid, value").all()
  ]);

  return {
    responses: Number(responseRow?.count ?? 0),
    opinionChunks: Number(chunkRow?.count ?? 0),
    analysis: Object.fromEntries((statusRows.results ?? []).map(row => [row.status, Number(row.count)])),
    answers: (answerRows.results ?? []).map(row => ({
      qid: row.qid,
      value: row.value,
      count: Number(row.count)
    }))
  };
}

function publicDemoAnalysis(value) {
  let parsed;
  try { parsed = JSON.parse(String(value ?? "")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !parsed.params || !Array.isArray(parsed.chunks)) return null;
  const emotion = parsed.params.emo ?? {};
  const ideology = parsed.ideology ?? {};
  const numberInRange = (value, min, max, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return {
    params: {
      emo: { pol: Number(emotion.pol ?? 0), label: String(emotion.label ?? "中立").slice(0, 6) },
      valid: Number(parsed.params.valid ?? 0),
      crit: Number(parsed.params.crit ?? 0),
      motiv: Number(parsed.params.motiv ?? 0)
    },
    ideology: {
      econ: Math.round(numberInRange(ideology.econ, -100, 100)),
      soc: Math.round(numberInRange(ideology.soc, -100, 100)),
      confidence: Math.round(numberInRange(ideology.confidence, 0, 100))
    },
    attrs: Array.isArray(parsed.attrs) ? parsed.attrs.slice(0, 4).map(value => String(value).slice(0, 14)) : [],
    chunks: parsed.chunks.slice(0, 5).map(chunk => ({
      s: String(chunk.s ?? "").slice(0, 48),
      cat: String(chunk.cat ?? "評価"),
      topic: String(chunk.topic ?? "その他").slice(0, 24),
      tt: String(chunk.tt ?? "その他"),
      tn: String(chunk.tn ?? "").slice(0, 40),
      emo: Number(chunk.emo ?? 0),
      crit: Number(chunk.crit ?? 0),
      fact: chunk.fact === "要検証" ? "要検証" : "意見"
    })).filter(chunk => chunk.s)
  };
}

export async function listPublicDemoResponses(db, limit = 100) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 100)));
  const [responseRows, answerRows] = await Promise.all([
    db.prepare(`
      SELECT id, created_at AS createdAt, app_version AS appVersion,
             age, gender, region, occupation, party, analysis_json AS analysisJson
      FROM responses
      WHERE demo_flag = 1 AND analysis_status = 'completed' AND analysis_json IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(safeLimit).all(),
    db.prepare(`
      SELECT a.response_id AS responseId, a.qid, a.value
      FROM answers a
      JOIN responses r ON r.id = a.response_id
      WHERE r.demo_flag = 1 AND r.analysis_status = 'completed'
      ORDER BY a.response_id, a.qid
    `).all()
  ]);
  const answersById = new Map();
  for (const row of answerRows.results ?? []) {
    if (row.qid === "demo_batch") continue;
    const answers = answersById.get(row.responseId) ?? {};
    answers[row.qid] = row.value;
    answersById.set(row.responseId, answers);
  }
  return (responseRows.results ?? []).map((row, index) => ({
    id: `remote-demo-${index + 1}`,
    ts: Number(row.createdAt),
    ver: String(row.appVersion ?? ""),
    seq: 1,
    demoFlag: true,
    demo: {
      age: row.age ?? "",
      gender: row.gender ?? "",
      region: row.region ?? "",
      occupation: row.occupation ?? "",
      party: row.party ?? ""
    },
    answers: answersById.get(row.id) ?? {},
    free: "",
    freeQids: [],
    analysis: publicDemoAnalysis(row.analysisJson)
  })).filter(row => row.analysis);
}
