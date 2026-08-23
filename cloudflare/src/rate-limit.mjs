import { RequestError } from "./validation.mjs";

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

function requestNetworkId(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

async function fingerprint(scope, value) {
  return sha256Hex(`seiseki-rate-v1|${scope}|${String(value)}`);
}

async function incrementBucket(db, key, resetAt, now) {
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
}

async function consumeWindow(db, scope, subject, limit, windowMs, now) {
  const windowId = Math.floor(now / windowMs);
  const resetAt = (windowId + 1) * windowMs;
  const subjectHash = await fingerprint(scope, subject);
  const key = `${scope}:${windowId}:${subjectHash}`;
  const result = await incrementBucket(db, key, resetAt, now);
  if (result.hitCount > limit) {
    throw new RequestError(429, "RATE_LIMITED", "too many requests; try again later");
  }
  return result;
}

export async function enforceRateLimit(db, request, policy, extraSubject = "") {
  if (!db || !policy) return;
  const now = Date.now();
  const network = requestNetworkId(request);
  for (const rule of policy.network || []) {
    await consumeWindow(db, `${policy.name}:net:${rule.label}`, network, rule.limit, rule.windowMs, now);
  }
  if (extraSubject) {
    for (const rule of policy.subject || []) {
      await consumeWindow(db, `${policy.name}:subject:${rule.label}`, extraSubject, rule.limit, rule.windowMs, now);
    }
  }

  /* Best-effort cleanup. It is intentionally infrequent so an abuse request does not
     turn every API call into a delete-heavy operation. */
  if (Math.floor(now / 60000) % 17 === 0) {
    await db.prepare("DELETE FROM rate_limit_buckets WHERE reset_at < ?")
      .bind(now - 24 * 60 * 60 * 1000).run();
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
  })
});
