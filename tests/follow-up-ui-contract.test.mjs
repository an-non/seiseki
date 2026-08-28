import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");

test("second free text is a dedicated route separate from first survey and correction", () => {
  assert.ok(ui.includes('followup: "/survey/follow-up"'));
  assert.ok(ui.includes("function FollowUpSurvey("));
  assert.ok(ui.includes("二度目の自由記述を送信"));
  assert.ok(ui.includes("回答内容を修正"));
});

test("generic append UI is removed", () => {
  assert.ok(!ui.includes("自由記述を追記"));
  assert.ok(!ui.includes("追記する</Btn>"));
});

test("survey owns unified initial correction while account response keeps second-text controls", () => {
  assert.ok(ui.includes("初回回答を修正"));
  assert.ok(ui.includes("アンケートと1回目自由記述を一緒に更新"));
  assert.ok(ui.includes("現在の回答全体で再解析"));
  assert.ok(!ui.includes("AI解析は再実行しません"));
  assert.ok(!ui.includes("アンケートを修正する"));
  assert.ok(ui.includes("二度目の自由記述"));
  assert.ok(ui.includes("書きかけの回答があります。"));
});

test("overview and response labels match the revised navigation", () => {
  assert.ok(ui.includes("書きかけの回答があります。"));
  assert.ok(ui.includes('Btn small onClick={() => goto("survey")}>続きから回答する</Btn>'));
  assert.ok(ui.includes("二度目の自由記述、修正"));
  assert.ok(ui.includes("自分の回答、設定の確認"));
  assert.ok(ui.includes("マイレスポンス確認・修正"));
});

test("response entry follows actual account response state", () => {
  assert.ok(ui.includes('<Btn onClick={() => goto("survey")} style={{ flex: "1 1 200px" }}>{session && myId ? "二度目の自由記述、修正" : "最初の回答"}</Btn>'));
  assert.ok(!ui.includes('<Btn onClick={() => goto("followup")} style={{ flex: "1 1 200px" }}>二度目の自由記述、修正</Btn>'));
  assert.ok(ui.includes('if (onResponseDeleted) onResponseDeleted(found.id);'));
  assert.ok(ui.includes('onResponseDeleted={() => { setMyId(""); setCompletion(null); }}'));
});

test("my response exposes second free-text withdrawal", () => {
  assert.ok(ui.includes("2回目を撤回"));
  assert.ok(ui.includes("2回目を本当に撤回する"));
  assert.ok(ui.includes("cloudDeleteFollowUp"));
  assert.ok(ui.includes("回答、解析結果を削除する"));
});
