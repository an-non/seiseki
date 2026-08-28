import { RequestError } from "./validation.mjs";

const PASSWORD_ITERATIONS = 120000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  if (!/^[a-f0-9]+$/u.test(hex) || hex.length % 2 !== 0) return new Uint8Array();
  return new Uint8Array(hex.match(/../gu).map(value => Number.parseInt(value, 16)));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken() {
  const binary = Array.from(randomBytes(32), value => String.fromCharCode(value)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function derivePassword(password, saltHex, iterations) {
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations
    }, material, 256);
    return bytesToHex(new Uint8Array(bits));
  } catch {
    throw new RequestError(500, "AUTH_KDF_FAILED", "password derivation failed");
  }
}

function equalHex(left, right) {
  const a = hexToBytes(String(left));
  const b = hexToBytes(String(right));
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

function normalizeAccountName(value) {
  const name = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trim();
  const length = [...name].length;
  if (length < 2 || length > 20) {
    throw new RequestError(400, "INVALID_ACCOUNT_NAME", "account name must be 2 to 20 characters");
  }
  return { name, normalized: name.toLowerCase() };
}

function validatePassword(value, field = "password") {
  const password = String(value ?? "");
  const length = [...password].length;
  if (length < 8 || length > 128) {
    throw new RequestError(400, "INVALID_PASSWORD", `${field} must be 8 to 128 characters`);
  }
  return password;
}

function normalizeIterations(value) {
  const iterations = Number(value ?? PASSWORD_ITERATIONS);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) {
    throw new RequestError(500, "AUTH_CONFIG_INVALID", "password iteration configuration is invalid");
  }
  return iterations;
}

async function createSessionRecord(accountId, now = Date.now()) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  return { token, tokenHash, accountId, createdAt: now, expiresAt };
}

async function issueSession(db, accountId, now = Date.now()) {
  const session = await createSessionRecord(accountId, now);
  await db.prepare(`
    INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(session.tokenHash, accountId, now, session.expiresAt).run();
  return session;
}

async function latestResponseId(db, accountId) {
  const row = await db.prepare(`
    SELECT response_id AS responseId
    FROM account_responses
    WHERE account_id = ?
    ORDER BY linked_at DESC
    LIMIT 1
  `).bind(accountId).first();
  return row?.responseId ?? null;
}

async function accountPayload(db, account, session = null) {
  return {
    account: {
      id: account.id,
      name: account.name,
      responseId: await latestResponseId(db, account.id)
    },
    ...(session ? { token: session.token, expiresAt: session.expiresAt } : {})
  };
}

export async function createResponseManageToken() {
  const token = randomToken();
  return { token, tokenHash: await sha256Hex(token) };
}

export async function accountOwnsResponse(db, accountId, responseId) {
  if (!accountId || !responseId) return false;
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM account_responses
    WHERE account_id = ? AND response_id = ?
    LIMIT 1
  `).bind(accountId, responseId).first();
  return row?.found === 1;
}

export async function authorizeResponseAccess(db, request, responseId) {
  const account = await authenticateRequest(db, request, request.headers.has("authorization"));
  if (account && await accountOwnsResponse(db, account.id, responseId)) {
    return { kind: "account", account };
  }

  const token = String(request.headers.get("x-response-manage-token") ?? "").trim();
  if (/^[A-Za-z0-9_-]{40,64}$/u.test(token)) {
    const tokenHash = await sha256Hex(token);
    const row = await db.prepare(`
      SELECT 1 AS found
      FROM response_access
      WHERE response_id = ? AND manage_token_hash = ?
      LIMIT 1
    `).bind(responseId, tokenHash).first();
    if (row?.found === 1) return { kind: "manage-token" };
  }

  if (account) throw new RequestError(403, "RESPONSE_FORBIDDEN", "response does not belong to this account");
  throw new RequestError(401, "RESPONSE_AUTH_REQUIRED", "response access authorization is required");
}

