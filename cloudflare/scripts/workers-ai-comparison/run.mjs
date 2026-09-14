import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cloudflareRoot = path.resolve(here, "../..");
const cases = JSON.parse(fs.readFileSync(path.resolve(cloudflareRoot, "../docs/EVAL-SUPPLEMENT-16.json"), "utf8"));
const policyCases = [
  { id: "P-left", free: "富裕税と累進課税を導入し、社会保障と公的支援を拡充すべきだ。", expectedAxis: "econ", expectedSign: -1 },
  { id: "P-right", free: "規制緩和と民営化を進め、法人税を下げて市場競争を促進すべきだ。", expectedAxis: "econ", expectedSign: 1 },
  { id: "P-liberal", free: "選択的夫婦別姓と同性婚を認め、個人の自由と少数者の権利を守るべきだ。", expectedAxis: "soc", expectedSign: -1 },
  { id: "P-conservative", free: "防衛力と国境管理を強化し、治安維持と伝統的な家族観を重視すべきだ。", expectedAxis: "soc", expectedSign: 1 }
];
const defaults = ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/google/gemma-4-26b-a4b-it", "@cf/mistralai/mistral-small-3.1-24b-instruct"];
const models = String(process.env.SEISEKI_CF_MODELS || defaults.join(",")).split(",").map(value => value.trim()).filter(Boolean);
const modes = String(process.env.SEISEKI_CF_SCORING_MODES || "direct,distribution").split(",").map(value => value.trim()).filter(value => ["direct", "distribution"].includes(value));
const ids = new Set(String(process.env.SEISEKI_CF_IDS || "").split(",").map(value => value.trim()).filter(Boolean));
const samples = [...cases, ...policyCases].filter(sample => !ids.size || ids.has(sample.id));
const port = Number(process.env.SEISEKI_CF_PROBE_PORT || 8794);
const endpoint = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(24).toString("hex");
const wranglerCli = path.join(cloudflareRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const child = spawn(process.execPath, [
  wranglerCli, "dev", "--remote", "--config", path.join(here, "wrangler.jsonc"),
  "--port", String(port), "--var", `PROBE_TOKEN:${token}`
], { cwd: cloudflareRoot, stdio: ["ignore", "pipe", "pipe"] });
let diagnostic = "";
child.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-6000); });
child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-6000); });

async function waitUntilReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`wrangler exited before ready\n${diagnostic}`);
    try {
      const response = await fetch(endpoint, { headers: { "x-probe-token": token }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler probe did not become ready\n${diagnostic}`);
}

function summarize(model, scoringMode, rows) {
  const validRows = rows.filter(row => row.ok && /^G-/u.test(row.id));
  const distinct = getter => [...new Set(validRows.map(getter).filter(Number.isFinite))].sort((a, b) => a - b);
  const mae = key => {
    const errors = validRows.map(row => Math.abs(Number(row.analysis?.params?.[key]) - Number(row.expected?.[key]))).filter(Number.isFinite);
    return errors.length ? Math.round(errors.reduce((sum, value) => sum + value, 0) / errors.length * 100) / 100 : null;
  };
  const policy = rows.filter(row => row.ok && /^P-/u.test(row.id));
  return {
    model,
    scoringMode,
    succeeded: rows.filter(row => row.ok).length,
    total: rows.length,
    averageDurationMs: rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row.durationMs || 0), 0) / rows.length) : 0,
    retries: rows.reduce((sum, row) => sum + Math.max(0, Number(row.attempts || 1) - 1), 0),
    mae: { valid: mae("valid"), crit: mae("crit"), motiv: mae("motiv") },
    policyAxisCorrect: policy.filter(row => Math.sign(Number(row.analysis?.ideology?.[row.expected.expectedAxis])) === row.expected.expectedSign).length,
    policyAxisTotal: policy.length,
    distinctValues: {
      valid: distinct(row => Number(row.analysis?.params?.valid)),
      crit: distinct(row => Number(row.analysis?.params?.crit)),
      motiv: distinct(row => Number(row.analysis?.params?.motiv)),
      econ: distinct(row => Number(row.analysis?.ideology?.econ)),
      soc: distinct(row => Number(row.analysis?.ideology?.soc))
    }
  };
}

const rows = [];
try {
  await waitUntilReady();
  for (const model of models) {
    for (const scoringMode of modes) {
      for (const sample of samples) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-probe-token": token },
          body: JSON.stringify({ model, scoringMode, freeText: sample.free }),
          signal: AbortSignal.timeout(90000)
        });
        const result = await response.json();
        rows.push({ id: sample.id, expected: sample, ...result });
        process.stdout.write(`${model} ${scoringMode} ${sample.id}: ${result.ok ? "ok" : "failed"}\n`);
      }
    }
  }
} finally {
  child.kill("SIGTERM");
}

const summaries = models.flatMap(model => modes.map(scoringMode => summarize(
  model,
  scoringMode,
  rows.filter(row => row.model === model && row.scoringMode === scoringMode)
)));
const report = { generatedAt: new Date().toISOString(), syntheticOnly: true, models, modes, sampleIds: samples.map(sample => sample.id), summaries, rows };
const reports = path.join(cloudflareRoot, "reports");
fs.mkdirSync(reports, { recursive: true });
const reportPath = path.join(reports, `workers-ai-scoring-comparison-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ reportPath, summaries }, null, 2) + "\n");
