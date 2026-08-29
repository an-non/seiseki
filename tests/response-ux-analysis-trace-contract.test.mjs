import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");
const analysis = readFileSync(new URL("../cloudflare/src/analysis.mjs", import.meta.url), "utf8");

test("response correction routes enter dedicated editors directly", () => {
  assert.ok(ui.includes('surveyEdit: "/survey/edit-initial"'));
  assert.ok(ui.includes('followupEdit: "/survey/follow-up/edit"'));
  assert.ok(ui.includes('goto("followupEdit")'));
  assert.ok(ui.includes("2回目の回答を修正"));
  assert.ok(ui.includes('goto("surveyEdit")'));
  assert.ok(ui.includes('startEditMode={view === "surveyEdit"'));
  assert.ok(ui.includes('editExisting={view === "followupEdit"'));
});

test("second-only withdrawal remains distinct from full response and analysis deletion", () => {
  assert.ok(ui.includes("2回目を撤回"));
  assert.ok(ui.includes("回答、解析結果を削除する"));
  assert.ok(!ui.includes("回答全体を撤回する"));
  assert.ok(!ui.includes("初回を撤回する場合は回答全体を撤回"));
});

test("analysis trace keeps numeric stages and never stores raw model text", () => {
  assert.ok(analysis.includes("withAnalysisValueTrace"));
  assert.ok(analysis.includes("raw: analysisValueSnapshot(rawValues)"));
  assert.ok(analysis.includes("sanitized: analysisValueSnapshot(analysis)"));
  assert.ok(ui.includes("D1 / API取得値"));
  assert.ok(ui.includes("UI表示値"));
  const traceHelperStart = analysis.indexOf("export function withAnalysisValueTrace");
  const traceHelperEnd = analysis.indexOf("export function sanitizeAiAnalysis", traceHelperStart);
  const traceHelper = analysis.slice(traceHelperStart, traceHelperEnd);
  assert.ok(!traceHelper.includes("output_text"));
  assert.ok(!traceHelper.includes("message.content"));
  assert.ok(!traceHelper.includes("choices"));
});

test("ideology map explains both axes and confidence", () => {
  assert.ok(ui.includes("再分配・大きな政府"));
  assert.ok(ui.includes("市場競争・小さな政府"));
  assert.ok(ui.includes("伝統・治安・安全保障重視"));
  assert.ok(ui.includes("市民的自由・権利拡張"));
  assert.ok(ui.includes("推定確信度"));
  assert.ok(ui.includes("点の色は思想分類ではなく"));
});
