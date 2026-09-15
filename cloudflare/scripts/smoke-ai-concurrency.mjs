const baseUrl = String(process.argv[2] ?? "https://seiseki-api-staging.tokyo-odh-129.workers.dev")
  .replace(/\/$/u, "");
const count = Math.min(10, Math.max(1, Number(process.argv[3] ?? 5)));
const responseIds = [];

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  if (options.body != null) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status} ${body?.error ?? ""}`.trim());
  }
  return body;
}

async function create(index) {
  const result = await request("/api/responses", {
    method: "POST",
    body: JSON.stringify({
      appVersion: "staging-load",
      consent: { accepted: true, version: "smoke-1", at: Date.now() },
      answers: { q_priority: "その他" },
      freeText: `合成試験${index}。教育支援について、地域差を確認しながら制度を改善してほしい。`,
      demoFlag: true
    })
  }, [201]);
  responseIds.push(result.id);
}

async function awaitAnalysis(id) {
  let analysis = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    analysis = await request(`/api/responses/${id}/analysis`);
    if (analysis?.analysisStatus !== "pending") break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return {
    status: analysis?.analysisStatus ?? "missing",
    errorCode: analysis?.errorCode ?? null,
    chunks: Array.isArray(analysis?.analysis?.chunks) ? analysis.analysis.chunks.length : 0
  };
}

const startedAt = Date.now();
try {
  await Promise.all(Array.from({ length: count }, (_, index) => create(index + 1)));
  const results = await Promise.all(responseIds.map(awaitAnalysis));
  const summary = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] ?? 0) + 1;
    return accumulator;
  }, {});
  console.log(JSON.stringify({
    status: summary.completed === count ? "passed" : "incomplete",
    requested: count,
    results: summary,
    chunkCount: results.reduce((sum, result) => sum + result.chunks, 0),
    errorCodes: [...new Set(results.map(result => result.errorCode).filter(Boolean))],
    elapsedMs: Date.now() - startedAt
  }, null, 2));
  if (summary.completed !== count) process.exitCode = 1;
} finally {
  await Promise.allSettled(responseIds.map(id => request(`/api/responses/${id}`, {
    method: "DELETE"
  }, [204, 404])));
}
