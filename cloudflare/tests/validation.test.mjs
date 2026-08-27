import assert from "node:assert/strict";
import test from "node:test";
import { createResponseId, normalizeSubmission, RequestError } from "../src/validation.mjs";

function fixture(overrides = {}) {
  return {
    appVersion: "0.15.2",
    consent: { accepted: true, version: "1.3", at: 1785744000000 },
    demo: { age: "30代", gender: "回答しない", region: "関東", occupation: "会社員(正社員)", party: "支持政党なし" },
    answers: { q_support: "わからない", q_priority: "子育て・教育" },
    freeText: "教育制度について検討してほしい。",
    ...overrides
  };
}

test("valid submission is normalized without accepting analysis or nodes", () => {
  const result = normalizeSubmission({
    ...fixture(),
    analysis: { params: { valid: 100 } },
    nodes: [{ id: "untrusted" }]
  });
  assert.equal(result.freeText, "教育制度について検討してほしい。");
  assert.equal(result.answers.length, 2);
  assert.equal(Object.hasOwn(result, "analysis"), false);
  assert.equal(Object.hasOwn(result, "nodes"), false);
});

test("consent is mandatory", () => {
  assert.throws(
    () => normalizeSubmission(fixture({ consent: { accepted: false, version: "1.3", at: 1 } })),
    error => error instanceof RequestError && error.code === "CONSENT_REQUIRED"
  );
});

test("unknown demographic values are rejected", () => {
  assert.throws(
    () => normalizeSubmission(fixture({ demo: { age: "秘密の年代" } })),
    error => error instanceof RequestError && error.code === "INVALID_FIELD"
  );
});

test("free text is capped at 1500 Unicode code points", () => {
  assert.throws(
    () => normalizeSubmission(fixture({ freeText: "あ".repeat(1501) })),
    error => error instanceof RequestError && error.code === "INVALID_FIELD"
  );
});

test("response ids are opaque capability identifiers", () => {
  const id = createResponseId(() => "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(id, "r_0123456789abcdef0123456789abcdef");
});

test("public submission cannot classify itself as demo data", () => {
  const result = normalizeSubmission(fixture({ demoFlag: true }));
  assert.equal(result.demoFlag, false);
});

