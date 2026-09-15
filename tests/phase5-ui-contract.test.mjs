import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");
test("Phase 5 canonical routes and compatibility alias", () => { assert.ok(ui.includes('tree: "/app/tree"')); assert.ok(ui.includes('quantum: "/app/quantum"')); assert.ok(ui.includes('const VIEW_PATH_ALIASES = { "/app/network": "tree", "/app/stats": "dash" };')); assert.ok(ui.includes('const QUANTUM_PREVIEW_URL = "/quantum/')); });
test("Phase 5 auth lookup failure is not rendered as no response", () => { assert.ok(ui.includes("本人回答を確認できませんでした")); assert.ok(ui.includes("setSelfLookupError")); assert.ok(ui.includes("acctGet(session.name, cloudApiEnabled())")); });
test("Phase 5 response update operations are semantically separated", () => { assert.ok(ui.includes('followup: "/survey/follow-up"')); assert.ok(ui.includes("二度目の自由記述")); assert.ok(ui.includes("回答内容を確認・修正")); assert.ok(!ui.includes("現在の全文を残し、新しい段落を末尾へ追加")); });
test("opinion cards collapse long node text without discarding the stored value", () => {
  assert.ok(ui.includes("WebkitLineClamp: 2"));
  assert.ok(ui.includes('expanded ? "折りたたむ" : "全文を表示"'));
  assert.ok(ui.includes("aria-expanded={expanded}"));
});
test("Phase 5 typography restores historical body/display/mono roles without external font loading", () => { assert.ok(ui.includes('const FONT_BODY = \'"Zen Kaku Gothic New"')); assert.ok(ui.includes('const FONT_DISP = \'"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif\';')); assert.ok(ui.includes('const FONT_MONO = \'"IBM Plex Mono"')); assert.ok(!ui.includes("fonts.googleapis.com")); });
test("initial submission requires an explicit review step before storage and analysis", () => {
  assert.ok(ui.includes('if (phase === "confirm")'));
  assert.ok(ui.includes('setAnalysisConfirmed(false); setErr(""); setPhase("confirm")'));
  assert.ok(ui.includes('disabled={!analysisConfirmed} onClick={submit}'));
  assert.ok(ui.includes('setAnalysisConfirmed(event.target.checked)'));
  assert.ok(ui.includes('この時点ではまだ保存・解析されていません'));
  assert.ok(ui.includes('内容を確定してAI解析へ'));
});

test("account recovery is available without storing an email address", () => {
  assert.ok(ui.includes('cloudAccountCall("/api/accounts/recover"'));
  assert.ok(ui.includes('cloudAccountCall("/api/accounts/me/recovery-code"'));
  assert.ok(ui.includes('mode === "recover"'));
  assert.ok(ui.includes("復旧コードを保管してください"));
  assert.ok(ui.includes("復旧コードを再発行"));
});
test("registration and recovery use an explicit Turnstile widget with scoped actions", () => {
  assert.ok(ui.includes('<TurnstileChallenge siteKey={registerSiteKey} action="register"'));
  assert.ok(ui.includes('<TurnstileChallenge siteKey={recoverySiteKey} action="recover"'));
  assert.ok(ui.includes("recoveryTurnstileRequired && !turnstileToken"));
  assert.ok(ui.includes('appearance: "interaction-only"'));
  assert.ok(ui.includes('turnstileToken: String(turnstileToken || "")'));
  assert.ok(ui.includes('registerTurnstileRequired && !turnstileToken'));
});
