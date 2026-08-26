import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPublicAggregate } from "../src/public-aggregate.mjs";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() { const r = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(r.changes) } }; }
}

class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
}

const analysis = JSON.stringify({
  params: { emo: { pol: 0.2, label: "中立" }, valid: 80, crit: 40, motiv: 60 },
  ideology: { econ: 10, soc: -5 },
  chunks: [{ s: "公開対象", cat: "評価", topic: "経済", tt: "政府全般", tn: "", emo: 0.2, crit: 40, fact: "意見" }]
});

function insertResponse(database, { id, status, demo = 0, analysisJson = analysis, age = "30代", support = "支持する" }) {
  database.prepare(`
    INSERT INTO responses (
      id, created_at, app_version, consent_version, consent_at,
      age, gender, region, occupation, party, free_text,
      analysis_status, analysis_json, demo_flag
    ) VALUES (?, ?, '0.16.0', '1.3', ?, ?, '回答しない', '関東', '会社員(正社員)', '支持政党なし', '本文', ?, ?, ?)
  `).run(id, Date.now(), Date.now(), age, status, analysisJson, demo);
  database.prepare("INSERT INTO answers (response_id, qid, value) VALUES (?, 'q_support', ?)").run(id, support);
}

test("public aggregate includes only completed non-demo responses with current analysis", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));

  insertResponse(database, { id: "r_publiccompleted001", status: "completed", age: "30代", support: "支持する" });
  insertResponse(database, { id: "r_publicpending00001", status: "pending", age: "40代", support: "支持しない" });
  insertResponse(database, { id: "r_publicfailed000001", status: "failed", age: "50代", support: "わからない" });
  insertResponse(database, { id: "r_publicdemo0000001", status: "completed", demo: 1, age: "60代", support: "支持しない" });
  insertResponse(database, { id: "r_publicnoanalysis001", status: "completed", analysisJson: null, age: "70代", support: "支持しない" });

  const aggregate = await getPublicAggregate(new D1(database));

  assert.equal(aggregate.total, 1);
  assert.deepEqual(aggregate.demo.age, { "30代": 1 });
  assert.deepEqual(aggregate.questions.q_support.counts, { "支持する": 1 });
  assert.equal(aggregate.ideology.n, 1);
  assert.equal(aggregate.opinions.length, 1);
  assert.equal(aggregate.opinions[0].s, "公開対象");
  assert.equal(aggregate.opinions[0].dm, false);

  database.close();
});
