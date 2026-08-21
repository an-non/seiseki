const baseUrl = String(process.argv[2] ?? "https://seiseki-api-staging.tokyo-odh-129.workers.dev")
  .replace(/\/$/u, "");
let responseId = null;

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

try {
  const created = await request("/api/responses", {
    method: "POST",
    body: JSON.stringify({
      appVersion: "staging-ai-smoke",
      consent: { accepted: true, version: "smoke-1", at: Date.now() },
      answers: { q_priority: "子育て・教育" },
      freeText: "教育制度では、地域差を確認しながら学習支援を改善してほしい。",
      demoFlag: true
    })
  }, [201]);
  responseId = created?.id;
  if (!responseId) throw new Error("response creation did not return an id");

  let analysis = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    analysis = await request(`/api/responses/${responseId}/analysis`);
    if (analysis?.analysisStatus !== "pending") break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (analysis?.analysisStatus !== "completed") {
    throw new Error(
      `analysis did not complete: ${analysis?.analysisStatus ?? "missing"} ${analysis?.errorCode ?? ""}`.trim()
    );
  }
  if (analysis?.analysis?.engine !== "workers-ai-hybrid-v1") {
    throw new Error("unexpected analysis engine");
  }
  if (!Array.isArray(analysis?.analysis?.chunks)) {
    throw new Error("analysis chunks were not returned");
  }
  console.log(JSON.stringify({
    status: "passed",
    analysisStatus: analysis.analysisStatus,
    analysisEngine: analysis.analysis.engine,
    chunkCount: analysis.analysis.chunks.length,
    ideologyStored: Object.hasOwn(analysis.analysis, "ideology")
  }, null, 2));
} finally {
  if (responseId) {
    try { await request(`/api/responses/${responseId}`, { method: "DELETE" }, [204, 404]); } catch {}
  }
}
