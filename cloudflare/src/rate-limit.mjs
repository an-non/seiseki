import { RequestError } from "./validation.mjs";

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(signature));
}

function requestNetworkId(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

async function fingerprint(scope, value, secret = "") {
  const payload = `seiseki-rate-v1|${scope}|${String(value)}`;
  return secret ? hmacSha256Hex(secret, payload) : sha256Hex(payload);
}

export class RateLimitError extends RequestError {
  constructor(code, message, retryAt) {
    super(429, code, message);
    this.retryAt = Number(retryAt);
    this.retryAfterSeconds = Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000));
  }
}

export async function enforcePlatformRateLimit(limiter, request, scope, fingerprintSecret = "") {
  if (!limiter?.limit) return;
  const key = await fingerprint(scope, requestNetworkId(request), fingerprintSecret);
  const result = await limiter.limit({ key });
  if (!result?.success) {
    throw new RateLimitError(
      "ANALYSIS_RATE_LIMITED",
      "analysis submissions are temporarily limited; try again in one minute",
      Date.now() + 60 * 1000
    );
  }
}

async function incrementBucket(db, key, resetAt, now) {
  try {
    await db.prepare(`
      INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        hit_count = hit_count + 1,
        updated_at = excluded.updated_at
    `).bind(key, resetAt, now).run();
    const row = await db.prepare(
      "SELECT hit_count AS hitCount, reset_at AS resetAt FROM rate_limit_buckets WHERE bucket_key = ?"
    ).bind(key).first();
    return { hitCount: Number(row?.hitCount || 0), resetAt: Number(row?.resetAt || resetAt) };
  } catch (error) {
    /* Old local/staging databases can briefly exist before migration 0005 is applied.
       Do not break the application merely because the abuse-control table is absent.
       Production release gates explicitly verify this table before deployment. */
    if (String(error?.message ?? error).toLowerCase().includes("no such table")) {
      return { hitCount: 1, resetAt };
    }
    throw error;
  }
}

async function consumeWindow(db, scope, subject, limit, windowMs, now, fingerprintSecret) {
  const windowId = Math.floor(now / windowMs);
  const resetAt = (windowId + 1) * windowMs;
  const subjectHash = await fingerprint(scope, subject, fingerprintSecret);
  const key = `${scope}:${windowId}:${subjectHash}`;
  const result = await incrementBucket(db, key, resetAt, now);
  if (result.hitCount > limit) {
    throw new RateLimitError("RATE_LIMITED", "too many requests; try again later", result.resetAt);
  }
  return result;
}

export async function enforceRateLimit(db, request, policy, extraSubject = "", fingerprintSecret = "") {
  if (!db || !policy) return;
  const now = Date.now();
  const network = requestNetworkId(request);
  for (const rule of policy.network || []) {
    await consumeWindow(db, `${policy.name}:net:${rule.label}`, network, rule.limit, rule.windowMs, now, fingerprintSecret);
  }
  if (extraSubject) {
    for (const rule of policy.subject || []) {
      await consumeWindow(db, `${policy.name}:subject:${rule.label}`, extraSubject, rule.limit, rule.windowMs, now, fingerprintSecret);
    }
  }

  if (Math.floor(now / 60000) % 17 === 0) {
    try {
      await db.prepare("DELETE FROM rate_limit_buckets WHERE reset_at < ?")
        .bind(now - 24 * 60 * 60 * 1000).run();
    } catch (error) {
      if (!String(error?.message ?? error).toLowerCase().includes("no such table")) throw error;
    }
  }
}

export const RATE_LIMIT_POLICIES = Object.freeze({
  login: Object.freeze({
    name: "login",
    network: Object.freeze([
      Object.freeze({ label: "minute", limit: 10, windowMs: 60 * 1000 }),
      Object.freeze({ label: "hour", limit: 60, windowMs: 60 * 60 * 1000 })
    ]),
    subject: Object.freeze([
      Object.freeze({ label: "minute", limit: 10, windowMs: 60 * 1000 })
    ])
  }),
  recovery: Object.freeze({
    name: "recovery",
    network: Object.freeze([
      Object.freeze({ label: "ten-minute", limit: 5, windowMs: 10 * 60 * 1000 }),
      Object.freeze({ label: "day", limit: 20, windowMs: 24 * 60 * 60 * 1000 })
    ]),
    subject: Object.freeze([
      Object.freeze({ label: "ten-minute", limit: 5, windowMs: 10 * 60 * 1000 })
    ])
  }),
  register: Object.freeze({
    name: "register",
    network: Object.freeze([
      Object.freeze({ label: "ten-minute", limit: 5, windowMs: 10 * 60 * 1000 }),
      Object.freeze({ label: "day", limit: 20, windowMs: 24 * 60 * 60 * 1000 })
    ]),
    subject: Object.freeze([])
  }),
  response: Object.freeze({
    name: "response",
    network: Object.freeze([
      Object.freeze({ label: "ten-minute", limit: 20, windowMs: 10 * 60 * 1000 }),
      Object.freeze({ label: "day", limit: 100, windowMs: 24 * 60 * 60 * 1000 })
    ]),
    subject: Object.freeze([])
  }),
  analysisRequeue: Object.freeze({
    name: "analysis-requeue",
    network: Object.freeze([
      Object.freeze({ label: "ten-minute", limit: 10, windowMs: 10 * 60 * 1000 }),
      Object.freeze({ label: "day", limit: 50, windowMs: 24 * 60 * 60 * 1000 })
    ]),
    subject: Object.freeze([
      Object.freeze({ label: "cooldown", limit: 1, windowMs: 15 * 1000 }),
      Object.freeze({ label: "ten-minute", limit: 3, windowMs: 10 * 60 * 1000 })
    ])
  })
});
