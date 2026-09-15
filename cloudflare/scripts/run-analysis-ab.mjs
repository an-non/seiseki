import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeAiAnalysis } from "../src/analysis.mjs";
import { buildLegacyPrompt } from "./run-groq-legacy-comparison.mjs";

const baseUrl = String(process.env.SEISEKI_AB_URL || "http://127.0.0.1:8791").replace(/\/+$/u, "");
const evalCases = JSON.parse(fs.readFileSync(new URL("../../docs/EVAL-SUPPLEMENT-16.json", import.meta.url), "utf8"));
const policyCases = [
  { id: "P-left", free: "富裕税と累進課税を導入し、社会保障と公的支援を拡充すべきだ。", expectedAxis: "econ", expectedSign: -1 },
  { id: "P-right", free: "規制緩和と民営化を進め、法人税を下げて市場競争を促進すべきだ。", expectedAxis: "econ", expectedSign: 1 },
  { id: "P-liberal", free: "選択的夫婦別姓と同性婚を認め、個人の自由と少数者の権利を守るべきだ。", expectedAxis: "soc", expectedSign: -1 },
  { id: "P-conservative", free: "防衛力と国境管理を強化し、治安維持と伝統的な家族観を重視すべきだ。", expectedAxis: "soc", expectedSign: 1 }
];
const demo = { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" };
const answers = { q_support: "わからない", q_priority: "その他", q_econ: "3" };
let samples = [
  ...evalCases.map(item => ({ ...item, demo, answers })),
  ...policyCases.map(item => ({ ...item, demo, answers }))
];
const requestedIds = new Set(String(process.env.SEISEKI_AB_IDS || "").split(",").map(value => value.trim()).filter(Boolean));
if (requestedIds.size) samples = samples.filter(sample => requestedIds.has(sample.id));
const model = String(process.env.SEISEKI_AB_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast");
const maxTokens = Number(process.env.SEISEKI_AB_MAX_TOKENS || 900);
const timeoutMs = Math.min(120000, Math.max(5000, Number(process.env.SEISEKI_AB_TIMEOUT_MS || 45000)));
const disableThinking = process.env.SEISEKI_AB_DISABLE_THINKING === "1";
const modes = String(process.env.SEISEKI_AB_MODES || "current,restored,legacy").split(",").map(value => value.trim()).filter(Boolean);
const results = [];

for (const mode of modes) {
  for (const sample of samples) {
    const startedAt = Date.now();
    let payload;
    try {
      const response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          model,
          maxTokens,
          sample,
          prompt: mode === "legacy" ? buildLegacyPrompt(sample) : null,
          disableThinking
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      payload = await response.json();
    } catch (error) {
      payload = {
        mode,
        model,
        durationMs: Date.now() - startedAt,
        validJson: false,
        error: String(error?.message ?? error).slice(0, 300)
      };
    }
    const analysis = sanitizeAiAnalysis(payload.parsed, sample.free);
    results.push({
      id: sample.id,
      mode,
      expected: sample,
      ...payload,
      validAnalysis: !!analysis,
      strictValidAnalysis: !!analysis,
      analysis
    });
    process.stdout.write(`${mode} ${sample.id}: ${analysis ? "ok" : "failed"}\n`);
  }
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

const summaries = modes.map(mode => {
  const modeRows = results.filter(row => row.mode === mode);
  const scored = modeRows.filter(row => /^G-/u.test(row.id) && row.validJson && row.parsed?.params);
  const mae = {};
  for (const [expectedKey, getter] of [
    ["pol", row => row.parsed?.params?.emo?.pol],
    ["valid", row => row.parsed?.params?.valid],
    ["crit", row => row.parsed?.params?.crit],
    ["motiv", row => row.parsed?.params?.motiv]
  ]) {
    const errors = scored.map(row => {
      const actual = finite(getter(row));
      return actual == null ? null : Math.abs(actual - Number(row.expected[expectedKey]));
    }).filter(value => value != null);
    mae[expectedKey] = errors.length ? Math.round(errors.reduce((sum, value) => sum + value, 0) / errors.length * 100) / 100 : null;
  }
  const policyRows = modeRows.filter(row => /^P-/u.test(row.id));
  const policyCorrect = policyRows.filter(row => {
    const value = finite(row.parsed?.ideology?.[row.expected.expectedAxis]);
    return value != null && Math.sign(value) === row.expected.expectedSign;
  }).length;
  return {
    mode,
    validJson: modeRows.filter(row => row.validJson).length,
    validAnalysis: modeRows.filter(row => row.validAnalysis).length,
    strictValidAnalysis: modeRows.filter(row => row.strictValidAnalysis).length,
    total: modeRows.length,
    mae,
    policyAxisCorrect: policyCorrect,
    policyAxisTotal: policyRows.length,
    averageDurationMs: Math.round(modeRows.reduce((sum, row) => sum + Number(row.durationMs || 0), 0) / modeRows.length)
  };
});

const report = { generatedAt: new Date().toISOString(), model, timeoutMs, disableThinking, requestCount: results.length, summaries, results };
const reportDir = fileURLToPath(new URL("../reports/", import.meta.url));
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `analysis-ab-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ reportPath, summaries }, null, 2));
