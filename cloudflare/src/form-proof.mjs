import { RequestError } from "./validation.mjs";

const encoder = new TextEncoder();
const VERSION = "v1";
const MIN_AGE_MS = 800;
const MAX_AGE_MS = 15 * 60 * 1000;
const ACTIONS = new Set(["register", "recover"]);

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function configuredSecret(env, required) {
  const secret = String(env?.RATE_LIMIT_FINGERPRINT_SECRET || "");
  if ([...secret].length >= 32) return secret;
  if (required) {
    throw new RequestError(503, "FORM_PROOF_NOT_CONFIGURED", "form protection is not configured");
  }
  return "";
}

function normalizeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new RequestError(400, "FORM_PROOF_ACTION_INVALID", "form action is invalid");
  }
  return action;
}

export function formProofRequired(env) {
  return String(env?.FORM_PROOF_REQUIRED).toLowerCase() === "true";
}

export async function issueFormProof(env, actionInput, now = Date.now()) {
  const action = normalizeAction(actionInput);
  const secret = configuredSecret(env, true);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const payload = `${VERSION}.${action}.${now}.${nonce}`;
  const signature = await hmac(secret, `seiseki-form-proof|${payload}`);
  return {
    token: `${payload}.${signature}`,
    action,
    readyAt: now + MIN_AGE_MS,
    expiresAt: now + MAX_AGE_MS
  };
}

async function consumeProof(db, signature, expiresAt, now) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO rate_limit_buckets (bucket_key, hit_count, reset_at, updated_at)
    VALUES (?, 1, ?, ?)
  `).bind(`form-proof:used:${signature}`, expiresAt, now).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) {
    throw new RequestError(409, "FORM_PROOF_REPLAYED", "form proof was already used");
  }
}

export async function verifyAndConsumeFormProof(env, body, expectedActionInput, now = Date.now()) {
  if (!formProofRequired(env)) return;
  if (String(body?.companyWebsite || "").trim()) {
    throw new RequestError(400, "FORM_REJECTED", "form submission was rejected");
  }

  const expectedAction = normalizeAction(expectedActionInput);
  const secret = configuredSecret(env, true);
  const token = String(body?.formProof || "").trim();
  const match = token.match(/^v1\.(register|recover)\.(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/u);
  if (!match) throw new RequestError(400, "FORM_PROOF_REQUIRED", "valid form proof is required");

  const [, action, issuedText, nonce, suppliedSignature] = match;
  if (action !== expectedAction) {
    throw new RequestError(400, "FORM_PROOF_ACTION_MISMATCH", "form proof action did not match");
  }
  const issuedAt = Number(issuedText);
  const age = now - issuedAt;
  if (!Number.isSafeInteger(issuedAt) || age < MIN_AGE_MS) {
    throw new RequestError(400, "FORM_PROOF_TOO_FAST", "form was submitted too quickly");
  }
  if (age > MAX_AGE_MS) {
    throw new RequestError(400, "FORM_PROOF_EXPIRED", "form proof expired");
  }

  const payload = `${VERSION}.${action}.${issuedAt}.${nonce}`;
  const expectedSignature = await hmac(secret, `seiseki-form-proof|${payload}`);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
    throw new RequestError(400, "FORM_PROOF_INVALID", "form proof is invalid");
  }
  await consumeProof(env.DB, suppliedSignature, issuedAt + MAX_AGE_MS, now);
}
