import fs from "node:fs";

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, content) { fs.writeFileSync(path, content, "utf8"); }

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 exact match, got ${count}`);
  return source.replace(from, to);
}

function replaceExactCount(source, from, to, expected, label) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} exact matches, got ${count}`);
  return source.split(from).join(to);
}

function replaceRegexOnce(source, pattern, to, label) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
  if (!matches || matches.length !== 1) throw new Error(`${label}: expected 1 regex match, got ${matches ? matches.length : 0}`);
  return source.replace(pattern, to);
}

let ui = read("core/ui.jsx");

ui = replaceOnce(
  ui,
  "function cloudApiEnabled() { return !!__apiConfig.baseUrl; }\n",
  `function cloudApiEnabled() { return !!__apiConfig.baseUrl; }\n\nfunction analysisDiagnosticsVisible() {\n  return /seiseki-api-staging\\./u.test(String(__apiConfig.baseUrl || \"\"));\n}\n\nfunction analysisValueSnapshot(value) {\n  const params = value && value.params || {};\n  const emotion = params && params.emo || {};\n  const ideology = value && value.ideology || {};\n  const finite = input => {\n    const number = Number(input);\n    return Number.isFinite(number) ? number : null;\n  };\n  return {\n    params: {\n      emo: { pol: finite(emotion.pol) },\n      valid: finite(params.valid),\n      crit: finite(params.crit),\n      motiv: finite(params.motiv)\n    },\n    ideology: {\n      econ: finite(ideology.econ),\n      soc: finite(ideology.soc),\n      confidence: finite(ideology.confidence)\n    }\n  };\n}\n\nfunction normalizeAnalysisValueTrace(payload, uiAnalysis, revision) {\n  const apiAnalysis = payload && payload.analysis;\n  const rawTrace = apiAnalysis && apiAnalysis.diagnostics && apiAnalysis.diagnostics.valueTrace;\n  if (!rawTrace || typeof rawTrace !== \"object\") return null;\n  const source = rawTrace.source === \"workers-ai\" || rawTrace.source === \"rules-fallback\"\n    ? rawTrace.source\n    : \"unknown\";\n  return {\n    responseRevision: Number(rawTrace.responseRevision || revision || 0),\n    source: source,\n    raw: analysisValueSnapshot(rawTrace.raw),\n    sanitized: analysisValueSnapshot(rawTrace.sanitized),\n    api: analysisValueSnapshot(apiAnalysis),\n    ui: analysisValueSnapshot(uiAnalysis)\n  };\n}\n`,
  "insert UI analysis diagnostics helpers"
);

ui = replaceOnce(
  ui,
  `  const analysis = sanitizeAnalysis(payload && payload.analysis);\n  return {\n`,
  `  const analysis = sanitizeAnalysis(payload && payload.analysis);\n  const valueTrace = normalizeAnalysisValueTrace(payload, analysis, payload && payload.revision);\n  if (valueTrace && analysisDiagnosticsVisible() && typeof console !== \"undefined\" && console.info) {\n    console.info(\"[SEISEKI analysis value trace]\", valueTrace);\n  }\n  return {\n`,
  "capture API/UI analysis trace"
);

ui = replaceOnce(
  ui,
  `    analysis: analysis,\n    errorCode: String(payload && payload.errorCode || \"\"),\n`,
  `    analysis: analysis,\n    valueTrace: valueTrace,\n    errorCode: String(payload && payload.errorCode || \"\"),\n`,
  "return analysis trace"
);

ui = replaceOnce(
  ui,
  `          cloudAnalysisStatus: \"completed\",\n          cloudAnalysisMode: result.mode\n`,
  `          cloudAnalysisStatus: \"completed\",\n          cloudAnalysisMode: result.mode,\n          analysisValueTrace: result.valueTrace || null\n`,
  "reconcile trace"
);

