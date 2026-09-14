import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");

test("analysis confirmation is explicit and gates the submit command", () => {
  assert.match(ui, /const \[analysisConfirmed, setAnalysisConfirmed\] = useState\(false\)/u);
  assert.match(ui, /入力内容を確認し、AI解析を実行します/u);
  assert.match(ui, /<Btn disabled=\{!analysisConfirmed\} onClick=\{submit\}>/u);
  assert.match(ui, /ANALYSIS_RATE_LIMITED/u);
});

test("held duplicate uses local provisional analysis without entering the public aggregate", () => {
  assert.match(ui, /publicationStatus === "held_duplicate"/u);
  assert.match(ui, /analysisSource = "local-provisional"/u);
  assert.match(ui, /analysisSource: held \? "local-provisional" : "cloudflare"/u);
  assert.match(ui, /if \(publicationStatus !== "held_duplicate"\) mergeResponse\(cur, resp\)/u);
});

test("follow-up analysis screen explains held duplicate state without a waiting spinner", () => {
  assert.match(ui, /const held = current\.publicationStatus === "held_duplicate" \|\| status === "held"/u);
  assert.match(ui, /同一内容の確認待ち/u);
  assert.match(ui, /確認が終わるまでAI解析を開始せず、公開集計と意見ノードにも反映しません/u);
  assert.match(ui, /const active = !held && \(status === "pending" \|\| status === "running"\)/u);
});
