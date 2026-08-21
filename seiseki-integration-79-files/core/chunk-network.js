/* Independent chunk-level network model. It does not change the topic network. */
function chunkNodeSeed(value) {
  let h = 2166136261;
  for (const ch of String(value)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

function chunkParameterWeight(chunk) {
  const values = [];
  const add = (value, weight) => {
    const n = Number(value);
    if (isFinite(n)) values.push({ value: Math.max(0, Math.min(100, n)) / 100, weight: weight });
  };
  add(chunk && chunk.crit, 0.5);
  add(chunk && chunk.motiv, 0.3);
  add(chunk && chunk.valid, 0.2);
  if (!values.length) return 0;
  let total = 0, weights = 0;
  for (const item of values) { total += item.value * item.weight; weights += item.weight; }
  return weights ? total / weights : 0;
}

function chunkWeightColor(value) {
  const t = Math.max(0, Math.min(1, Number(value) || 0));
  const low = [239, 235, 224], high = [122, 46, 18];
  const rgb = low.map((v, i) => Math.round(v + (high[i] - v) * t));
  return "#" + rgb.map(v => ("0" + v.toString(16)).slice(-2)).join("");
}

/* A small, dependency-free keyword extractor for Japanese chunk text.
   The analyzer already provides topic/category fields, but those are labels
   attached after extraction. Link evidence should also be traceable to the
   original sentence, so the text terms are kept on each node. */
function chunkTextNormalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ja-JP");
}

function chunkContentTerms(value) {
  const text = chunkTextNormalize(value);
  const terms = new Set();
  const addRun = run => {
    if (!run || run.length < 2) return;
    terms.add(run);
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  };
  for (const run of text.match(/[一-龯々〆ヵヶ]+/g) || []) addRun(run);
  for (const run of text.match(/[ァ-ヶー]{2,}/g) || []) addRun(run);
  for (const run of text.match(/[a-z0-9]{2,}/gi) || []) terms.add(run);
  return [...terms];
}

function chunkContentRelation(a, b) {
  const aText = chunkTextNormalize(a.text);
  const bText = chunkTextNormalize(b.text);
  const aTerms = new Set(a.contentTerms || chunkContentTerms(a.text));
  const bTerms = new Set(b.contentTerms || chunkContentTerms(b.text));
  const sharedTerms = [...aTerms].filter(term => bTerms.has(term) && term.length >= 2);
  if (!sharedTerms.length && aText !== bText) return null;
  const unionSize = new Set([...aTerms, ...bTerms]).size || 1;
  const coverage = sharedTerms.length / Math.max(1, Math.min(aTerms.size, bTerms.size));
  const breadth = sharedTerms.length / unionSize;
  const score = aText === bText && aText.length >= 4
    ? 0.82
    : 0.48 + 0.12 * Math.min(1, coverage) + 0.08 * Math.min(1, breadth);
  return { score: score, terms: sharedTerms.sort((x, y) => y.length - x.length || x.localeCompare(y)).slice(0, 4) };
}

function chunkLinkColor(kind) {
  return ({ content: "#175e54", topic: "#3d5573", target: "#a8700f", category: "#a3512b", fact: "#8a8677" })[kind] || "#3d5573";
}

function chunkNetwork(agg, maxChunks) {
  const source = (agg && Array.isArray(agg.opinions)) ? agg.opinions : [];
  const candidates = source.map((chunk, index) => {
    const text = String(chunk && (chunk.s || chunk.text) || "").trim();
    if (!text) return null;
    const emo = Number(chunk.emo);
    const crit = Number(chunk.crit);
    const target = [chunk.tt, chunk.tn].map(v => String(v || "").trim()).filter(Boolean).join("|");
    return {
      id: String(chunk.id || chunk.rid || "chunk") + "-" + index,
      text: text,
      s: text,
      topic: String(chunk.topic || "").trim(),
      cat: String(chunk.cat || "").trim(),
      target: target,
      tt: String(chunk.tt || "").trim(),
      tn: String(chunk.tn || "").trim(),
      emo: isFinite(emo) ? Math.max(-1, Math.min(1, emo)) : 0,
      crit: isFinite(crit) ? Math.max(0, Math.min(100, crit)) : 0,
      valid: Number(chunk.valid),
      motiv: Number(chunk.motiv),
      fact: String(chunk.fact || "").trim(),
      contentTerms: chunkContentTerms(text),
      ts: Number(chunk.ts) || 0,
      sup: String(chunk.sup || "").trim()
    };
  }).filter(Boolean);

  const limit = maxChunks === undefined || maxChunks === null || maxChunks === Infinity
    ? candidates.length
    : (maxChunks > 0 ? maxChunks : 0);
  const nodes = candidates.slice(0, limit);
  const links = [];
  const degree = {};

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const relations = [];
      let score = 0;
      const add = (kind, label, weight, detail) => {
        score += weight;
        relations.push({ kind: kind, label: label, detail: detail || "", weight: weight });
      };
      const content = chunkContentRelation(a, b);
      if (content) add("content", "本文の共通語", content.score, content.terms.join("・"));
      if (a.topic && a.topic === b.topic) add("topic", "同じトピック", 0.24);
      if (a.target && a.target === b.target) add("target", "同じ対象", 0.14);
      if (a.cat && a.cat === b.cat) add("category", "同じ分類", 0.08);
      if (a.fact && a.fact === b.fact) add("fact", "同じ性質", 0.04);
      if (score < 0.24) continue;
      relations.sort((x, y) => y.weight - x.weight || x.kind.localeCompare(y.kind));
      const link = {
        a: a.id, b: b.id, n: Math.round(score * 100), weight: score,
        primary: relations[0] ? relations[0].kind : "topic",
        sharedTerms: relations.filter(r => r.kind === "content").flatMap(r => r.detail ? r.detail.split("・") : []),
        relations: relations,
        reasons: relations.map(r => r.detail ? r.label + ": " + r.detail : r.label)
      };
      links.push(link);
      degree[a.id] = (degree[a.id] || 0) + 1;
      degree[b.id] = (degree[b.id] || 0) + 1;
    }
  }

  const weightedNodes = nodes.map(node => ({ ...node, degree: degree[node.id] || 0, weight: chunkParameterWeight(node) }));
  let minWeight = 1, maxWeight = 0;
  for (const node of weightedNodes) { minWeight = Math.min(minWeight, node.weight); maxWeight = Math.max(maxWeight, node.weight); }
  const weightSpan = maxWeight - minWeight;
  const displayNodes = weightedNodes.map(node => ({
    ...node,
    weightView: weightSpan > 1e-9 ? (node.weight - minWeight) / weightSpan : 0.5
  }));

  return {
    nodes: displayNodes,
    links: links.sort((a, b) => b.weight - a.weight || a.a.localeCompare(b.a))
  };
}

function chunkNetworkLayout(nodes, cx, cy, rMin, rMax) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return [];
  const topics = [];
  const seen = {};
  for (const node of list) {
    const key = node.topic || "その他";
    if (!seen[key]) { seen[key] = true; topics.push(key); }
  }
  topics.sort();
  return list.map((node, index) => {
    const topic = node.topic || "その他";
    const slot = Math.PI * 2 / Math.max(1, list.length);
    const angleJitter = (chunkNodeSeed(node.id + "|angle") - 0.5) * Math.min(0.36, slot * 0.72);
    const centrality = Math.max(0, Math.min(1, Number(node.weightView === undefined ? node.weight : node.weightView) || 0));
    const centerGap = Math.max(30, Number(rMin) || 42);
    const radialJitter = (chunkNodeSeed(node.id + "|radius") - 0.5) * 32;
    const distanceRatio = Math.pow(1 - centrality, 1.35);
    const r = Math.max(centerGap - 12, Math.min(rMax, centerGap + distanceRatio * (rMax - centerGap) + radialJitter));
    const angle = -Math.PI / 2 + index * slot + angleJitter;
    return { ...node, centrality, dist: r, angle, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
}
