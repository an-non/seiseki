import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../local/public/model/local.js", import.meta.url), "utf8");
const { Local } = vm.runInNewContext(source + "\nSeisekiLocal;", { Array, Math, String });

function createLocal() {
  const tokenizer = { encode: () => [] };
  const encoder = { dim: 1, embed: () => [0] };
  const head = {
    dim: 1,
    cats: ["評価"],
    cat: { "評価": [0, 1] },
    pol: [0, 0], valid: [0, 0.5], crit: [0, 0.5], motiv: [0, 0.5]
  };
  return new Local(tokenizer, encoder, head);
}

function chunkLibrary(text) {
  return {
    split: () => [text],
    findTarget: () => ({ tt: "その他", tn: "" }),
    findTopic: () => "その他",
    factOf: () => "意見",
    allTopics: () => [],
    emoLabel: () => "中立"
  };
}

test("local analysis preserves node text instead of cutting it at 25 characters", () => {
  const text = "ローカル解析でも分割された意見本文をそのまま保持し、表示上の折りたたみとは分離して扱う。";
  const result = createLocal().analyzeResponse(text, chunkLibrary(text), 5);
  assert.equal(result.chunks[0].s, text);
});

test("local analysis marks only the 160-code-point safety cap", () => {
  const text = "あ".repeat(180);
  const result = createLocal().analyzeResponse(text, chunkLibrary(text), 5);
  assert.equal(Array.from(result.chunks[0].s).length, 160);
  assert.equal(result.chunks[0].s.endsWith("…"), true);
});
