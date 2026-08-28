import { readFileSync, writeFileSync } from "node:fs";

const uiPath = "core/ui.jsx";
let ui = readFileSync(uiPath, "utf8");

function replaceOnce(from, to) {
  const count = ui.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one UI anchor, found ${count}: ${from}`);
  ui = ui.replace(from, to);
}

replaceOnce(
  '<Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述、修正</Btn>',
  '<Btn onClick={() => goto("survey")} style={{ flex: "1 1 200px" }}>{session && myId ? "二度目の自由記述、修正" : "最初の回答"}</Btn>'
);

replaceOnce(
  'function MyResponse({ questions, agg, notify, refreshAgg, goto, back, session, onAccountUpdated }) {',
  'function MyResponse({ questions, agg, notify, refreshAgg, goto, back, session, onAccountUpdated, onResponseDeleted }) {'
);

replaceOnce(
  '          <MyResponse questions={questions} agg={agg} notify={notify} refreshAgg={refreshAgg} goto={goView} back={goBack} session={session} onAccountUpdated={onAccountUpdated} />',
  '          <MyResponse questions={questions} agg={agg} notify={notify} refreshAgg={refreshAgg} goto={goView} back={goBack} session={session} onAccountUpdated={onAccountUpdated} onResponseDeleted={() => { setMyId(""); setCompletion(null); }} />'
);

replaceOnce(
  '    await pDel("last:id");\n    setProg(null);',
  '    await pDel("last:id");\n    if (onResponseDeleted) onResponseDeleted(found.id);\n    setProg(null);'
);

writeFileSync(uiPath, ui, "utf8");

const testPath = "tests/follow-up-ui-contract.test.mjs";
let tests = readFileSync(testPath, "utf8");
if (!tests.includes('test("response entry follows actual account response state", () => {')) {
  tests += `\n\ntest("response entry follows actual account response state", () => {\n  assert.ok(ui.includes('<Btn onClick={() => goto("survey")} style={{ flex: "1 1 200px" }}>{session && myId ? "二度目の自由記述、修正" : "最初の回答"}</Btn>'));\n  assert.ok(!ui.includes('<Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述、修正</Btn>'));\n  assert.ok(ui.includes('if (onResponseDeleted) onResponseDeleted(found.id);'));\n  assert.ok(ui.includes('onResponseDeleted={() => { setMyId(""); setCompletion(null); }}'));\n});\n`;
}
writeFileSync(testPath, tests, "utf8");

console.log("response entry state fix applied");