export async function registerAccount(db, input, configuredIterations) {
  const { name, normalized } = normalizeAccountName(input?.name);
  const password = validatePassword(input?.password);
  const existing = await db.prepare("SELECT 1 AS found FROM accounts WHERE normalized_name = ?")
    .bind(normalized).first();
  if (existing) throw new RequestError(409, "ACCOUNT_EXISTS", "account name is already in use");

  const now = Date.now();
  const iterations = normalizeIterations(configuredIterations);
  const id = `u_${crypto.randomUUID().replaceAll("-", "")}`;
  const salt = bytesToHex(randomBytes(16));
  const passwordHash = await derivePassword(password, salt, iterations);
  const session = await createSessionRecord(id, now);
  try {
    await db.batch([
      db.prepare(`
      INSERT INTO accounts (
        id, name, normalized_name, password_salt, password_hash,
        password_iterations, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, name, normalized, salt, passwordHash, iterations, now, now),
      db.prepare(`
        INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(session.tokenHash, id, now, session.expiresAt)
    ]);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (String(error?.message ?? "").toLowerCase().includes("unique")) {
      throw new RequestError(409, "ACCOUNT_EXISTS", "account name is already in use");
    }
    throw new RequestError(500, "AUTH_STORAGE_FAILED", "account storage failed");
  }
  return accountPayload(db, { id, name }, session);
}

export async function loginAccount(db, input) {
  const { normalized } = normalizeAccountName(input?.name);
  const password = validatePassword(input?.password);
  const account = await db.prepare(`
    SELECT id, name, password_salt AS passwordSalt,
           password_hash AS passwordHash, password_iterations AS passwordIterations
    FROM accounts
    WHERE normalized_name = ?
  `).bind(normalized).first();
  if (!account) throw new RequestError(401, "INVALID_CREDENTIALS", "account name or password is incorrect");
  const actual = await derivePassword(password, account.passwordSalt, account.passwordIterations);
  if (!equalHex(actual, account.passwordHash)) {
    throw new RequestError(401, "INVALID_CREDENTIALS", "account name or password is incorrect");
  }
  const session = await issueSession(db, account.id);
  return accountPayload(db, account, session);
}

export async function authenticateRequest(db, request, required = false) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,64})$/u);
  if (!match) {
    if (required) throw new RequestError(401, "AUTH_REQUIRED", "authentication is required");
    return null;
  }
  const tokenHash = await sha256Hex(match[1]);
  const account = await db.prepare(`
    SELECT a.id, a.name, s.expires_at AS expiresAt
    FROM account_sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first();
  if (!account || Number(account.expiresAt) <= Date.now()) {
    if (account) await db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(tokenHash).run();
    if (required) throw new RequestError(401, "SESSION_INVALID", "session is invalid or expired");
    return null;
  }
  return { ...account, tokenHash };
}

export async function getAccount(db, account) {
  return accountPayload(db, account);
}

export async function updateAccount(db, account, input, configuredIterations) {
  const row = await db.prepare(`
    SELECT id, name, normalized_name AS normalizedName, password_salt AS passwordSalt,
           password_hash AS passwordHash, password_iterations AS passwordIterations
    FROM accounts WHERE id = ?
  `).bind(account.id).first();
  const currentPassword = validatePassword(input?.currentPassword, "currentPassword");
  const actual = await derivePassword(currentPassword, row.passwordSalt, row.passwordIterations);
  if (!equalHex(actual, row.passwordHash)) {
    throw new RequestError(401, "INVALID_CREDENTIALS", "current password is incorrect");
  }

  const nextName = input?.name == null ? { name: row.name, normalized: row.normalizedName } : normalizeAccountName(input.name);
  let salt = row.passwordSalt;
  let passwordHash = row.passwordHash;
  if (input?.newPassword) {
    const nextPassword = validatePassword(input.newPassword, "newPassword");
    const iterations = normalizeIterations(configuredIterations);
    salt = bytesToHex(randomBytes(16));
    passwordHash = await derivePassword(nextPassword, salt, iterations);
    row.passwordIterations = iterations;
  }
  const session = await createSessionRecord(row.id);
  try {
    await db.batch([
      db.prepare(`
      UPDATE accounts
      SET name = ?, normalized_name = ?, password_salt = ?, password_hash = ?,
          password_iterations = ?, updated_at = ?
      WHERE id = ?
      `).bind(nextName.name, nextName.normalized, salt, passwordHash, row.passwordIterations, Date.now(), row.id),
      db.prepare("DELETE FROM account_sessions WHERE account_id = ?").bind(row.id),
      db.prepare(`
        INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(session.tokenHash, row.id, session.createdAt, session.expiresAt)
    ]);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (String(error?.message ?? "").toLowerCase().includes("unique")) {
      throw new RequestError(409, "ACCOUNT_EXISTS", "account name is already in use");
    }
    throw new RequestError(500, "AUTH_STORAGE_FAILED", "account storage failed");
  }
  return accountPayload(db, { id: row.id, name: nextName.name }, session);
}

export async function logoutAccount(db, account) {
  await db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(account.tokenHash).run();
}

