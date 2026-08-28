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
