const baseUrl = String(process.env.SEISEKI_STAGING_URL
  || "https://seiseki-api-staging.tokyo-odh-129.workers.dev").replace(/\/+$/u, "");

const samples = [
  ["redistribution", "富裕税と累進課税を導入し、社会保障と公的支援を拡充すべきだ。"],
  ["market", "規制緩和と民営化を進め、法人税を下げて市場競争を促進すべきだ。"],
  ["mixed", "社会保障を拡充する一方、行政の規制緩和と歳出削減も進めるべきだ。"],
  ["multiple", "消費税を減税すべきだ。最低賃金を引き上げてほしい。防衛費を増やすべきだ。選択的夫婦別姓を認めてほしい。"]
];
const selectedSamples = process.argv[2]
  ? samples.filter(([name]) => name === process.argv[2])
  : samples;
if (selectedSamples.length === 0) throw new Error(`unknown sample: ${process.argv[2]}`);

const createdIds = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(path, options) {
  const response = await fetch(baseUrl + path, options);
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

async function submit(freeText) {
  return request("/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appVersion: "0.15.3-smoke",
      consent: { accepted: true, version: "1.3", at: Date.now() },
      demo: {
        age: "30代",
        gender: "回答しない",
        region: "関東",
        occupation: "会社員(正社員)",
        party: "支持政党なし"
      },
      answers: { q_support: "わからない", q_priority: "その他" },
      freeText,
      demoFlag: true
    })
  });
}

async function waitForAnalysis(id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await request(`/api/responses/${encodeURIComponent(id)}/analysis`);
    if (result.analysisStatus === "completed" || result.analysisStatus === "failed") return result;
    await sleep(1500);
  }
  throw new Error(`analysis timeout: ${id}`);
}

try {
  for (const [name, freeText] of selectedSamples) {
    const created = await submit(freeText);
    createdIds.push(created.id);
    const result = await waitForAnalysis(created.id);
    const analysis = result.analysis;
    console.log(JSON.stringify({
      name,
      status: result.analysisStatus,
      engine: analysis?.engine ?? null,
      ideology: analysis?.ideology ?? null,
      chunks: analysis?.chunks?.map(chunk => ({ topic: chunk.topic, summary: chunk.s })) ?? [],
      errorCode: result.errorCode ?? null
    }));
  }
} finally {
  for (const id of createdIds) {
    try { await request(`/api/responses/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    catch (error) { console.error(`cleanup failed: ${id}: ${error.message}`); }
  }
}
