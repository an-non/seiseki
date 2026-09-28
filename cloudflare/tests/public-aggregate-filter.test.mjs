import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPublicAggregate, getPublicOpinions } from "../src/public-aggregate.mjs";

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

function insertResponse(database, { id, status, demo = 0, analysisJson = analysis, age = "30代", support = "支持する", createdAt = Date.now() }) {
  database.prepare(`
    INSERT INTO responses (
      id, created_at, app_version, consent_version, consent_at,
      age, gender, region, occupation, party, free_text,
      analysis_status, analysis_json, demo_flag
    ) VALUES (?, ?, '0.16.0', '1.3', ?, ?, '回答しない', '関東', '会社員(正社員)', '支持政党なし', '本文', ?, ?, ?)
  `).run(id, createdAt, createdAt, age, status, analysisJson, demo);
  database.prepare("INSERT INTO answers (response_id, qid, value) VALUES (?, 'q_support', ?)").run(id, support);
}

test("public aggregate includes only completed non-demo responses with current analysis", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0010_submission_review.sql", import.meta.url), "utf8"));

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

test("filtered public opinions can find a tree topic outside the recent 120 chunks", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0010_submission_review.sql", import.meta.url), "utf8"));
  const electionAnalysis = JSON.stringify({
    params: { emo: { pol: -0.2, label: "不満" }, valid: 75, crit: 70, motiv: 80 },
    ideology: { econ: 0, soc: 0 },
    chunks: [{ s: "選挙制度を見直すべき", cat: "提言", topic: "選挙制度", tt: "政府全般", tn: "国会", emo: -0.2, crit: 70, fact: "意見" }]
  });
  const newerAnalysis = JSON.stringify({
    params: { emo: { pol: 0, label: "中立" }, valid: 50, crit: 40, motiv: 50 },
    ideology: { econ: 0, soc: 0 },
    chunks: [{ s: "新しい別トピック", cat: "評価", topic: "経済", tt: "その他", tn: "", emo: 0, crit: 40, fact: "意見" }]
  });

  insertResponse(database, { id: "r_election_old_0001", status: "completed", analysisJson: electionAnalysis, createdAt: 1, support: "支持しない" });
  database.prepare(`
    INSERT INTO opinion_chunks (
      response_id, created_at, summary, category, topic, target_type,
      target_name, emotion, criticality, fact_status, provenance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `).run("r_election_old_0001", 1, "選挙制度を見直すべき", "提言", "選挙制度", "政府全般", "国会", -0.2, 70, "意見");
  for (let index = 0; index < 121; index += 1) {
    insertResponse(database, {
      id: "r_recent_" + String(index).padStart(12, "0"), status: "completed",
      analysisJson: newerAnalysis, createdAt: index + 2
    });
  }

  const aggregate = await getPublicAggregate(new D1(database));
  assert.equal(aggregate.opinions.length, 120);
  assert.equal(aggregate.opinions.some(opinion => opinion.topic === "選挙制度"), false);

  const opinions = await getPublicOpinions(new D1(database), { topic: "選挙制度", sup: "支持しない" });
  assert.equal(opinions.length, 1);
  assert.equal(opinions[0].s, "選挙制度を見直すべき");
  assert.equal(opinions[0].topic, "選挙制度");

  database.close();
});
