import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBellPairProbabilities,
  createInitialEntangledState,
  normalizeDistribution,
  runFourJevCircuit
} from "../integration/jev-quad-loop/quantum-circuit.mjs";

test("Bell probabilities are normalized", () => {
  const probabilities = calculateBellPairProbabilities({
    schmidtAngle: Math.PI / 6,
    phase: Math.PI / 7,
    leftAngle: Math.PI / 8,
    rightAngle: -Math.PI / 9
  });
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  Object.values(probabilities).forEach(value => {
    assert.ok(value >= 0 && value <= 1);
  });
});

test("distribution accepts percentages and normalizes them", () => {
  assert.deepEqual(
    normalizeDistribution({ alpha: 70, beta: 30 }),
    { alpha: 0.7, beta: 0.3 }
  );
});

test("four-Jev circuit passes each full probability distribution into the next stage", async () => {
  const seen = [];
  const distributions = [
    { up: 0.55, flat: 0.30, down: 0.15 },
    { up: 0.60, flat: 0.25, down: 0.15 },
    { up: 0.64, flat: 0.22, down: 0.14 },
    { up: 0.68, flat: 0.20, down: 0.12 }
  ];

  const result = await runFourJevCircuit({
    baseState: { syntheticSeries: [101, 102, 104, 103] },
    question: "What is the next synthetic direction?",
    criteria: {
      up: "Increase",
      flat: "No material change",
      down: "Decrease"
    },
    seed: "quad-test",
    invokeJev: async input => {
      seen.push(input);
      return { distribution: distributions[input.circuit.stage - 1] };
    }
  });

  assert.equal(result.stageCount, 4);
  assert.equal(seen.length, 4);
  assert.equal(seen[0].previousJev, null);
  assert.deepEqual(seen[1].previousJev.percentages, {
    up: 55,
    flat: 30,
    down: 15
  });
  assert.deepEqual(seen[3].previousJev.percentages, {
    up: 64,
    flat: 22,
    down: 14
  });
  assert.equal(result.finalStage.dominant, "up");
  assert.equal(result.fusedPrediction.dominant, "up");
  assert.equal(
    Object.keys(result.finalQuantumState.bornProbabilities).length,
    4
  );
});

test("initial entangled state is deterministic for a seed", () => {
  const first = createInitialEntangledState({ seed: "same-seed" });
  const second = createInitialEntangledState({ seed: "same-seed" });
  assert.deepEqual(first, second);
});
