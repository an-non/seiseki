import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");

test("入口・回答・完了・本人・Adminは固有URLを持つ", () => {
  for (const path of [
    'entry: "/"',
    'home: "/app"',
    'survey: "/survey"',
    'complete: "/survey/complete"',
    'mine: "/account/response"',
    'admin: "/admin"'
  ]) {
    assert.ok(ui.includes(path), path);
  }
});

test("概要・集計・意見ツリー・意見一覧は固有URLを持つ", () => {
  for (const view of [
    'home: "/app"',
    'dash: "/app/dashboard"',
    'tree: "/app/network"',
    'quantum: "/app/quantum"',
    'opinions: "/app/opinions"'
  ]) {
    assert.ok(ui.includes(view), view);
  }
  assert.doesNotMatch(ui, /path === "\/app\/dashboard"[^\n]+return "home"/);
});

test("画面遷移はブラウザ履歴と同期する", () => {
  assert.match(ui, /window\.history\.pushState/);
  assert.match(ui, /addEventListener\("popstate"/);
});

test("Adminは通常ナビと一般画面の導線に含まれない", () => {
  const navLine = ui.split("\n").find(line => line.startsWith("const NAVS =")) || "";
  assert.doesNotMatch(navLine, /admin|管理/);
  assert.doesNotMatch(ui, /goto\("admin"\)/);
});

test("回答を先頭、概要を次に置き、自分の回答はアカウントメニューへ移す", () => {
  const navLine = ui.split("\n").find(line => line.startsWith("const NAVS =")) || "";
  assert.match(navLine, /^const NAVS = \[\["survey", "回答する"\], \["home", "概要"\]/);
  assert.doesNotMatch(navLine, /mine|自分の回答/);
  assert.match(ui, /function AccountMenu\(/);
  assert.match(ui, /goto\("mine"\)/);
});

test("名前とパスワードの変更は現在の認証を再確認して保存する", () => {
  assert.match(ui, /async function acctUpdate\(/);
  assert.match(ui, /await acctLogin\(name, currentPass\)/);
  assert.match(ui, /await sDel\(oldKey\)/);
  assert.match(ui, /onAccountUpdated/);
  assert.match(ui, /function AccountSettings\(/);
  assert.match(ui, /<AccountSettings session=\{session\}/);
  const menu = ui.slice(ui.indexOf("function AccountMenu("), ui.indexOf("function AccountSettings("));
  assert.doesNotMatch(menu, /<form|acctUpdate/);
});

test("回答完了は独立した完了画面へ遷移する", () => {
  assert.match(ui, /setCompletion\(\{ \.\.\.result, agg: shown \}\); goView\("complete"\)/);
  assert.match(ui, /function Completion\(/);
});

test("回答導線を常時強調し、概要ノードへ全体比率を渡す", () => {
  assert.match(ui, /answerAction \? C\.green/);
  assert.match(ui, /total=\{chunkTotal\} showShare/);
  assert.match(ui, /全体の " \+ shareLabel/);
});


test("量子観測は通常ナビから /app/quantum へ遷移し、検証Workerだけを埋め込む", () => {
  const navLine = ui.split("\n").find(line => line.startsWith("const NAVS =")) || "";
  assert.match(navLine, /\["quantum", "量子観測"\]/);
  assert.match(ui, /quantum: "\/app\/quantum"/);
  assert.match(ui, /seiseki-opinion-network-preview\.tokyo-odh-129\.workers\.dev/);
  assert.match(ui, /<QuantumObservation \/>/);
});
