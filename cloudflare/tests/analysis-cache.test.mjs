import assert from "node:assert/strict";
import test from "node:test";

import { analysisCacheKey } from "../src/analysis-cache.mjs";

const env = { ANALYSIS_CACHE_HMAC_SECRET: "test-only-secret-with-at-least-32-characters" };
const input = {
  engine: "workers-ai-hybrid-v1",
  model: "@cf/example/model",
  promptVersion: "prompt-v1",
  scoringMode: "direct",
  prompt: "normalized complete analysis input"
};

test("analysis cache is disabled unless a sufficiently long secret is configured", async () => {
  assert.equal(await analysisCacheKey({}, input), null);
  assert.equal(await analysisCacheKey({ ANALYSIS_CACHE_HMAC_SECRET: "short" }, input), null);
});

test("analysis cache key is stable but separates every analysis contract component", async () => {
  const first = await analysisCacheKey(env, input);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(await analysisCacheKey(env, { ...input }), first);
  for (const changed of [
    { prompt: input.prompt + " changed" },
    { model: "@cf/example/other" },
    { promptVersion: "prompt-v2" },
    { scoringMode: "distribution" }
  ]) {
    assert.notEqual(await analysisCacheKey(env, { ...input, ...changed }), first);
  }
});