export async function deleteAccount(db, account, input) {
  const row = await db.prepare(`
    SELECT password_salt AS passwordSalt, password_hash AS passwordHash,
           password_iterations AS passwordIterations
    FROM accounts WHERE id = ?
  `).bind(account.id).first();
  if (!row) throw new RequestError(404, "ACCOUNT_NOT_FOUND", "account was not found");
  const password = validatePassword(input?.currentPassword, "currentPassword");
  const actual = await derivePassword(password, row.passwordSalt, row.passwordIterations);
  if (!equalHex(actual, row.passwordHash)) {
    throw new RequestError(401, "INVALID_CREDENTIALS", "current password is incorrect");
  }

  await db.batch([
    db.prepare(`
      DELETE FROM responses
      WHERE id IN (
        SELECT response_id FROM account_responses WHERE account_id = ?
      )
    `).bind(account.id),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id)
  ]);
}

export async function linkResponseToAccount(db, accountId, responseId) {
  if (!accountId) return;
  const existing = await latestResponseId(db, accountId);
  if (existing) {
    throw new RequestError(409, "RESPONSE_ALREADY_EXISTS", "this account already has an active response");
  }
  try {
    await db.prepare(`
      INSERT INTO account_responses (account_id, response_id, linked_at)
      VALUES (?, ?, ?)
    `).bind(accountId, responseId, Date.now()).run();
  } catch (error) {
    if (String(error?.message ?? "").toLowerCase().includes("unique")) {
      throw new RequestError(409, "RESPONSE_ALREADY_EXISTS", "this account already has an active response");
    }
    throw error;
  }
}

export async function listAccountResponses(db, accountId) {
  const rows = await db.prepare(`
    SELECT r.id, r.created_at AS createdAt, r.updated_at AS updatedAt, r.app_version AS appVersion,
           r.consent_version AS consentVersion, r.consent_at AS consentAt,
           r.age, r.gender, r.region, r.occupation, r.party,
           r.free_text AS freeText, r.follow_up_text AS followUpText, r.analysis_status AS analysisStatus,
           r.analysis_json AS analysisJson, r.demo_flag AS demoFlag,
           r.revision AS revision
    FROM account_responses ar
    JOIN responses r ON r.id = ar.response_id
    WHERE ar.account_id = ?
    ORDER BY ar.linked_at DESC
    LIMIT 1
  `).bind(accountId).all();
  const responses = rows.results ?? [];
  if (responses.length === 0) return [];
  const answerRows = await db.prepare(`
    SELECT a.response_id AS responseId, a.qid, a.value
    FROM answers a
    JOIN account_responses ar ON ar.response_id = a.response_id
    WHERE ar.account_id = ?
    ORDER BY a.response_id, a.qid
  `).bind(accountId).all();
  const questionRows = await db.prepare(`
    SELECT rq.response_id AS responseId, rq.qid, rq.position, rq.type, rq.text,
           rq.options_json AS optionsJson, rq.left_label AS leftLabel,
           rq.right_label AS rightLabel
    FROM response_questions rq
    JOIN account_responses ar ON ar.response_id = rq.response_id
    WHERE ar.account_id = ?
    ORDER BY rq.response_id, rq.position
  `).bind(accountId).all();
  const answersById = new Map();
  for (const row of answerRows.results ?? []) {
    const answers = answersById.get(row.responseId) ?? {};
    answers[row.qid] = row.value;
    answersById.set(row.responseId, answers);
  }
  const questionsById = new Map();
  for (const row of questionRows.results ?? []) {
    let options = [];
    try { options = JSON.parse(row.optionsJson); } catch { options = []; }
    const questions = questionsById.get(row.responseId) ?? [];
    questions.push({
      id: row.qid,
      qid: row.qid,
      position: row.position,
      type: row.type,
      text: row.text,
      options,
      left: row.leftLabel || "",
      right: row.rightLabel || ""
    });
    questionsById.set(row.responseId, questions);
  }
  return responses.map(row => {
    let analysis = null;
    try { analysis = row.analysisJson ? JSON.parse(row.analysisJson) : null; } catch { analysis = null; }
    return {
      id: row.id,
      ts: Number(row.createdAt),
      updatedAt: Number(row.updatedAt || row.createdAt || 0),
      ver: String(row.appVersion ?? ""),
      seq: 1,
      revision: Number(row.revision ?? 1),
      demoFlag: Number(row.demoFlag) === 1,
      consent: { version: String(row.consentVersion ?? ""), ts: Number(row.consentAt) },
      demo: {
        age: row.age ?? "", gender: row.gender ?? "", region: row.region ?? "",
        occupation: row.occupation ?? "", party: row.party ?? ""
      },
      answers: answersById.get(row.id) ?? {},
      questions: questionsById.get(row.id) ?? [],
      free: String(row.freeText ?? ""),
      followUpText: row.followUpText == null ? null : String(row.followUpText),
      followUpSubmitted: row.followUpText != null,
      freeQids: ["q_free"],
      analysis,
      analysisStatus: row.analysisStatus
    };
  });
}
