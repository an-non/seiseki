import assert from "node:assert/strict";
import test from "node:test";
import { measureAnalysisOutput, summarizeNumbers } from "../scripts/measure-analysis-output.mjs";

test("analysis output observer keeps response and chunk metrics separate", () => {
  const report = measureAnalysisOutput([
    {
      params: { valid: 70, crit: 61, motiv: 55 },
      chunks: [
        { s: "自然に終わる。", crit: 20, emo: -0.2, cat: "評価", tt: "政府全般", topic: "行政" },
        { s: "表示上で省略される…", crit: 35, emo: 0.1, cat: "提言", tt: "政府全般", topic: "行政" }
      ]
    },
    {
      params: { valid: 73, crit: 62, motiv: 58 },
      chunks: [{ s: "句点なし", crit: 41, emo: 0.4, cat: "評価", tt: "企業", topic: "経済" }]
    }
  ]);
  assert.equal(report.counts.analyses, 2);
  assert.equal(report.counts.chunks, 3);
  assert.equal(report.responseScores.crit.count, 2);
  assert.equal(report.chunkScores.crit.count, 3);
  assert.equal(report.nodeText.hardSentenceEnd, 1);
  assert.equal(report.nodeText.ellipsisEnd, 1);
  assert.equal(report.nodeText.otherEnd, 1);
  assert.equal(report.metadata.authoritative, false);
});

test("score granularity buckets are exclusive", () => {
  const result = summarizeNumbers([20, 25, 27, 30]);
  assert.deepEqual(result.buckets, { tens: 2, fiveOnly: 1, other: 1 });
});
