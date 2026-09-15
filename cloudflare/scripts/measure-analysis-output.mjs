import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCORE_FIELDS = ["valid", "crit", "motiv"];

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function collectAnalyses(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectAnalyses(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const embedded = parseMaybeJson(value.analysis_json ?? value.analysisJson);
  if (embedded && typeof embedded === "object") {
    collectAnalyses(embedded, output);
    return output;
  }
  if (value.params && Array.isArray(value.chunks)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value.results)) collectAnalyses(value.results, output);
  if (value.result && typeof value.result === "object") collectAnalyses(value.result, output);
  return output;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarizeNumbers(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const buckets = { tens: 0, fiveOnly: 0, other: 0 };
  for (const value of finite) {
    if (Number.isInteger(value) && value % 10 === 0) buckets.tens += 1;
    else if (Number.isInteger(value) && Math.abs(value % 10) === 5) buckets.fiveOnly += 1;
    else buckets.other += 1;
  }
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    distinct: new Set(finite).size,
    min: finite[0] ?? null,
    median: percentile(finite, 0.5),
    max: finite.at(-1) ?? null,
    average: finite.length ? Number((total / finite.length).toFixed(2)) : null,
    buckets
  };
}

export function summarizeNodeText(chunks, safetyLimit = 160) {
  const summaries = chunks.map(chunk => String(chunk?.s ?? "")).filter(Boolean);
  const lengths = summaries.map(value => Array.from(value).length);
  return {
    ...summarizeNumbers(lengths),
    atSafetyLimit: lengths.filter(length => length >= safetyLimit).length,
    hardSentenceEnd: summaries.filter(value => /[。！？!?]$/u.test(value)).length,
    ellipsisEnd: summaries.filter(value => /…$/u.test(value)).length,
    otherEnd: summaries.filter(value => !/[。！？!?…]$/u.test(value)).length,
    twelveOrFewer: lengths.filter(length => length <= 12).length
  };
}

export function measureAnalysisOutput(input) {
  const analyses = collectAnalyses(input);
  const chunks = analyses.flatMap(item => Array.isArray(item.chunks) ? item.chunks : []);
  const responseScores = Object.fromEntries(SCORE_FIELDS.map(field => [
    field,
    summarizeNumbers(analyses.map(item => item?.params?.[field]))
  ]));
  return {
    metadata: {
      purpose: "exploratory-observation",
      authoritative: false,
      note: "This report measures existing outputs. It does not define acceptance thresholds or alter analysis results."
    },
    counts: { analyses: analyses.length, chunks: chunks.length },
    responseScores,
    chunkScores: {
      crit: summarizeNumbers(chunks.map(chunk => chunk?.crit)),
      emo: summarizeNumbers(chunks.map(chunk => chunk?.emo))
    },
    nodeText: summarizeNodeText(chunks),
    classifications: {
      categories: new Set(chunks.map(chunk => String(chunk?.cat ?? "")).filter(Boolean)).size,
      targetTypes: new Set(chunks.map(chunk => String(chunk?.tt ?? "")).filter(Boolean)).size,
      topics: new Set(chunks.map(chunk => String(chunk?.topic ?? "")).filter(Boolean)).size
    }
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: npm run diagnose:analysis-output -- <analysis-json-path>");
  const raw = await readFile(resolve(inputPath), "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = raw.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1}`); }
    });
  }
  process.stdout.write(JSON.stringify(measureAnalysisOutput(input), null, 2) + "\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => {
  process.stderr.write(String(error?.message || error) + "\n");
  process.exitCode = 1;
});
