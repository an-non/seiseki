import assert from "node:assert/strict";
import test from "node:test";

import {
  BIPOLAR_SCORE_ANCHORS,
  deriveDistributedScores,
  normalizeScoringMode,
  POSITIVE_SCORE_ANCHORS,
  scoreFromDistribution,
  withDistributedScores
} from "../src/analysis-scoring.mjs";

test("distribution scores are normalized before calculating an expected value", () => {
  assert.equal(scoreFromDistribution([0, 0, 1, 3, 0], POSITIVE_SCORE_ANCHORS), 69);
  assert.equal(scoreFromDistribution([0, 1, 2, 1, 0], BIPOLAR_SCORE_ANCHORS), 0);
});

test("invalid distributions fail closed", () => {
  assert.equal(scoreFromDistribution([0, 0, 0, 0, 0], POSITIVE_SCORE_ANCHORS), null);
  assert.equal(scoreFromDistribution([1, -1, 1, 1, 1], POSITIVE_SCORE_ANCHORS), null);
  assert.equal(scoreFromDistribution([1, 1], POSITIVE_SCORE_ANCHORS), null);
});

test("distributed scores replace only the five calibrated fields", () => {
  const value = {
    params: { emo: { pol: -0.2, label: "negative" }, valid: 0, crit: 0, motiv: 0 },
    ideology: { econ: 0, soc: 0, confidence: 72 },
    attrs: ["education"],
    chunks: [],
    scoreDistributions: {
      valid: [0, 0, 1, 3, 0],
      crit: [0, 0, 0, 1, 1],
      motiv: [0, 1, 3, 0, 0],
      econ: [0, 3, 1, 0, 0],
      soc: [0, 0, 1, 2, 1]
    }
  };
  assert.deepEqual(deriveDistributedScores(value), {
    valid: 69,
    crit: 88,
    motiv: 44,
    econ: -38,
    soc: 50
  });
  const derived = withDistributedScores(value);
  assert.equal(derived.params.emo.pol, -0.2);
  assert.equal(derived.ideology.confidence, 72);
  assert.equal(derived.params.valid, 69);
});

test("scoring mode is opt-in", () => {
  assert.equal(normalizeScoringMode(), "direct");
  assert.equal(normalizeScoringMode("unknown"), "direct");
  assert.equal(normalizeScoringMode("distribution"), "distribution");
});
