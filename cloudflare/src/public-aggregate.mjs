const ANCHOR_QID = "q_support";

function inc(obj, key, amount = 1) {
  obj[key] = (obj[key] || 0) + amount;
}

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : (min + max) / 2;
}

function jstDateKey(ts) {
  const n = Number(ts);
  return new Date((Number.isFinite(n) ? n : Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function emptyAggregate() {
  return {
    total: 0,
    demo: { age: {}, gender: {}, region: {}, occupation: {}, party: {} },
    questions: {},
    ideology: { econSum: 0, socSum: 0, n: 0, points: [] },
    topics: {},
    targets: {},
    cross: {},
    series: {},
    rtree: {},
    net: { nodes: {}, links: {} },
    opinions: [],
    updatedAt: Date.now()
  };
}

function safeAnalysis(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || !parsed.params || !parsed.ideology) return null;
  const emo = parsed.params.emo || {};
  const chunks = Array.isArray(parsed.chunks) ? parsed.chunks.slice(0, 6) : [];
  return {
    params: {
      emo: { pol: clamp(emo.pol, -1, 1), label: String(emo.label || "中立").slice(0, 8) },
      valid: clamp(parsed.params.valid, 0, 100),
      crit: clamp(parsed.params.crit, 0, 100),
      motiv: clamp(parsed.params.motiv, 0, 100)
    },
    ideology: {
      econ: clamp(parsed.ideology.econ, -100, 100),
      soc: clamp(parsed.ideology.soc, -100, 100)
    },
    chunks: chunks.map(chunk => ({
      s: String(chunk?.s || "").slice(0, 48),
      cat: String(chunk?.cat || "評価").slice(0, 12),
      topic: String(chunk?.topic || "その他").slice(0, 24),
      tt: String(chunk?.tt || "その他").slice(0, 16),
      tn: String(chunk?.tn || "").slice(0, 40),
      emo: clamp(chunk?.emo, -1, 1),
      crit: clamp(chunk?.crit, 0, 100),
      fact: chunk?.fact === "要検証" ? "要検証" : "意見"
    })).filter(chunk => chunk.s)
  };
}

function mergeAggregate(agg, row, answers) {
  const demo = {
    age: String(row.age || ""), gender: String(row.gender || ""), region: String(row.region || ""),
    occupation: String(row.occupation || ""), party: String(row.party || "")
  };
  agg.total += 1;
  for (const field of Object.keys(demo)) if (demo[field]) inc(agg.demo[field], demo[field]);

  const analysis = safeAnalysis(row.analysisJson);
  const dateKey = jstDateKey(row.createdAt);
  const series = agg.series[dateKey] || (agg.series[dateKey] = { n: 0, an: 0, emo: 0, valid: 0, crit: 0, motiv: 0, chunks: 0, sup: {} });
  series.n += 1;
  const support = String(answers[ANCHOR_QID] || "未回答");
  if (answers[ANCHOR_QID]) inc(series.sup, support);

  for (const [qid, raw] of Object.entries(answers)) {
    const value = String(raw || "");
    if (!value) continue;
    const q = agg.questions[qid] || (agg.questions[qid] = { counts: {}, params: {} });
    inc(q.counts, value);
    for (const field of Object.keys(demo)) {
      if (!demo[field]) continue;
      const cq = agg.cross[qid] || (agg.cross[qid] = {});
      const cf = cq[field] || (cq[field] = {});
      const cv = cf[demo[field]] || (cf[demo[field]] = {});
      inc(cv, value);
    }
    if (analysis) {
      const p = q.params[value] || (q.params[value] = { n: 0, emo: 0, valid: 0, crit: 0, motiv: 0 });
      p.n += 1;
      p.emo += analysis.params.emo.pol;
      p.valid += analysis.params.valid;
      p.crit += analysis.params.crit;
      p.motiv += analysis.params.motiv;
    }
  }

  if (!analysis) return;
  series.an += 1;
  series.emo += analysis.params.emo.pol;
  series.valid += analysis.params.valid;
  series.crit += analysis.params.crit;
  series.motiv += analysis.params.motiv;
  series.chunks += analysis.chunks.length;

  agg.ideology.econSum += analysis.ideology.econ;
  agg.ideology.socSum += analysis.ideology.soc;
  agg.ideology.n += 1;
  if (agg.ideology.points.length < 400) agg.ideology.points.push({ e: analysis.ideology.econ, s: analysis.ideology.soc, g: support });

  const netTopics = [];
  const opinions = [];
  const motivRate = analysis.params.motiv / 100;
  for (const chunk of analysis.chunks) {
    const topic = chunk.topic || "その他";
    const t = agg.topics[topic] || (agg.topics[topic] = { n: 0, cats: {}, emo: 0, crit: 0, ex: [] });
    t.n += 1; inc(t.cats, chunk.cat); t.emo += chunk.emo; t.crit += chunk.crit;
    if (t.ex.length < 3) t.ex.push(chunk.s);

    const targetName = chunk.tn || "(対象名なし)";
    const targetKey = chunk.tt + "|" + targetName;
    const target = agg.targets[targetKey] || (agg.targets[targetKey] = { tt: chunk.tt, tn: targetName, n: 0, emo: 0, crit: 0, cats: {} });
    target.n += 1; target.emo += chunk.emo; target.crit += chunk.crit; inc(target.cats, chunk.cat);

    const rt = agg.rtree[support] || (agg.rtree[support] = { n: 0, topics: {} });
    rt.n += 1;
    const rtp = rt.topics[topic] || (rt.topics[topic] = { n: 0, emo: 0, cats: {} });
    rtp.n += 1; rtp.emo += chunk.emo; inc(rtp.cats, chunk.cat);

    const heat = Math.max(0, -chunk.emo) * (chunk.crit / 100) * motivRate;
    const node = agg.net.nodes[topic] || (agg.net.nodes[topic] = { n: 0, heat: 0, emo: 0 });
    node.n += 1; node.heat += heat; node.emo += chunk.emo;
    if (!netTopics.includes(topic)) netTopics.push(topic);

    opinions.push({
      s: chunk.s, cat: chunk.cat, topic, tt: chunk.tt, tn: chunk.tn,
      emo: chunk.emo, crit: chunk.crit, valid: analysis.params.valid,
      motiv: analysis.params.motiv, fact: chunk.fact, ts: Number(row.createdAt) || 0,
      age: demo.age, region: demo.region, dm: !!row.demoFlag, sup: support
    });
  }
  netTopics.sort();
  for (let i = 0; i < netTopics.length; i += 1) {
    for (let j = i + 1; j < netTopics.length; j += 1) {
      const key = netTopics[i] + "\u001F" + netTopics[j];
      agg.net.links[key] = (agg.net.links[key] || 0) + 1;
    }
  }
  agg.opinions.push(...opinions);
}

export async function getPublicAggregate(db) {
  const [responseRows, answerRows] = await Promise.all([
    db.prepare(`
      SELECT id, created_at AS createdAt, age, gender, region, occupation, party,
             analysis_status AS analysisStatus, analysis_json AS analysisJson, demo_flag AS demoFlag
      FROM responses
      WHERE demo_flag = 0
        AND analysis_status = 'completed'
        AND analysis_json IS NOT NULL
      ORDER BY created_at ASC
    `).all(),
    db.prepare(`
      SELECT a.response_id AS responseId, a.qid, a.value
      FROM answers a
      JOIN responses r ON r.id = a.response_id
      WHERE r.demo_flag = 0
        AND r.analysis_status = 'completed'
        AND r.analysis_json IS NOT NULL
      ORDER BY a.response_id, a.qid
    `).all()
  ]);

  const answersByResponse = new Map();
  for (const row of answerRows.results || []) {
    if (row.qid === "demo_batch") continue;
    const answers = answersByResponse.get(row.responseId) || {};
    answers[String(row.qid)] = String(row.value || "");
    answersByResponse.set(row.responseId, answers);
  }

  const aggregate = emptyAggregate();
  for (const row of responseRows.results || []) mergeAggregate(aggregate, row, answersByResponse.get(row.id) || {});
  aggregate.opinions.sort((a, b) => b.ts - a.ts);
  if (aggregate.opinions.length > 120) aggregate.opinions.length = 120;
  const seriesKeys = Object.keys(aggregate.series).sort();
  for (const key of seriesKeys.slice(0, Math.max(0, seriesKeys.length - 400))) delete aggregate.series[key];
  aggregate.updatedAt = Date.now();
  return aggregate;
}
