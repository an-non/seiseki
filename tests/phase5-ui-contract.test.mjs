import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");
test("Phase 5 canonical routes and compatibility alias", () => { assert.ok(ui.includes('tree: "/app/tree"')); assert.ok(ui.includes('quantum: "/app/quantum"')); assert.ok(ui.includes('const VIEW_PATH_ALIASES = { "/app/network": "tree" };')); assert.ok(ui.includes('const QUANTUM_PREVIEW_URL = "/quantum/')); });
test("Phase 5 auth lookup failure is not rendered as no response", () => { assert.ok(ui.includes("本人回答を確認できませんでした")); assert.ok(ui.includes("setSelfLookupError")); assert.ok(ui.includes("acctGet(session.name, cloudApiEnabled())")); });
test("Phase 5 response update operations are semantically separated", () => { assert.ok(ui.includes("現在の全文を残し、新しい段落を末尾へ追加")); assert.ok(ui.includes("現在の自由記述全文を置き換え")); assert.ok(ui.includes("初回回答時に保存された設問スナップショット")); assert.ok(ui.includes("currentResponse.cloudAnalysisRetryable === true")); });
test("Phase 5 typography restores historical body/display/mono roles without external font loading", () => { assert.ok(ui.includes('const FONT_BODY = \'"Zen Kaku Gothic New"')); assert.ok(ui.includes('const FONT_DISP = \'"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif\';')); assert.ok(ui.includes('const FONT_MONO = \'"IBM Plex Mono"')); assert.ok(!ui.includes("fonts.googleapis.com")); });
