const BASE_URL = "https://seiseki-api-staging.tokyo-odh-129.workers.dev";
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const runId = Date.now().toString(36);
const name = `ts-${runId}`;
let password = "Staging-only-pass-1";
let token = "";
let deleted = false;

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

function expectStatus(step, result, expected) {
  if (result.response.status !== expected) {
    const code = result.body && typeof result.body === "object" ? result.body.error : "UNKNOWN";
    throw new Error(`${step} failed: HTTP ${result.response.status} (${code})`);
  }
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
  const turnstile = config.body?.turnstile;
  if (turnstile?.registerRequired !== true || turnstile?.registerSiteKey !== TEST_SITE_KEY) {
    throw new Error("registration Turnstile test configuration is not active");
  }
  if (turnstile?.recoveryRequired !== true || turnstile?.recoverySiteKey !== TEST_SITE_KEY) {
    throw new Error("recovery Turnstile test configuration is not active");
  }

  const registered = await request("/api/accounts/register", {
    method: "POST",
    body: JSON.stringify({ name, password, turnstileToken: TEST_TOKEN })
  });
  expectStatus("register", registered, 201);
  token = String(registered.body?.token || "");
  const recoveryCode = String(registered.body?.recoveryCode || "");
  if (!token || !recoveryCode) throw new Error("registration credentials were incomplete");

  const nextPassword = "Staging-only-pass-2";
  const recovered = await request("/api/accounts/recover", {
    method: "POST",
    body: JSON.stringify({
      name,
      recoveryCode,
      newPassword: nextPassword,
      turnstileToken: TEST_TOKEN
    })
  });
  expectStatus("recover", recovered, 200);
  token = String(recovered.body?.token || "");
  password = nextPassword;
  if (!token) throw new Error("recovery session token was missing");

  const loggedIn = await request("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ name, password })
  });
  expectStatus("login-after-recovery", loggedIn, 200);
  token = String(loggedIn.body?.token || token);

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
    status: "turnstile_staging_e2e_passed",
    register: 201,
    recover: 200,
    loginAfterRecovery: 200,
    cleanup: 204,
    deletedAccountLogin: 401
  }));
} catch (error) {
  console.error(JSON.stringify({ status: "turnstile_staging_e2e_failed", runId }));
  throw error;
} finally {
  await cleanup();
}
