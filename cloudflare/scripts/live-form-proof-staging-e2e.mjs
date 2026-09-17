const BASE_URL = "https://seiseki-api-staging.tokyo-odh-129.workers.dev";

const runId = Date.now().toString(36);
const name = `fp-${runId}`;
let password = "Staging-only-pass-1";
let token = "";
let deleted = false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

function expectStatus(step, result, expected, expectedCode = "") {
  const code = result.body && typeof result.body === "object" ? String(result.body.error || "") : "";
  if (result.response.status !== expected || (expectedCode && code !== expectedCode)) {
    throw new Error(`${step} failed: HTTP ${result.response.status} (${code || "UNKNOWN"})`);
  }
}

async function proof(action) {
  const result = await request(`/api/form-proof?action=${encodeURIComponent(action)}`);
  expectStatus(`${action}-proof`, result, 200);
  const formProof = String(result.body?.token || "");
  if (!formProof) throw new Error(`${action} proof was missing`);
  await sleep(Math.max(0, Number(result.body?.readyAt || 0) - Date.now()) + 50);
  return formProof;
}

async function cleanup() {
  if (!token || deleted) return;
  await request("/api/accounts/me", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: password })
  }).catch(() => null);
}

try {
  const config = await request("/api/config");
  expectStatus("config", config, 200);
  if (config.body?.formProofRequired !== true) throw new Error("form proof is not required");
  if (config.body?.turnstile?.registerRequired || config.body?.turnstile?.recoveryRequired) {
    throw new Error("Turnstile unexpectedly remained required");
  }

  const registerProof = await proof("register");
  const registered = await request("/api/accounts/register", {
    method: "POST",
    body: JSON.stringify({ name, password, formProof: registerProof, companyWebsite: "" })
  });
  expectStatus("register", registered, 201);
  token = String(registered.body?.token || "");
  const recoveryCode = String(registered.body?.recoveryCode || "");
  if (!token || !recoveryCode) throw new Error("registration credentials were incomplete");

  const replayed = await request("/api/accounts/register", {
    method: "POST",
    body: JSON.stringify({ name: `${name}x`.slice(0, 20), password, formProof: registerProof, companyWebsite: "" })
  });
  expectStatus("proof-replay", replayed, 409, "FORM_PROOF_REPLAYED");

  const honeypotProof = await proof("register");
  const trapped = await request("/api/accounts/register", {
    method: "POST",
    body: JSON.stringify({ name: `${name}h`.slice(0, 20), password, formProof: honeypotProof, companyWebsite: "https://bot.example" })
  });
  expectStatus("honeypot", trapped, 400, "FORM_REJECTED");

  const recoveryProof = await proof("recover");
  const nextPassword = "Staging-only-pass-2";
  const recovered = await request("/api/accounts/recover", {
    method: "POST",
    body: JSON.stringify({ name, recoveryCode, newPassword: nextPassword, formProof: recoveryProof, companyWebsite: "" })
  });
  expectStatus("recover", recovered, 200);
  token = String(recovered.body?.token || "");
  password = nextPassword;
  if (!token) throw new Error("recovery session token was missing");

  const removed = await request("/api/accounts/me", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: password })
  });
  expectStatus("cleanup", removed, 204);
  deleted = true;

  const afterDelete = await request("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ name, password })
  });
  expectStatus("deleted-account-login", afterDelete, 401);

  console.log(JSON.stringify({
    status: "form_proof_staging_e2e_passed",
    register: 201,
    replay: 409,
    honeypot: 400,
    recover: 200,
    cleanup: 204,
    deletedAccountLogin: 401
  }));
} catch (error) {
  console.error(JSON.stringify({ status: "form_proof_staging_e2e_failed", runId }));
  throw error;
} finally {
  await cleanup();
}