ui = replaceOnce(
  ui,
  `    response.analysis = state.analysis;\n    response.analysisSource = \"cloudflare\";\n`,
  `    response.analysis = state.analysis;\n    response.analysisValueTrace = state.valueTrace || null;\n    response.analysisSource = \"cloudflare\";\n`,
  "attach trace to own response"
);

ui = replaceOnce(
  ui,
  `    let cloudAnalysisMode = null;\n    let remoteId = null;\n`,
  `    let cloudAnalysisMode = null;\n    let analysisValueTrace = null;\n    let remoteId = null;\n`,
  "initialize submission trace"
);

ui = replaceOnce(
  ui,
  `        cloudAnalysisStatus = remote.status;\n        cloudAnalysisMode = remote.mode;\n        if (remote.status === \"completed\" && remote.analysis) {\n`,
  `        cloudAnalysisStatus = remote.status;\n        cloudAnalysisMode = remote.mode;\n        analysisValueTrace = remote.valueTrace || null;\n        if (remote.status === \"completed\" && remote.analysis) {\n`,
  "capture submission trace"
);

ui = replaceOnce(
  ui,
  `      ...(remoteId && cloudAnalysisMode ? { cloudAnalysisMode: cloudAnalysisMode } : {})\n`,
  `      ...(remoteId && cloudAnalysisMode ? { cloudAnalysisMode: cloudAnalysisMode } : {}),\n      ...(remoteId && analysisValueTrace ? { analysisValueTrace: analysisValueTrace } : {})\n`,
  "store submission trace"
);

ui = replaceOnce(
  ui,
  `  survey: \"/survey\",\n  followup: \"/survey/follow-up\",\n`,
  `  survey: \"/survey\",\n  surveyEdit: \"/survey/edit-initial\",\n  followup: \"/survey/follow-up\",\n  followupEdit: \"/survey/follow-up/edit\",\n`,
  "add direct edit routes"
);

ui = replaceOnce(
  ui,
  `function Survey({ questions, policy, notify, onFinished, goto, onDraftChange, session, onAuthed }) {\n`,
  `function Survey({ questions, policy, notify, onFinished, goto, onDraftChange, session, onAuthed, startEditMode }) {\n`,
  "add Survey direct edit prop"
);

ui = replaceOnce(
  ui,
  `  const busyRef = useRef(false);\n  const loadedRef = useRef(false);\n  const timerRef = useRef(null);\n`,
  `  const busyRef = useRef(false);\n  const loadedRef = useRef(false);\n  const autoEditRef = useRef(false);\n  const timerRef = useRef(null);\n`,
  "add Survey auto edit ref"
);

ui = replaceOnce(
  ui,
  `    setCurrentLoadError(\"\");\n    setEditMode(null);\n    (async () => {\n`,
  `    setCurrentLoadError(\"\");\n    setEditMode(null);\n    autoEditRef.current = false;\n    (async () => {\n`,
  "reset Survey auto edit"
);

ui = replaceOnce(
  ui,
  `  }, [session, currentLoadNonce]);\n\n  /* PATCH/requeue後は現在revisionの解析だけを追跡する。\n`,
  `  }, [session, currentLoadNonce]);\n\n  useEffect(() => {\n    if (startEditMode !== \"answers\" || !currentResponse || autoEditRef.current) return;\n    autoEditRef.current = true;\n    setAnswers({ ...(currentResponse.answers || {}) });\n    setEditText(String(currentResponse.free || \"\"));\n    setEditMode(\"answers\");\n    setErr(\"\");\n  }, [startEditMode, currentResponse]);\n\n  /* PATCH/requeue後は現在revisionの解析だけを追跡する。\n`,
  "auto open initial response editor"
);

ui = replaceOnce(
  ui,
  `              ? <Btn small kind=\"ghost\" onClick={() => goto(\"mine\")}>2回目を確認・修正</Btn>\n`,
  `              ? <Btn small kind=\"ghost\" onClick={() => goto(\"followupEdit\")}>2回目の回答を修正</Btn>\n`,
  "direct second edit from survey"
);

