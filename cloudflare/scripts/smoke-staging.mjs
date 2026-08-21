const baseUrl = String(process.argv[2] ?? "https://seiseki-api-staging.tokyo-odh-129.workers.dev")
  .replace(/\/$/u, "");
const suffix = `${Date.now()}`.slice(-10);
const originalName = `smoke-${suffix}`;
const updatedName = `smoke2-${suffix}`;
const originalPassword = `Smoke-${crypto.randomUUID()}-1`;
const updatedPassword = `Smoke-${crypto.randomUUID()}-2`;

let token = null;
let password = originalPassword;
let responseId = null;

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  if (options.body != null) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  }
  if (!expected.includes(response.status)) {
    const code = body?.error ? ` ${body.error}` : "";
    throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status}${code}`);
  }
  return body;
}

async function sleep(milliseconds) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

try {
  const health = await request("/api/health");
  if (health?.status !== "ok") throw new Error("health check was not ok");

  const registered = await request("/api/accounts/register", {
    method: "POST",
    body: JSON.stringify({ name: originalName, password: originalPassword })
  }, [201]);
  token = registered?.token;
  if (!token) throw new Error("registration did not return a session token");

  const created = await request("/api/responses", {
    method: "POST",
    body: JSON.stringify({
      appVersion: "staging-smoke",
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
    await sleep(2000);
  }
  if (analysis?.analysisStatus !== "completed") {
    throw new Error(`analysis did not complete: ${analysis?.analysisStatus ?? "missing"}`);
  }
  if (analysis?.analysis?.engine !== "workers-ai-hybrid-v1") {
    throw new Error("unexpected analysis engine");
  }
  if (!Array.isArray(analysis?.analysis?.chunks)) {
    throw new Error("analysis chunks were not returned");
  }

  const mine = await request("/api/accounts/me/responses");
  if (!mine?.responses?.some(item => item.id === responseId)) {
    throw new Error("response was not linked to the account");
  }

  const updated = await request("/api/accounts/me", {
    method: "PATCH",
    body: JSON.stringify({
      currentPassword: originalPassword,
      name: updatedName,
      newPassword: updatedPassword
    })
  });
  token = updated?.token;
  password = updatedPassword;
  if (!token || updated?.account?.name !== updatedName) {
    throw new Error("account update did not return the new session");
  }

  console.log(JSON.stringify({
    status: "passed",
    health: health.status,
    accountLifecycle: "verified",
    responseLink: "verified",
    analysisStatus: analysis.analysisStatus,
    analysisEngine: analysis.analysis.engine,
    chunkCount: analysis.analysis.chunks.length
  }, null, 2));
} finally {
  if (responseId) {
    try { await request(`/api/responses/${responseId}`, { method: "DELETE" }, [204, 404]); } catch {}
  }
  if (token) {
    try {
      await request("/api/accounts/me", {
        method: "DELETE",
        body: JSON.stringify({ currentPassword: password })
      }, [204, 401, 404]);
    } catch {}
  }
}
