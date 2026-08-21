const baseUrl = "https://seiseki-api-staging.tokyo-odh-129.workers.dev";
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const name = `確認_${suffix}`;
const password = `profile-${suffix}-A1`;
const sentence = "プロフィールから参照するための合成自由記述です。教育費の負担軽減と学習環境の改善を求めます。";
const freeText = sentence.repeat(Math.ceil(1500 / sentence.length)).slice(0, 1500);
let token = "";
let responseId = "";
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  let payload = null;
  if (response.status !== 204) payload = await response.json();
  return { response, payload };
}

async function waitForAnalysis(id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await request(`/api/responses/${encodeURIComponent(id)}/analysis`);
    if (result.payload?.analysisStatus === "completed" || result.payload?.analysisStatus === "failed") {
      return result.payload;
    }
    await sleep(1500);
  }
  throw new Error(`analysis timeout: ${id}`);
}

try {
  const registered = await request("/api/accounts/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password })
  });
  if (registered.response.status !== 201) throw new Error(`register:${registered.response.status}`);
  token = registered.payload.token;
  const created = await request("/api/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      appVersion: "0.15.3-profile-smoke",
      consent: { accepted: true, version: "1.4", at: Date.now() },
      demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
      answers: { q_support: "わからない", q_priority: "子育て・教育" },
      freeText
    })
  });
  if (created.response.status !== 201) throw new Error(`create:${created.response.status}`);
  responseId = created.payload.id;
  const analysisResult = await waitForAnalysis(responseId);

  const unauthorized = await request("/api/accounts/me/responses");
  const mine = await request("/api/accounts/me/responses", {
    headers: { authorization: `Bearer ${token}` }
  });
  const own = mine.payload?.responses?.find(response => response.id === responseId);
  console.log(JSON.stringify({
    unauthorizedStatus: unauthorized.response.status,
    authenticatedStatus: mine.response.status,
    responseFound: Boolean(own),
    expectedLength: freeText.length,
    actualLength: own?.free?.length ?? null,
    freeTextMatches: own?.free === freeText,
    answerMatches: own?.answers?.q_priority === "子育て・教育",
    analysisStatus: analysisResult?.analysisStatus ?? null,
    engine: analysisResult?.analysis?.engine ?? null,
    params: analysisResult?.analysis?.params ?? null,
    ideology: analysisResult?.analysis?.ideology ?? null,
    chunks: analysisResult?.analysis?.chunks?.map(chunk => ({
      summary: chunk.s,
      topic: chunk.topic,
      criticality: chunk.crit
    })) ?? []
  }));
  if (unauthorized.response.status !== 401 || !own || own.free !== freeText
      || analysisResult?.analysisStatus !== "completed" || !analysisResult?.analysis) {
    throw new Error("profile response verification failed");
  }
} finally {
  if (responseId) await request(`/api/responses/${encodeURIComponent(responseId)}`, { method: "DELETE" });
  if (token) await request("/api/accounts/me", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: password })
  });
}
