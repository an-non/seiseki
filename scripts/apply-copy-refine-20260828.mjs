import { readFileSync, writeFileSync } from "node:fs";

const path = "core/ui.jsx";
let ui = readFileSync(path, "utf8");

function replaceOnce(from, to) {
  const count = ui.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, found ${count}: ${from}`);
  ui = ui.replace(from, to);
}

replaceOnce(
  '<Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述</Btn>',
  '<Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述、修正</Btn>'
);

replaceOnce(
  '<div style={{ marginTop: 14 }}><Btn kind="ghost" onClick={() => goto("mine")}>自分の回答を確認</Btn></div>',
  '<div style={{ marginTop: 14 }}><Btn kind="ghost" onClick={() => goto("mine")}>自分の回答、設定の確認</Btn></div>'
);

const myResponseTitle = '>自分の回答</H2>';
const titleCount = ui.split(myResponseTitle).length - 1;
if (titleCount !== 4) throw new Error(`${path}: expected four MY RESPONSE titles, found ${titleCount}`);
ui = ui.replaceAll(myResponseTitle, '>マイレスポンス確認・修正</H2>');

writeFileSync(path, ui, "utf8");

const testPath = "tests/follow-up-ui-contract.test.mjs";
let tests = readFileSync(testPath, "utf8");
const marker = 'test("survey owns questionnaire correction while account response keeps free-text correction", () => {';
if (!tests.includes(marker)) throw new Error("UI contract marker missing");
if (!tests.includes('test("overview and response labels match the revised navigation", () => {')) {
  tests += "\n" + [
    'test("overview and response labels match the revised navigation", () => {',
    '  assert.ok(ui.includes("書きかけの回答があります。"));',
    '  assert.ok(ui.includes(\'Btn small onClick={() => goto("survey")}>続きから回答する</Btn>\'));',
    '  assert.ok(ui.includes("二度目の自由記述、修正"));',
    '  assert.ok(ui.includes("自分の回答、設定の確認"));',
    '  assert.ok(ui.includes("マイレスポンス確認・修正"));',
    '});',
    ''
  ].join("\n");
}
writeFileSync(testPath, tests, "utf8");

console.log("copy refinement applied");
