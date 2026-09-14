const encoder = new TextEncoder();
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function bytesToHex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

function cacheSecret(env) {
  const secret = String(env?.ANALYSIS_CACHE_HMAC_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function ttlMilliseconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(60_000, Math.min(365 * 24 * 60 * 60 * 1000, Math.trunc(parsed)))
    : DEFAULT_TTL_MS;
}

export async function analysisCacheKey(env, input) {
  const secret = cacheSecret(env);
  if (!secret) return null;
  const payload = JSON.stringify({
    version: 1,
    engine: String(input.engine || ""),
    model: String(input.model || ""),
    promptVersion: String(input.promptVersion || ""),
    scoringMode: String(input.scoringMode || "direct"),
    prompt: String(input.prompt || "")
  });
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

export async function getCachedAnalysis(db, inputHmac, configuredTtlMs) {
  const minimumCreatedAt = Date.now() - ttlMilliseconds(configuredTtlMs);
  const row = await db.prepare(`
    SELECT analysis_json AS analysisJson
    FROM analysis_cache
    WHERE input_hmac = ? AND created_at >= ?
  `).bind(inputHmac, minimumCreatedAt).first();
  if (!row?.analysisJson) return null;
  try {
    return { analysis: JSON.parse(row.analysisJson) };
  } catch {
    return null;
  }
}

export async function putCachedAnalysis(db, inputHmac, analysis, metadata) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO analysis_cache (
      input_hmac, engine, model, prompt_version, scoring_mode,
      analysis_json, created_at, last_used_at, hit_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(input_hmac) DO UPDATE SET
      analysis_json = excluded.analysis_json,
      last_used_at = excluded.last_used_at
  `).bind(
    inputHmac,
    String(metadata.engine || ""),
    String(metadata.model || ""),
    String(metadata.promptVersion || ""),
    String(metadata.scoringMode || "direct"),
    JSON.stringify(analysis),
    now,
    now
  ).run();
}

export async function touchCachedAnalysis(db, inputHmac) {
  await db.prepare(`
    UPDATE analysis_cache
    SET last_used_at = ?, hit_count = hit_count + 1
    WHERE input_hmac = ?
  `).bind(Date.now(), inputHmac).run();
}
