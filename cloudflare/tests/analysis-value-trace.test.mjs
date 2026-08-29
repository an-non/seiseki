import assert from "node:assert/strict";
import test from "node:test";
import { analysisValueSnapshot, fallbackAnalysis, sanitizeAiAnalysis, withAnalysisValueTrace } from "../src/analysis.mjs";

function rawAi() {
  return {
    params: { emo: { pol: -0.37, label: "不満" }, valid: 63.4, crit: 71.6, motiv: 58.2 },
    ideology: { econ: -47.2, soc: 33.7, confidence: 66.6 },
    attrs: ["税制"],
    chunks: [{ s: "税制を見直してほしい", cat: "要望", topic: "税制", tt: "政府全般", tn: "", emo: -0.37, crit: 71.6, fact: "意見" }]
  };
}

test("AI value trace proves sanitizer rounds to integers without ten-step quantization", () => {
  const raw = rawAi();
  const normalized = sanitizeAiAnalysis(raw, "税制を見直してほしい。");
  const traced = withAnalysisValueTrace(normalized, analysisValueSnapshot(raw), 7, "workers-ai");
  assert.equal(traced.diagnostics.valueTrace.responseRevision, 7);
  assert.equal(traced.diagnostics.valueTrace.source, "workers-ai");
  assert.equal(traced.diagnostics.valueTrace.raw.params.valid, 63.4);
  assert.equal(traced.diagnostics.valueTrace.sanitized.params.valid, 63);
  assert.equal(traced.diagnostics.valueTrace.sanitized.params.crit, 72);
  assert.equal(traced.diagnostics.valueTrace.sanitized.params.motiv, 58);
  assert.notEqual(traced.diagnostics.valueTrace.sanitized.params.valid % 10, 0);
  assert.equal(JSON.stringify(traced.diagnostics).includes("税制を見直してほしい"), false);
});

test("fallback trace is explicitly distinguished from Workers AI", () => {
  const fallback = fallbackAnalysis("累進課税を導入し、社会保障を拡充すべきだ。");
  const traced = withAnalysisValueTrace(fallback, analysisValueSnapshot(fallback), 3, "rules-fallback");
  assert.equal(traced.diagnostics.valueTrace.source, "rules-fallback");
  assert.deepEqual(traced.diagnostics.valueTrace.raw, traced.diagnostics.valueTrace.sanitized);
});
