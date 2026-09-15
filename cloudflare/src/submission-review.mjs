const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

export function normalizeSubmissionText(freeText, followUpText = "") {
  return [freeText, followUpText]
    .map(value => String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("ja-JP")
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/gu, "")
      .replace(/\s+/gu, " ")
      .trim())
    .filter(Boolean)
    .join("\n");
}

export async function createSubmissionFingerprint(env, freeText, followUpText = "") {
  const secret = String(env?.SUBMISSION_FINGERPRINT_HMAC_SECRET ?? "");
  const normalized = normalizeSubmissionText(freeText, followUpText);
  const configuredMinimum = Number(env?.SUBMISSION_FINGERPRINT_MIN_LENGTH ?? 8);
  const minimumLength = Number.isInteger(configuredMinimum)
    ? Math.min(200, Math.max(8, configuredMinimum))
    : 8;
  if ([...secret].length < 32 || [...normalized].length < minimumLength) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`seiseki-submission-v1\n${normalized}`));
  return Object.freeze({
    inputHmac: bytesToHex(new Uint8Array(signature)),
    normalizedLength: [...normalized].length
  });
}

export async function refreshSubmissionReview(db, responseId, fingerprint, now = Date.now()) {
  if (!fingerprint) {
    await db.prepare("DELETE FROM response_text_fingerprints WHERE response_id = ?").bind(responseId).run();
    await db.prepare("UPDATE responses SET publication_status = 'accepted' WHERE id = ?").bind(responseId).run();
    return { publicationStatus: "accepted", duplicateOf: null };
  }

  await db.prepare(`
    INSERT INTO response_text_fingerprints (response_id, input_hmac, normalized_length, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(response_id) DO UPDATE SET
      input_hmac = excluded.input_hmac,
      normalized_length = excluded.normalized_length,
      updated_at = excluded.updated_at
  `).bind(responseId, fingerprint.inputHmac, fingerprint.normalizedLength, now).run();

  const prior = await db.prepare(`
    SELECT f.response_id AS responseId
    FROM response_text_fingerprints f
    JOIN responses r ON r.id = f.response_id
    WHERE f.input_hmac = ? AND f.response_id <> ?
    ORDER BY r.created_at ASC, f.response_id ASC
    LIMIT 1
  `).bind(fingerprint.inputHmac, responseId).first();
  const publicationStatus = prior ? "held_duplicate" : "accepted";
  await db.prepare("UPDATE responses SET publication_status = ? WHERE id = ?")
    .bind(publicationStatus, responseId).run();
  return { publicationStatus, duplicateOf: prior?.responseId ?? null };
}
