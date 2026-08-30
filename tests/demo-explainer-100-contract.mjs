import assert from "node:assert/strict";
import { DEMO_EXPLAINER_BATCH_ID, DEMO_EXPLAINER_LABEL, DEMO_EXPLAINER_RECORDS } from "../cloudflare/scripts/demo-explainer-100-v1.mjs";

const q = {
  q_support: new Set(["支持する", "どちらかといえば支持する", "どちらかといえば支持しない", "支持しない", "わからない"]),
  q_priority: new Set(["経済・雇用", "社会保障・医療", "子育て・教育", "外交・安全保障", "環境・エネルギー", "行政改革・政治とカネ", "その他"]),
  q_econ: new Set(["1", "2", "3", "4", "5"]),
  q_information: new Set(["十分に得られている", "どちらかといえば得られている", "どちらかといえば不足している", "不足している", "わからない"]),
  q_social: new Set(["1", "2", "3", "4", "5"]),
  q_life: new Set(["対応している", "どちらかといえば対応している", "どちらかといえば対応していない", "対応していない", "わからない"]),
  q_participation: new Set(["十分に反映されている", "どちらかといえば反映されている", "どちらかといえば反映されていない", "反映されていない", "わからない"])
};

assert.equal(DEMO_EXPLAINER_BATCH_ID, "demo-explainer-100-v1");
assert.match(DEMO_EXPLAINER_LABEL, /デモデータ/u);
assert.equal(DEMO_EXPLAINER_RECORDS.length, 100);
assert.equal(new Set(DEMO_EXPLAINER_RECORDS.map(row => row.key)).size, 100);

for (const [index, row] of DEMO_EXPLAINER_RECORDS.entries()) {
  assert.match(row.key, /^demo-explainer-100-v1-\d{3}$/u);
  assert.match(row.appVersion, /^デモデータ100-v1-\d{3}$/u);
  assert.equal(Object.keys(row.answers).length, 7);
  for (const [qid, allowed] of Object.entries(q)) assert.ok(allowed.has(row.answers[qid]), `${index + 1}: ${qid}`);
  assert.ok([...row.freeText].length >= 100 && [...row.freeText].length <= 1500, `${index + 1}: freeText length`);
  assert.ok(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(row.freeText), `${index + 1}: email-like text`);
  assert.ok(!/0\d{1,4}-\d{1,4}-\d{3,4}/u.test(row.freeText), `${index + 1}: phone-like text`);
}

for (const qid of ["q_support", "q_econ", "q_social"]) {
  const counts = new Map();
  for (const row of DEMO_EXPLAINER_RECORDS) counts.set(row.answers[qid], (counts.get(row.answers[qid]) || 0) + 1);
  const values = [...counts.values()];
  assert.ok(values.length >= 5, `${qid}: expected spread`);
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${qid}: expected near-even distribution`);
}

console.log(JSON.stringify({ contract: "demo-explainer-100", records: 100, status: "PASS" }));
