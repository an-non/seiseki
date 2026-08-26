import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");

test("Phase 4 response mutations send ownership and expected revision", () => {
  assert.match(ui, /headers\.authorization = "Bearer " \+ session\.token/);
  assert.match(ui, /"x-response-manage-token"\] = access\.manageToken/);
  assert.match(ui, /JSON\.stringify\(\{ expectedRevision: expectedRevision, freeText: freeText \}\)/);
  assert.match(ui, /JSON\.stringify\(\{ expectedRevision: expectedRevision, answers: answers \}\)/);
  assert.match(ui, /JSON\.stringify\(\{ expectedRevision: expectedRevision \}\)/);
});

test("an existing account response replaces the initial survey with separate editors", () => {
  assert.match(ui, /acctGet\(ss\.name, cloudApiEnabled\(\)\)/);
  assert.match(ui, /acctGet\(session\.name, true\)/);
  assert.match(ui, /cloudLoadOwnResponse\(rec\.respId, session\.token\)/);
  assert.match(ui, /if \(currentResponse && phase === "consent"\)/);
  assert.match(ui, /重複回答を避けるため、初回アンケートは開始していません/);
  assert.match(ui, /自由記述を追記/);
  assert.match(ui, /自由記述を修正/);
  assert.match(ui, /アンケート回答を修正/);
  assert.doesNotMatch(ui, /setAddendum|setLimit/);
});

test("current revision analysis is polled and stale revisions are ignored", () => {
  assert.match(ui, /const fresh = await cloudLoadOwnResponse\(id, session\.token\)/);
  assert.match(ui, /if \(freshRevision < revision\) return/);
  assert.match(ui, /freshStatus === "running" \? 1800 : 4000/);
});

test("revision conflicts refresh safely and explain refresh failure", () => {
  assert.match(ui, /async function handleRevisionConflict/);
  assert.match(ui, /latest|最新の回答を読み込めません/u);
  assert.match(ui, /await handleRevisionConflict/);
});

test("route state follows browser history", () => {
  assert.match(ui, /useState\(\(\) => viewFromPath\(currentPath\(\)\)\)/);
  assert.match(ui, /window\.history\.pushState/);
  assert.match(ui, /addEventListener\("popstate"/);
});