ui = replaceOnce(
  ui,
  `function FollowUpSurvey({ goto, session, onAuthed, notify }) {\n`,
  `function FollowUpSurvey({ goto, session, onAuthed, notify, editExisting }) {\n`,
  "add follow-up edit prop"
);

ui = replaceOnce(
  ui,
  `      setCurrent(response || null);\n`,
  `      setCurrent(response || null);\n      if (editExisting && response && response.followUpSubmitted) {\n        setText(String(response.followUpText || \"\"));\n      }\n`,
  "prefill existing follow-up"
);

ui = replaceOnce(
  ui,
  `  useEffect(() => { load(); }, [session && session.name, session && session.token]);\n`,
  `  useEffect(() => { load(); }, [session && session.name, session && session.token, editExisting]);\n`,
  "reload follow-up edit mode"
);

ui = replaceOnce(
  ui,
  `      const updated = await cloudCreateFollowUp(id, revision, body);\n`,
  `      const updated = editExisting\n        ? await cloudPatchFollowUp(id, revision, body)\n        : await cloudCreateFollowUp(id, revision, body);\n`,
  "switch follow-up create or patch"
);

ui = replaceOnce(
  ui,
  `      notify(\"二度目の自由記述を保存しました。再解析を開始します\");\n`,
  `      notify(editExisting\n        ? \"2回目の自由記述を修正しました。再解析を開始します\"\n        : \"二度目の自由記述を保存しました。再解析を開始します\");\n`,
  "follow-up edit notification"
);

ui = replaceOnce(
  ui,
  `  if (done || current.followUpSubmitted) {\n`,
  `  if (done || (current.followUpSubmitted && !editExisting)) {\n`,
  "allow submitted follow-up editor"
);

ui = replaceOnce(
  ui,
  `      <H2 eyebrow=\"SECOND FREE TEXT\" sub=\"初回本文とは別に保存し、回答全体を再解析します\">二度目の自由記述</H2>\n`,
  `      <H2 eyebrow=\"SECOND FREE TEXT\" sub=\"初回本文とは別に保存し、回答全体を再解析します\">{editExisting ? \"二度目の自由記述を修正\" : \"二度目の自由記述\"}</H2>\n`,
  "follow-up edit heading"
);

ui = replaceOnce(
  ui,
  `        <span>この新規提出は一度だけです。提出後の変更は修正機能から行えます。</span>\n`,
  `        <span>{editExisting ? \"提出済みの2回目だけを書き換えます。保存すると現在回答全体を再解析します。\" : \"この新規提出は一度だけです。提出後の変更は修正機能から行えます。\"}</span>\n`,
  "follow-up edit helper copy"
);

ui = replaceOnce(
  ui,
  `        <Btn disabled={!text.trim()} onClick={submitFollowUp}>二度目の自由記述を送信</Btn>\n`,
  `        <Btn disabled={!text.trim()} onClick={submitFollowUp}>{editExisting ? \"修正を保存して再解析\" : \"二度目の自由記述を送信\"}</Btn>\n`,
  "follow-up edit submit label"
);

ui = replaceOnce(
  ui,
  `              <Btn small kind=\"ghost\" onClick={() => goto(\"survey\")}>初回回答を修正</Btn>\n`,
  `              <Btn small kind=\"ghost\" onClick={() => goto(\"surveyEdit\")}>初回回答を修正</Btn>\n`,
  "direct initial edit from own response"
);

ui = replaceOnce(
  ui,
  `            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>初回回答はアンケートと1回目自由記述を一緒に修正します。2回目は独立して修正・撤回できます。</div>\n`,
  `            <div style={{ fontSize: 11, color: C.sub, marginBottom: 10 }}>初回回答はアンケートと1回目自由記述を一緒に修正します。2回目は独立して修正・撤回できます。初回だけの撤回は行わず、初回を撤回する場合は回答全体を撤回します。</div>\n`,
  "clarify withdrawal model"
);

