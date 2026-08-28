const DEMO_OPTIONS = Object.freeze({
  age: new Set(["10代", "20代", "30代", "40代", "50代", "60代", "70代以上"]),
  gender: new Set(["男性", "女性", "その他", "回答しない"]),
  region: new Set(["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州・沖縄", "海外"]),
  occupation: new Set([
    "会社員(正社員)", "会社員(契約・派遣)", "パート・アルバイト", "公務員・団体職員",
    "経営者・役員", "自営業・フリーランス", "専門職(医療・法務・教育等)", "農林漁業",
    "学生", "専業主婦・主夫", "無職・求職中", "定年退職", "その他"
  ]),
  party: new Set([
    "自民党", "立憲民主党", "日本維新の会", "公明党", "共産党", "国民民主党",
    "れいわ新選組", "参政党", "その他", "支持政党なし", "回答しない"
  ])
});

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "INVALID_BODY", `${name} must be an object`);
  }
  return value;
}

function cleanText(value, max, name, required = false) {
  const text = String(value ?? "").replaceAll("\u0000", "").trim();
  if (required && !text) throw new RequestError(400, "INVALID_FIELD", `${name} is required`);
  if ([...text].length > max) throw new RequestError(400, "INVALID_FIELD", `${name} is too long`);
  return text;
}

function normalizeEpoch(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RequestError(400, "INVALID_FIELD", `${name} must be a positive timestamp`);
  }
  return Math.trunc(number);
}

export function normalizeSubmission(input) {
  const body = requireObject(input, "body");
  const consent = requireObject(body.consent, "consent");
  if (consent.accepted !== true) {
    throw new RequestError(400, "CONSENT_REQUIRED", "consent must be accepted");
  }

  const demoInput = body.demo == null ? {} : requireObject(body.demo, "demo");
  const demo = {};
  for (const [field, allowed] of Object.entries(DEMO_OPTIONS)) {
    const value = cleanText(demoInput[field], field === "party" ? 30 : 20, `demo.${field}`);
    if (value && !allowed.has(value)) {
      throw new RequestError(400, "INVALID_FIELD", `demo.${field} is not allowed`);
    }
    demo[field] = value || null;
  }

  const answerInput = body.answers == null ? {} : requireObject(body.answers, "answers");
  const answers = [];
  for (const [rawQid, rawValue] of Object.entries(answerInput)) {
    const qid = cleanText(rawQid, 64, "answer qid", true);
    const value = cleanText(rawValue, 60, `answers.${qid}`, true);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(qid)) {
      throw new RequestError(400, "INVALID_FIELD", `answers.${qid} has an invalid qid`);
    }
    answers.push(Object.freeze({ qid, value }));
  }
  if (answers.length > 100) {
    throw new RequestError(400, "INVALID_FIELD", "too many answers");
  }

  return Object.freeze({
    appVersion: cleanText(body.appVersion, 20, "appVersion"),
    consentVersion: cleanText(consent.version, 20, "consent.version", true),
    consentAt: normalizeEpoch(consent.at, "consent.at"),
    demo: Object.freeze(demo),
    answers: Object.freeze(answers),
    freeText: cleanText(body.freeText ?? body.free, 1500, "freeText"),
    /* Public submissions cannot classify themselves as demo data. Demo rows are
       marked only by a trusted server-side seeding or administration path. */
    demoFlag: false
  });
}

export function normalizeExpectedRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new RequestError(400, "INVALID_REVISION", "expectedRevision must be a positive integer");
  }
  return revision;
}

export function normalizeFreeTextUpdate(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "freeText"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  return Object.freeze({
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
    freeText: cleanText(body.freeText, 1500, "freeText")
  });
}

function normalizeFollowUpTextBody(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "followUpText"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  return Object.freeze({
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
    followUpText: cleanText(body.followUpText, 1500, "followUpText", true)
  });
}

export function normalizeFollowUpTextCreate(input) {
  return normalizeFollowUpTextBody(input);
}

export function normalizeFollowUpTextUpdate(input) {
  return normalizeFollowUpTextBody(input);
}

export function normalizeFollowUpTextDelete(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  return Object.freeze({ expectedRevision: normalizeExpectedRevision(body.expectedRevision) });
}

export function normalizeInitialResponseUpdate(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "answers", "freeText"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  const answerInput = requireObject(body.answers, "answers");
  const answers = [];
  for (const [rawQid, rawValue] of Object.entries(answerInput)) {
    const qid = cleanText(rawQid, 64, "answer qid", true);
    const value = cleanText(rawValue, 60, "answers." + qid, true);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(qid)) throw new RequestError(400, "INVALID_FIELD", "answers." + qid + " has an invalid qid");
    answers.push(Object.freeze({ qid, value }));
  }
  if (answers.length > 100) throw new RequestError(400, "INVALID_FIELD", "too many answers");
  return Object.freeze({
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
    answers: Object.freeze(answers),
    freeText: cleanText(body.freeText, 1500, "freeText")
  });
}

export function normalizeAnswersUpdate(input) {
  const body = requireObject(input, "body");
  const allowed = new Set(["expectedRevision", "answers"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new RequestError(400, "INVALID_FIELD", "unsupported field: " + key);
  }
  const answerInput = requireObject(body.answers, "answers");
  const answers = [];
  for (const [rawQid, rawValue] of Object.entries(answerInput)) {
    const qid = cleanText(rawQid, 64, "answer qid", true);
    const value = cleanText(rawValue, 60, "answers." + qid, true);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(qid)) {
      throw new RequestError(400, "INVALID_FIELD", "answers." + qid + " has an invalid qid");
    }
    answers.push(Object.freeze({ qid, value }));
  }
  if (answers.length > 100) throw new RequestError(400, "INVALID_FIELD", "too many answers");
  return Object.freeze({ expectedRevision: normalizeExpectedRevision(body.expectedRevision), answers: Object.freeze(answers) });
}

export function createResponseId(randomUUID = () => crypto.randomUUID()) {
  return `r_${randomUUID().replaceAll("-", "")}`;
}
