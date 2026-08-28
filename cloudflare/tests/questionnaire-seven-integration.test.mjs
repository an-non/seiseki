import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadQuestions } from "../src/config.mjs";

class D1StatementAdapter {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new D1StatementAdapter(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class D1DatabaseAdapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database, sql); }
}

function migration(name) {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

function applyBase(database) {
  for (const name of [
    "0001_initial.sql", "0002_accounts_and_analysis.sql", "0003_staging_kdf_range.sql",
    "0004_response_question_context.sql", "0005_rate_limits.sql", "0006_response_access_revision.sql",
    "0007_response_updated_at.sql"
  ]) database.exec(migration(name));
}

test("both historical 0008 migrations coexist without losing follow-up schema or seven-question config", async () => {
  const database = new DatabaseSync(":memory:");
  applyBase(database);
  database.exec(migration("0008_response_follow_up_text.sql"));
  database.exec(migration("0008_questionnaire_seven_structured.sql"));

  const columns = database.prepare("PRAGMA table_info(responses)").all().map(row => row.name);
  assert.ok(columns.includes("follow_up_text"));

  const questions = await loadQuestions(new D1DatabaseAdapter(database));
  assert.deepEqual(questions.map(question => question.id), [
    "q_support", "q_priority", "q_econ", "q_information", "q_social", "q_life", "q_participation", "q_free"
  ]);
  assert.equal(questions.filter(question => question.type !== "free").length, 7);
  assert.equal(questions.filter(question => question.type === "free").length, 1);
  database.close();
});

test("questionnaire config update does not rewrite an existing response question snapshot", () => {
  const database = new DatabaseSync(":memory:");
  applyBase(database);
  const now = Date.now();
  database.prepare(`INSERT INTO responses (
    id, created_at, updated_at, app_version, consent_version, consent_at, free_text,
    analysis_status, analysis_json, demo_flag, revision
  ) VALUES ('r_snapshot_contract_1234', ?, ?, 'test', 'v1', ?, 'text', 'pending', NULL, 0, 1)`).run(now, now, now);
  database.prepare(`INSERT INTO response_questions (
    response_id,qid,position,type,text,options_json,left_label,right_label
  ) VALUES ('r_snapshot_contract_1234','q_support',0,'single','old snapshot','["yes","no"]','','')`).run();

  database.exec(migration("0008_response_follow_up_text.sql"));
  database.exec(migration("0008_questionnaire_seven_structured.sql"));

  const snapshot = database.prepare("SELECT qid,text,options_json AS optionsJson FROM response_questions WHERE response_id='r_snapshot_contract_1234'").get();
  assert.deepEqual(snapshot, { qid: "q_support", text: "old snapshot", optionsJson: '["yes","no"]' });
  database.close();
});