ui = replaceOnce(
  ui,
  `              <Btn kind=\"danger\" onClick={() => setConfirming(true)}>回答、解析結果を削除する</Btn>\n`,
  `              <Btn kind=\"danger\" onClick={() => setConfirming(true)}>回答全体を撤回する</Btn>\n`,
  "rename full response withdrawal"
);

ui = replaceOnce(
  ui,
  `        ) : view === \"followup\" ? (\n`,
  `        ) : view === \"followup\" || view === \"followupEdit\" ? (\n`,
  "render follow-up edit route"
);

ui = replaceOnce(
  ui,
  `          <FollowUpSurvey goto={goView} session={session} onAuthed={onAuthed} notify={notify} />\n`,
  `          <FollowUpSurvey goto={goView} session={session} onAuthed={onAuthed} notify={notify} editExisting={view === \"followupEdit\"} />\n`,
  "pass follow-up edit mode"
);

ui = replaceOnce(
  ui,
  `        ) : view === \"survey\" ? (\n`,
  `        ) : view === \"survey\" || view === \"surveyEdit\" ? (\n`,
  "render initial edit route"
);

ui = replaceOnce(
  ui,
  `          <Survey questions={questions} policy={policy} notify={notify} onFinished={(a, result) => { const shown = withCloudDemos(a, cloudDemos); setAgg(shown); setCompletion({ ...result, agg: shown }); goView(\"complete\"); }} goto={goView}\n`,
  `          <Survey questions={questions} policy={policy} notify={notify} onFinished={(a, result) => { const shown = withCloudDemos(a, cloudDemos); setAgg(shown); setCompletion({ ...result, agg: shown }); goView(\"complete\"); }} goto={goView}\n            startEditMode={view === \"surveyEdit\" ? \"answers\" : null}\n`,
  "pass initial edit mode"
);

const newIdeoMap = `function IdeoMap({ points, me, avgPt, height, confidence }) {\n  const h = height || 190;\n  const px = v => ((clamp(v, -100, 100) + 100) / 200) * 100;\n  const confidenceValue = Number.isFinite(Number(confidence)) ? Math.round(clamp(confidence, 0, 100)) : null;\n  const confidenceLabel = confidenceValue == null ? \"\" : confidenceValue < 35 ? \"低め\" : confidenceValue < 70 ? \"中程度\" : \"高め\";\n  const axisLabel = { position: \"absolute\", zIndex: 2, fontSize: 9, lineHeight: 1.25, color: C.sub, background: C.card, padding: \"2px 4px\", borderRadius: 3, pointerEvents: \"none\" };\n  return (\n    <div>\n      <div style={{ position: \"relative\", width: \"100%\", height: h, background: C.soft, border: \"1px solid \" + C.rule, borderRadius: 4, overflow: \"hidden\" }}>\n        <div style={{ position: \"absolute\", left: \"50%\", top: 0, bottom: 0, width: 1, background: C.rule }} />\n        <div style={{ position: \"absolute\", top: \"50%\", left: 0, right: 0, height: 1, background: C.rule }} />\n        <div style={{ ...axisLabel, left: 5, top: \"50%\", transform: \"translateY(-50%)\", maxWidth: \"42%\" }}>再分配・大きな政府</div>\n        <div style={{ ...axisLabel, right: 5, top: \"50%\", transform: \"translateY(-50%)\", maxWidth: \"42%\", textAlign: \"right\" }}>市場競争・小さな政府</div>\n        <div style={{ ...axisLabel, left: \"50%\", top: 5, transform: \"translateX(-50%)\", textAlign: \"center\", maxWidth: \"72%\" }}>伝統・治安・安全保障重視</div>\n        <div style={{ ...axisLabel, left: \"50%\", bottom: 5, transform: \"translateX(-50%)\", textAlign: \"center\", maxWidth: \"72%\" }}>市民的自由・権利拡張</div>\n        {(points || []).map((p, i) => (\n          <div key={i} title={p.g + \" / 経済\" + p.e + \" 社会\" + p.s} style={{\n            position: \"absolute\",\n            left: \"calc(\" + px(p.e) + \"% - 4px)\",\n            top: \"calc(\" + (100 - px(p.s)) + \"% - 4px)\",\n            width: 8, height: 8, borderRadius: 99,\n            background: SUP_COLORS[p.g] || C.gray, opacity: 0.75\n          }} />\n        ))}\n        {avgPt ? (\n          <div title={\"全体平均 / 経済\" + Math.round(avgPt.e) + \" 社会\" + Math.round(avgPt.s)} style={{\n            position: \"absolute\",\n            left: \"calc(\" + px(avgPt.e) + \"% - 7px)\",\n            top: \"calc(\" + (100 - px(avgPt.s)) + \"% - 7px)\",\n            width: 14, height: 14, borderRadius: 99, border: \"2px solid \" + C.ink, background: C.card\n          }} />\n        ) : null}\n        {me ? (\n          <div title={\"あなた / 経済\" + Math.round(me.e) + \" 社会\" + Math.round(me.s)} style={{\n            position: \"absolute\",\n            left: \"calc(\" + px(me.e) + \"% - 7px)\",\n            top: \"calc(\" + (100 - px(me.s)) + \"% - 7px)\",\n            width: 14, height: 14, borderRadius: 99, background: C.green, border: \"2px solid #fff\", boxShadow: \"0 0 0 1px \" + C.green\n          }} />\n        ) : null}\n      </div>\n      {confidenceValue == null ? null : (\n        <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>推定確信度 {confidenceValue}%（{confidenceLabel}） — 根拠量と一貫性の目安で、正しさの確率ではありません。</div>\n      )}\n    </div>\n  );\n}\n`;

