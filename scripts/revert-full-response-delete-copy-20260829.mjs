import fs from "node:fs";

const uiPath = "core/ui.jsx";
const testPath = "tests/response-ux-analysis-trace-contract.test.mjs";

let ui = fs.readFileSync(uiPath, "utf8");
const replacements = [
  [
    "初回回答はアンケートと1回目自由記述を一緒に修正します。2回目は独立して修正・撤回できます。初回だけの撤回は行わず、初回を撤回する場合は回答全体を撤回します。",
    "初回回答はアンケートと1回目自由記述を一緒に修正します。2回目は独立して修正・撤回できます。"
  ],
  ["回答全体を撤回する", "回答、解析結果を削除する"]
];
for (const [from, to] of replacements) {
  const count = ui.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one UI match for ${from}, got ${count}`);
  ui = ui.replace(from, to);
}
fs.writeFileSync(uiPath, ui, "utf8");

let test = fs.readFileSync(testPath, "utf8");
const oldBlock = `test("withdrawal copy distinguishes second-only withdrawal from full response withdrawal", () => {\n  assert.ok(ui.includes("初回だけの撤回は行わず、初回を撤回する場合は回答全体を撤回します"));\n  assert.ok(ui.includes("回答全体を撤回する"));\n});`;
const newBlock = `test("second-only withdrawal remains distinct from full response and analysis deletion", () => {\n  assert.ok(ui.includes("2回目を撤回"));\n  assert.ok(ui.includes("回答、解析結果を削除する"));\n  assert.ok(!ui.includes("回答全体を撤回する"));\n  assert.ok(!ui.includes("初回を撤回する場合は回答全体を撤回"));\n});`;
if (!test.includes(oldBlock)) throw new Error("old delete-copy contract block not found");
test = test.replace(oldBlock, newBlock);
fs.writeFileSync(testPath, test, "utf8");

console.log("Restored full response delete wording");
