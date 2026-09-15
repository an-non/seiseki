import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLegacyPrompt,
  parseAIJson,
  sanitizeAnalysis,
  strictValidateAnalysis,
  summarize
} from "../scripts/run-groq-legacy-comparison.mjs";

const sample = {
  id: "G-test",
  demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
  answers: { q_support: "わからない", q_priority: "その他", q_econ: "3" },
  free: "消費税を下げてほしい。"
};

test("legacy prompt preserves the v0.11.1 request contract", () => {
  const prompt = buildLegacyPrompt(sample);
  assert.match(prompt, /3\/5 \(1=財政支出を拡大し再分配を強化すべき … 5=財政健全化と市場活力を優先すべき\)/u);
  assert.match(prompt, /意見の要約25字以内/u);
  assert.match(prompt, /出力全体を800トークン以内/u);
  assert.doesNotMatch(prompt, /confidence/u);
  assert.doesNotMatch(prompt, /JSON Schema/u);
});

test("legacy parser and sanitizer preserve range and fallback behavior", () => {
  const parsed = parseAIJson('前置き```json\n{"params":{"emo":{"pol":2,"label":"非常に長い感情名"},"valid":120,"crit":-4,"motiv":55.6},"ideology":{"econ":-140,"soc":80},"attrs":["税制"],"chunks":[{"s":"消費税減税","cat":"要望","topic":"税制","tt":"政府全般","tn":"","emo":-2,"crit":101,"fact":"意見"}]}\n```');
  const output = sanitizeAnalysis(parsed);
  assert.deepEqual(output.params, {
    emo: { pol: 1, label: "非常に長い感" },
    valid: 100,
    crit: 0,
    motiv: 56
  });
  assert.deepEqual(output.ideology, { econ: -100, soc: 80 });
  assert.equal(output.chunks[0].emo, -1);
  assert.equal(output.chunks[0].crit, 100);
});

test("summary uses the unchanged evaluation metrics", () => {
  const analysis = sanitizeAnalysis({
    params: { emo: { pol: -0.5, label: "不満" }, valid: 70, crit: 80, motiv: 60 },
    ideology: { econ: -30, soc: 0 }, attrs: [], chunks: []
  });
  const summary = summarize("model", [{
    id: "G-01", validJson: true, validAnalysis: true, attempts: 1, durationMs: 100,
    expected: { pol: -0.56, valid: 76, crit: 82, motiv: 74 }, analysis, usage: { total_tokens: 20 }
  }]);
  assert.deepEqual(summary.mae, { pol: 0.06, valid: 6, crit: 2, motiv: 14 });
  assert.equal(summary.total, 1);
  assert.equal(summary.usage.totalTokens, 20);
});

test("strict validation rejects values the legacy sanitizer would fill", () => {
  const incomplete = {
    params: { emo: { pol: -0.5, label: "不満" }, valid: 70 },
    ideology: { econ: -30, soc: 0 }, attrs: [], chunks: []
  };
  assert.ok(sanitizeAnalysis(incomplete));
  assert.equal(strictValidateAnalysis(incomplete, sample.free), null);
});

test("summary reports production-equivalent strict validity separately", () => {
  const analysis = sanitizeAnalysis({
    params: { emo: { pol: -0.5, label: "不満" }, valid: 70, crit: 80, motiv: 60 },
    ideology: { econ: -30, soc: 0 }, attrs: [], chunks: []
  });
  const summary = summarize("model", [
    { id: "G-01", validJson: true, validAnalysis: true, strictValidAnalysis: true, attempts: 1, durationMs: 10, expected: { pol: -0.5, valid: 70, crit: 80, motiv: 60 }, analysis },
    { id: "G-02", validJson: true, validAnalysis: true, strictValidAnalysis: false, attempts: 1, durationMs: 10, expected: { pol: -0.5, valid: 70, crit: 80, motiv: 60 }, analysis }
  ]);
  assert.equal(summary.validAnalysis, 2);
  assert.equal(summary.strictValidAnalysis, 1);
});