ui = replaceRegexOnce(
  ui,
  /function IdeoMap\(\{ points, me, avgPt, height \}\) \{[\s\S]*?\n\}\n(?=function )/u,
  newIdeoMap,
  "replace ideology map"
);

ui = replaceOnce(
  ui,
  `function Eyebrow({ children }) {\n`,
  `function IdeologyReading({ ideology, attrs }) {\n  if (!ideology) return null;\n  const econ = Number(ideology.econ || 0);\n  const soc = Number(ideology.soc || 0);\n  const econText = econ <= -15 ? \"再分配・大きな政府寄り\" : econ >= 15 ? \"市場競争・小さな政府寄り\" : \"経済軸は中央付近\";\n  const socText = soc <= -15 ? \"市民的自由・権利拡張寄り\" : soc >= 15 ? \"伝統・治安・安全保障寄り\" : \"社会軸は中央付近\";\n  const interests = Array.isArray(attrs) ? attrs.slice(0, 4).filter(Boolean) : [];\n  return (\n    <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.65, marginTop: 8 }}>\n      <div><b style={{ color: C.ink }}>座標の読み方:</b> {econText} / {socText}</div>\n      <div>推定は保存済みアンケート回答と自由記述全体を参照します。中央付近は中立だけでなく、根拠不足や複数方向の相殺も含みます。</div>\n      {interests.length ? <div>解析で抽出された主な関心領域: {interests.join(\"・\")}</div> : null}\n    </div>\n  );\n}\n\nfunction AnalysisValueTrace({ trace }) {\n  if (!trace) return null;\n  const fmt = value => Number.isFinite(Number(value)) ? String(Number(value)) : \"—\";\n  const row = (label, snapshot) => {\n    const params = snapshot && snapshot.params || {};\n    const emotion = params.emo || {};\n    const ideology = snapshot && snapshot.ideology || {};\n    return <div style={{ padding: \"3px 0\" }}><b>{label}</b>: 感情 {fmt(emotion.pol)} / 妥当性 {fmt(params.valid)} / 切実度 {fmt(params.crit)} / 意欲 {fmt(params.motiv)} / 経済 {fmt(ideology.econ)} / 社会 {fmt(ideology.soc)} / 確信度 {fmt(ideology.confidence)}</div>;\n  };\n  const sourceLabel = trace.source === \"workers-ai\" ? \"Workers AI\" : trace.source === \"rules-fallback\" ? \"規則fallback\" : \"不明\";\n  return (\n    <details style={{ marginTop: 10, padding: \"8px 10px\", background: C.soft, borderRadius: 4, fontSize: 10.5, color: C.sub }}>\n      <summary style={{ cursor: \"pointer\", fontWeight: 700, color: C.ink }}>解析値の診断 — revision {trace.responseRevision} / {sourceLabel}</summary>\n      <div style={{ marginTop: 6 }}>本文やAIの生テキストは保存せず、数値だけを追跡します。</div>\n      {row(trace.source === \"workers-ai\" ? \"AI生値\" : \"fallback生成値\", trace.raw)}\n      {row(\"Worker正規化\", trace.sanitized)}\n      {row(\"D1 / API取得値\", trace.api)}\n      {row(\"UI表示値\", trace.ui)}\n    </details>\n  );\n}\n\nfunction Eyebrow({ children }) {\n`,
  "insert ideology and trace explanation components"
);

