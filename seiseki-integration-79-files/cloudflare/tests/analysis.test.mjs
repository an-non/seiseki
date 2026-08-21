import assert from "node:assert/strict";
import test from "node:test";
import { fallbackAnalysis, sanitizeAiAnalysis } from "../src/analysis.mjs";

function aiResult(overrides = {}) {
  return {
    params: { emo: { pol: -0.4, label: "不満" }, valid: 91, crit: 84, motiv: 77 },
    ideology: { econ: -78, soc: 64, confidence: 88 },
    attrs: ["税制", "防衛"],
    chunks: [{
      s: "富裕層への累進課税と防衛力強化を求める",
      cat: "提言",
      topic: "税制",
      tt: "政府全般",
      tn: "",
      emo: -0.4,
      crit: 84,
      fact: "意見"
    }],
    ...overrides
  };
}

test("AI scores and explicit policy-position coordinates are preserved without centering blend", () => {
  const analysis = sanitizeAiAnalysis(aiResult(), "累進課税と防衛力強化を求める。AIの判定値を規則値へ混ぜない。");
  assert.deepEqual(analysis.params, {
    emo: { pol: -0.4, label: "不満" }, valid: 91, crit: 84, motiv: 77
  });
  assert.deepEqual(analysis.ideology, { econ: -78, soc: 64, confidence: 88 });
});

test("AI ideology coordinates are not overridden by a local social-axis gate", () => {
  const analysis = sanitizeAiAnalysis(aiResult(), "富裕税と累進課税を導入し、社会保障を拡充すべきだ。");
  assert.equal(analysis.ideology.econ, -78);
  assert.equal(analysis.ideology.soc, 64);
});

test("missing AI confidence is derived from explicit policy evidence without moving AI coordinates", () => {
  const analysis = sanitizeAiAnalysis(aiResult({
    ideology: { econ: -63, soc: 0 }
  }), "富裕税と累進課税を導入すべきだ。");
  assert.equal(analysis.ideology.econ, -63);
  assert.equal(analysis.ideology.soc, 0);
  assert.ok(analysis.ideology.confidence > 0);
});

test("valid AI chunks are preserved without deterministic replacement", () => {
  const analysis = sanitizeAiAnalysis(aiResult({
    chunks: [{
      s: "複数の政策をまとめて改善する",
      cat: "提言", topic: "政治・行政", tt: "政府全般", tn: "", emo: 0, crit: 60, fact: "意見"
    }]
  }), "消費税を減税すべきだ。最低賃金を引き上げてほしい。防衛費を増やすべきだ。選択的夫婦別姓を認めてほしい。");
  assert.equal(analysis.chunks.length, 1);
  assert.deepEqual(analysis.chunks.map(chunk => chunk.topic), ["政治・行政"]);
});

test("an explicit empty AI chunk list is preserved", () => {
  const sentence = "教育費の負担軽減を求める。学習環境を改善してほしい。";
  const analysis = sanitizeAiAnalysis(aiResult({ chunks: [] }), sentence.repeat(100).slice(0, 1500));
  assert.equal(analysis.chunks.length, 0);
});

test("incomplete AI scores are rejected instead of becoming midpoint values", () => {
  const invalid = aiResult({ params: { emo: { pol: 0, label: "中立" }, valid: 60, crit: 80 } });
  assert.equal(sanitizeAiAnalysis(invalid, "教育制度を改善してほしい。"), null);
});

test("fallback distinguishes redistribution and market-oriented policy demands", () => {
  const left = fallbackAnalysis("富裕税と累進課税を導入し、社会保障を拡充すべきだ。");
  const right = fallbackAnalysis("規制緩和と民営化、法人税を下げて市場競争を促進すべきだ。");
  assert.ok(left.ideology.econ < 0);
  assert.ok(right.ideology.econ > 0);
  assert.ok(left.ideology.confidence > 0);
  assert.ok(right.ideology.confidence > 0);
});

test("fallback keeps separate sentences as separate opinion chunks up to five", () => {
  const analysis = fallbackAnalysis(
    "消費税を減税すべきだ。最低賃金を引き上げてほしい。防衛費を増やすべきだ。選択的夫婦別姓を認めてほしい。原発政策を見直すべきだ。道路も整備してほしい。"
  );
  assert.equal(analysis.chunks.length, 5);
  assert.deepEqual(analysis.chunks.map(chunk => chunk.topic), ["税制", "雇用・労働", "防衛・安全保障", "憲法・人権", "エネルギー"]);
});
