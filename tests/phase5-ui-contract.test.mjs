import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");
test("Phase 5 canonical routes and compatibility alias", () => { assert.ok(ui.includes('tree: "/app/tree"')); assert.ok(ui.includes('quantum: "/app/quantum"')); assert.ok(ui.includes('const VIEW_PATH_ALIASES = { "/app/network": "tree", "/app/stats": "dash" };')); assert.ok(ui.includes('const QUANTUM_PREVIEW_URL = "/quantum/')); });
test("Phase 5 auth lookup failure is not rendered as no response", () => { assert.ok(ui.includes("本人回答を確認できませんでした")); assert.ok(ui.includes("setSelfLookupError")); assert.ok(ui.includes("acctGet(session.name, cloudApiEnabled())")); });
test("Phase 5 response update operations are semantically separated", () => { assert.ok(ui.includes('followup: "/survey/follow-up"')); assert.ok(ui.includes("二度目の自由記述")); assert.ok(ui.includes("回答内容を確認・修正")); assert.ok(!ui.includes("現在の全文を残し、新しい段落を末尾へ追加")); });
test("Phase 5 typography restores historical body/display/mono roles without external font loading", () => { assert.ok(ui.includes('const FONT_BODY = \'"Zen Kaku Gothic New"')); assert.ok(ui.includes('const FONT_DISP = \'"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif\';')); assert.ok(ui.includes('const FONT_MONO = \'"IBM Plex Mono"')); assert.ok(!ui.includes("fonts.googleapis.com")); });
test("initial submission requires an explicit review step before storage and analysis", () => {
  assert.ok(ui.includes('if (phase === "confirm")'));
  assert.ok(ui.includes('onClick={() => setPhase("confirm")}>入力内容を確認'));
  assert.ok(ui.includes('この時点ではまだ保存・解析されていません'));
  assert.ok(ui.includes('内容を確定してAI解析へ'));
});
test("registration uses an explicit Turnstile widget and sends only its short-lived token", () => {
  assert.ok(ui.includes('action: "register"'));
  assert.ok(ui.includes('appearance: "interaction-only"'));
  assert.ok(ui.includes('turnstileToken: String(turnstileToken || "")'));
  assert.ok(ui.includes('registerTurnstileRequired && !turnstileToken'));
});