ui = replaceExactCount(
  ui,
  `          <IdeoMap me={{ e: an.ideology.econ, s: an.ideology.soc }} avgPt={avgPt} points={[]} height={190} />\n          <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>● あなた / ◯ 全体平均(解析済み {result.agg.ideology.n}件)</div>\n`,
  `          <IdeoMap me={{ e: an.ideology.econ, s: an.ideology.soc }} avgPt={avgPt} points={[]} height={190} confidence={an.ideology.confidence} />\n          <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>● あなた / ◯ 全体平均(解析済み {result.agg.ideology.n}件)</div>\n          <IdeologyReading ideology={an.ideology} attrs={an.attrs} />\n`,
  2,
  "improve personal ideology cards"
);

ui = replaceOnce(
  ui,
  `        <IdeoMap points={agg.ideology.points} avgPt={avgPt} height={250} />\n        <div style={{ display: \"flex\", gap: 10, flexWrap: \"wrap\", marginTop: 10 }}>\n`,
  `        <IdeoMap points={agg.ideology.points} avgPt={avgPt} height={250} />\n        <div style={{ fontSize: 11, color: C.sub, marginTop: 7 }}>横軸は経済政策、縦軸は社会・権利観です。◯は解析済み回答の全体平均。点の色は思想分類ではなく、政権支持の回答を表します。</div>\n        <div style={{ display: \"flex\", gap: 10, flexWrap: \"wrap\", marginTop: 10 }}>\n`,
  "explain aggregate ideology map"
);

ui = replaceOnce(
  ui,
  `              括弧内は全体平均です。数値は規則解析の推定であり、正確性を保証するものではありません。\n`,
  `              括弧内は全体平均です。数値はAI解析または規則fallbackによる推定であり、正確性を保証するものではありません。\n`,
  "fix analysis source copy"
);

ui = replaceOnce(
  ui,
  `              <Badge>イデオロギー: 経済 {an.ideology.econ} / 社会 {an.ideology.soc}</Badge>\n`,
  `              <Badge>イデオロギー: 経済 {an.ideology.econ} / 社会 {an.ideology.soc}</Badge>\n              {Number.isFinite(Number(an.ideology.confidence)) ? <Badge>推定確信度: {Math.round(an.ideology.confidence)}%</Badge> : null}\n`,
  "show ideology confidence on own response"
);

ui = replaceOnce(
  ui,
  `            </div>\n            {/* MeterBar が受け取るのは value。v では届かず、clamp(undefined) が\n`,
  `            </div>\n            <IdeologyReading ideology={an.ideology} attrs={an.attrs} />\n            {analysisDiagnosticsVisible() && r.analysisValueTrace ? <AnalysisValueTrace trace={r.analysisValueTrace} /> : null}\n            {/* MeterBar が受け取るのは value。v では届かず、clamp(undefined) が\n`,
  "show explanation and trace on own response"
);

write("core/ui.jsx", ui);

let analysis = read("cloudflare/src/analysis.mjs");

analysis = replaceOnce(
  analysis,
  `export function sanitizeAiAnalysis(value, freeText) {\n`,
  `export function analysisValueSnapshot(value) {\n  const params = value && value.params || {};\n  const emotion = params && params.emo || {};\n  const ideology = value && value.ideology || {};\n  const finite = input => {\n    const number = Number(input);\n    return Number.isFinite(number) ? number : null;\n  };\n  return {\n    params: {\n      emo: { pol: finite(emotion.pol) },\n      valid: finite(params.valid),\n      crit: finite(params.crit),\n      motiv: finite(params.motiv)\n    },\n    ideology: {\n      econ: finite(ideology.econ),\n      soc: finite(ideology.soc),\n      confidence: finite(ideology.confidence)\n    }\n  };\n}\n\nexport function withAnalysisValueTrace(analysis, rawValues, responseRevision, source) {\n  if (!analysis || typeof analysis !== \"object\") return analysis;\n  return {\n    ...analysis,\n    diagnostics: {\n      ...(analysis.diagnostics && typeof analysis.diagnostics === \"object\" ? analysis.diagnostics : {}),\n      valueTrace: {\n        version: 1,\n        responseRevision: Number(responseRevision || 0),\n        source: source === \"rules-fallback\" ? \"rules-fallback\" : \"workers-ai\",\n        raw: analysisValueSnapshot(rawValues),\n        sanitized: analysisValueSnapshot(analysis)\n      }\n    }\n  };\n}\n\nexport function sanitizeAiAnalysis(value, freeText) {\n`,
  "insert worker value trace helpers"
);

analysis = replaceOnce(
  analysis,
  `      return { analysis, attempts: attempt };\n`,
  `      return { analysis, attempts: attempt, rawValues: analysisValueSnapshot(parsed) };\n`,
  "return raw AI numeric values"
);

analysis = replaceOnce(
  analysis,
  `    const result = await requestAiAnalysis(env, model, record, freeText);\n    return finish(result.analysis, {\n`,
  `    const result = await requestAiAnalysis(env, model, record, freeText);\n    const analysis = withAnalysisValueTrace(result.analysis, result.rawValues, revision, \"workers-ai\");\n    return finish(analysis, {\n`,
  "persist AI trace with current revision"
);

analysis = replaceOnce(
  analysis,
  `    const analysis = fallbackAnalysis(freeText);\n    const outcome = await finish(analysis, {\n`,
  `    const fallback = fallbackAnalysis(freeText);\n    const analysis = withAnalysisValueTrace(fallback, analysisValueSnapshot(fallback), revision, \"rules-fallback\");\n    const outcome = await finish(analysis, {\n`,
  "persist fallback trace with current revision"
);

write("cloudflare/src/analysis.mjs", analysis);

const contractTest = `import assert from \"node:assert/strict\";\nimport { readFileSync } from \"node:fs\";\nimport test from \"node:test\";\n\nconst ui = readFileSync(new URL(\"../core/ui.jsx\", import.meta.url), \"utf8\");\nconst analysis = readFileSync(new URL(\"../cloudflare/src/analysis.mjs\", import.meta.url), \"utf8\");\n\ntest(\"response correction routes enter dedicated editors directly\", () => {\n  assert.match(ui, /surveyEdit: \\\"\\/survey\\/edit-initial\\\"/u);\n  assert.match(ui, /followupEdit: \\\"\\/survey\\/follow-up\\/edit\\\"/u);\n  assert.match(ui, /goto\\(\\\"followupEdit\\\"\\).*2回目の回答を修正/u);\n  assert.match(ui, /goto\\(\\\"surveyEdit\\\"\\).*初回回答を修正/u);\n  assert.match(ui, /startEditMode=\\{view === \\\"surveyEdit\\\"/u);\n  assert.match(ui, /editExisting=\\{view === \\\"followupEdit\\\"/u);\n});\n\ntest(\"withdrawal copy distinguishes second-only withdrawal from full response withdrawal\", () => {\n  assert.match(ui, /初回だけの撤回は行わず、初回を撤回する場合は回答全体を撤回します/u);\n  assert.match(ui, /回答全体を撤回する/u);\n});\n\ntest(\"analysis trace keeps numeric stages and never stores raw model text\", () => {\n  assert.match(analysis, /withAnalysisValueTrace/u);\n  assert.match(analysis, /raw: analysisValueSnapshot\\(rawValues\\)/u);\n  assert.match(analysis, /sanitized: analysisValueSnapshot\\(analysis\\)/u);\n  assert.doesNotMatch(analysis, /diagnostics:[\\s\\S]{0,500}(output_text|choices|message\\.content)/u);\n  assert.match(ui, /D1 \\/ API取得値/u);\n  assert.match(ui, /UI表示値/u);\n});\n\ntest(\"ideology map explains both axes and confidence\", () => {\n  assert.match(ui, /再分配・大きな政府/u);\n  assert.match(ui, /市場競争・小さな政府/u);\n  assert.match(ui, /伝統・治安・安全保障重視/u);\n  assert.match(ui, /市民的自由・権利拡張/u);\n  assert.match(ui, /推定確信度/u);\n  assert.match(ui, /点の色は思想分類ではなく/u);\n});\n`;
write("tests/response-ux-analysis-trace-contract.test.mjs", contractTest);

const traceUnitTest = `import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { analysisValueSnapshot, fallbackAnalysis, sanitizeAiAnalysis, withAnalysisValueTrace } from \"../src/analysis.mjs\";\n\nfunction rawAi() {\n  return {\n    params: { emo: { pol: -0.37, label: \"不満\" }, valid: 63.4, crit: 71.6, motiv: 58.2 },\n    ideology: { econ: -47.2, soc: 33.7, confidence: 66.6 },\n    attrs: [\"税制\"],\n    chunks: [{ s: \"税制を見直してほしい\", cat: \"要望\", topic: \"税制\", tt: \"政府全般\", tn: \"\", emo: -0.37, crit: 71.6, fact: \"意見\" }]\n  };\n}\n\ntest(\"AI value trace proves sanitizer rounds to integers without ten-step quantization\", () => {\n  const raw = rawAi();\n  const normalized = sanitizeAiAnalysis(raw, \"税制を見直してほしい。\");\n  const traced = withAnalysisValueTrace(normalized, analysisValueSnapshot(raw), 7, \"workers-ai\");\n  assert.equal(traced.diagnostics.valueTrace.responseRevision, 7);\n  assert.equal(traced.diagnostics.valueTrace.source, \"workers-ai\");\n  assert.equal(traced.diagnostics.valueTrace.raw.params.valid, 63.4);\n  assert.equal(traced.diagnostics.valueTrace.sanitized.params.valid, 63);\n  assert.equal(traced.diagnostics.valueTrace.sanitized.params.crit, 72);\n  assert.equal(traced.diagnostics.valueTrace.sanitized.params.motiv, 58);\n  assert.notEqual(traced.diagnostics.valueTrace.sanitized.params.valid % 10, 0);\n  assert.equal(JSON.stringify(traced.diagnostics).includes(\"税制を見直してほしい\"), false);\n});\n\ntest(\"fallback trace is explicitly distinguished from Workers AI\", () => {\n  const fallback = fallbackAnalysis(\"累進課税を導入し、社会保障を拡充すべきだ。\");\n  const traced = withAnalysisValueTrace(fallback, analysisValueSnapshot(fallback), 3, \"rules-fallback\");\n  assert.equal(traced.diagnostics.valueTrace.source, \"rules-fallback\");\n  assert.deepEqual(traced.diagnostics.valueTrace.raw, traced.diagnostics.valueTrace.sanitized);\n});\n`;
write("cloudflare/tests/analysis-value-trace.test.mjs", traceUnitTest);

console.log("Applied response UX, analysis value tracing, and ideology explainability changes");
