const TAU = Math.PI * 2;
const DEFAULT_STAGE_WEIGHTS = Object.freeze([0.15, 0.20, 0.25, 0.40]);

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function wrapPhase(value) {
  const wrapped = Number(value) % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

function seededPhase(seed) {
  return (hash32(seed) / 4294967296) * TAU;
}

function magnitudeSquared(real, imaginary) {
  return real * real + imaginary * imaginary;
}

export function calculateBellPairProbabilities({
  schmidtAngle,
  phase,
  leftAngle,
  rightAngle
}) {
  const values = [schmidtAngle, phase, leftAngle, rightAngle];
  if (values.some(value => !Number.isFinite(value))) {
    throw new TypeError("Bell-pair inputs must be finite");
  }

  const alpha = Math.cos(schmidtAngle);
  const betaReal = Math.sin(schmidtAngle) * Math.cos(phase);
  const betaImaginary = Math.sin(schmidtAngle) * Math.sin(phase);
  const leftCosine = Math.cos(leftAngle / 2);
  const leftSine = Math.sin(leftAngle / 2);
  const rightCosine = Math.cos(rightAngle / 2);
  const rightSine = Math.sin(rightAngle / 2);

  const amplitudes = [
    [
      alpha * leftCosine * rightCosine + betaReal * leftSine * rightSine,
      betaImaginary * leftSine * rightSine
    ],
    [
      -alpha * leftCosine * rightSine + betaReal * leftSine * rightCosine,
      betaImaginary * leftSine * rightCosine
    ],
    [
      -alpha * leftSine * rightCosine + betaReal * leftCosine * rightSine,
      betaImaginary * leftCosine * rightSine
    ],
    [
      alpha * leftSine * rightSine + betaReal * leftCosine * rightCosine,
      betaImaginary * leftCosine * rightCosine
    ]
  ];

  const raw = amplitudes.map(([real, imaginary]) => magnitudeSquared(real, imaginary));
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  const normalized = raw.map(value => value / total);

  return Object.freeze({
    "00": normalized[0],
    "01": normalized[1],
    "10": normalized[2],
    "11": normalized[3]
  });
}

export function normalizeDistribution(input) {
  const entries = Array.isArray(input)
    ? input.map(item => [item.key ?? item.label, item.probability ?? item.value ?? item.percent])
    : Object.entries(input || {});

  const cleaned = entries
    .map(([key, raw]) => {
      const numeric = Number(raw);
      const probability = numeric > 1 ? numeric / 100 : numeric;
      return [String(key ?? "").trim(), Math.max(0, Number.isFinite(probability) ? probability : 0)];
    })
    .filter(([key]) => key);

  const total = cleaned.reduce((sum, [, value]) => sum + value, 0);
  if (!(total > 0)) {
    throw new TypeError("Jev answer distribution must contain positive probability mass");
  }

  return Object.freeze(Object.fromEntries(
    cleaned.map(([key, value]) => [key, value / total])
  ));
}

function distributionMetrics(distribution) {
  const entries = Object.entries(distribution);
  const count = Math.max(1, entries.length);
  const entropy = entries.reduce((sum, [, probability]) => (
    probability > 0 ? sum - probability * Math.log2(probability) : sum
  ), 0);
  const maxEntropy = count > 1 ? Math.log2(count) : 1;
  const confidence = clamp(1 - entropy / maxEntropy);

  const sorted = [...entries].sort((left, right) => right[1] - left[1]);
  const margin = clamp((sorted[0]?.[1] ?? 0) - (sorted[1]?.[1] ?? 0), 0, 1);

  let x = 0;
  let y = 0;
  entries.forEach(([, probability], index) => {
    const angle = TAU * index / count;
    x += probability * Math.cos(angle);
    y += probability * Math.sin(angle);
  });

  return Object.freeze({
    entropy,
    confidence,
    margin,
    phaseVector: Object.freeze({ x, y }),
    dominant: sorted[0]?.[0] ?? null
  });
}

export function createInitialEntangledState(options = {}) {
  const coupling = clamp(
    Number.isFinite(options.coupling) ? options.coupling : 0.82,
    0.05,
    0.99
  );
  const schmidtAngle = Math.PI / 4 * coupling;
  const phase = Number.isFinite(options.phase)
    ? wrapPhase(options.phase)
    : seededPhase(options.seed ?? "seiseki-jev-quad");

  const bornProbabilities = calculateBellPairProbabilities({
    schmidtAngle,
    phase,
    leftAngle: 0,
    rightAngle: 0
  });

  return Object.freeze({
    stage: 0,
    coupling,
    schmidtAngle,
    phase,
    leftAngle: 0,
    rightAngle: 0,
    bornProbabilities
  });
}

export function updateEntangledState(previousState, answerDistribution, stage) {
  const distribution = normalizeDistribution(answerDistribution);
  const metrics = distributionMetrics(distribution);

  const coupling = clamp(
    previousState.coupling * 0.55 + (0.5 + metrics.confidence * 0.5) * 0.45,
    0.05,
    0.99
  );
  const schmidtAngle = Math.PI / 4 * coupling;
  const leftAngle = Math.PI * clamp(metrics.phaseVector.x, -1, 1);
  const rightAngle = Math.PI * clamp(metrics.phaseVector.y, -1, 1);
  const phase = wrapPhase(
    previousState.phase
    + Math.atan2(metrics.phaseVector.y, metrics.phaseVector.x || 1e-12)
    + metrics.margin * Math.PI / 2
    + Number(stage || 0) * Math.PI / 16
  );

  const bornProbabilities = calculateBellPairProbabilities({
    schmidtAngle,
    phase,
    leftAngle,
    rightAngle
  });

  return Object.freeze({
    stage,
    coupling,
    schmidtAngle,
    phase,
    leftAngle,
    rightAngle,
    bornProbabilities,
    answerMetrics: metrics
  });
}

export function formatEntangledEquation(state) {
  const alpha = Math.cos(state.schmidtAngle);
  const beta = Math.sin(state.schmidtAngle);
  return [
    `|psi_${state.stage}> = ${alpha.toFixed(6)}|00> + e^(i*${state.phase.toFixed(6)})`,
    `*${beta.toFixed(6)}|11>`
  ].join(" ");
}

function percentages(distribution) {
  return Object.freeze(Object.fromEntries(
    Object.entries(distribution).map(([key, value]) => [key, Number((value * 100).toFixed(4))])
  ));
}

export function buildStageInput({
  stage,
  baseState,
  question,
  criteria,
  quantumState,
  previousStage
}) {
  if (!Number.isInteger(stage) || stage < 1 || stage > 4) {
    throw new RangeError("stage must be an integer from 1 through 4");
  }

  return Object.freeze({
    circuit: Object.freeze({
      id: "seiseki-jev-quad-v1",
      stage,
      totalStages: 4,
      semantics: stage === 1
        ? "baseline"
        : stage === 2
          ? "conditioned-update"
          : stage === 3
            ? "interference-reconciliation"
            : "final-forecast"
    }),
    evidence: baseState,
    entanglement: Object.freeze({
      family: "bell-like-logical-pair",
      equation: formatEntangledEquation(quantumState),
      coupling: quantumState.coupling,
      schmidtAngle: quantumState.schmidtAngle,
      phase: quantumState.phase,
      leftAngle: quantumState.leftAngle,
      rightAngle: quantumState.rightAngle,
      bornProbabilities: quantumState.bornProbabilities
    }),
    previousJev: previousStage
      ? Object.freeze({
          stage: previousStage.stage,
          distribution: previousStage.distribution,
          percentages: previousStage.percentages,
          confidence: previousStage.confidence,
          dominant: previousStage.dominant
        })
      : null,
    target: Object.freeze({
      question: String(question),
      criteria: Object.freeze({ ...criteria })
    })
  });
}

function fuseDistributions(stages, stageWeights = DEFAULT_STAGE_WEIGHTS) {
  const labels = [...new Set(stages.flatMap(stage => Object.keys(stage.distribution)))];
  const scores = Object.fromEntries(labels.map(label => [label, 1]));

  stages.forEach((stage, index) => {
    const weight = Number(stageWeights[index] ?? 0);
    labels.forEach(label => {
      const probability = Math.max(stage.distribution[label] ?? 0, 1e-9);
      scores[label] *= probability ** weight;
    });
  });

  return normalizeDistribution(scores);
}

export async function runFourJevCircuit({
  baseState,
  question,
  criteria,
  invokeJev,
  seed = "seiseki-jev-quad",
  coupling = 0.82,
  stageWeights = DEFAULT_STAGE_WEIGHTS
}) {
  if (typeof invokeJev !== "function") {
    throw new TypeError("invokeJev must be a function");
  }
  if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length < 2) {
    throw new TypeError("criteria must contain at least two prediction choices");
  }

  const stages = [];
  let quantumState = createInitialEntangledState({ seed, coupling });
  let previousStage = null;

  for (let stage = 1; stage <= 4; stage += 1) {
    const input = buildStageInput({
      stage,
      baseState,
      question,
      criteria,
      quantumState,
      previousStage
    });

    const rawResult = await invokeJev(input, stage);
    const distribution = normalizeDistribution(
      rawResult?.distribution ?? rawResult?.probabilities ?? rawResult
    );
    const metrics = distributionMetrics(distribution);

    const stageResult = Object.freeze({
      stage,
      semantics: input.circuit.semantics,
      input,
      distribution,
      percentages: percentages(distribution),
      confidence: metrics.confidence,
      entropy: metrics.entropy,
      dominant: metrics.dominant,
      raw: rawResult
    });

    stages.push(stageResult);
    previousStage = stageResult;
    quantumState = updateEntangledState(quantumState, distribution, stage);
  }

  const fusedDistribution = fuseDistributions(stages, stageWeights);
  const finalMetrics = distributionMetrics(fusedDistribution);

  return Object.freeze({
    circuitId: "seiseki-jev-quad-v1",
    stageCount: 4,
    stages: Object.freeze(stages),
    finalQuantumState: quantumState,
    finalStage: stages[3],
    fusedPrediction: Object.freeze({
      distribution: fusedDistribution,
      percentages: percentages(fusedDistribution),
      dominant: finalMetrics.dominant,
      confidence: finalMetrics.confidence,
      entropy: finalMetrics.entropy,
      stageWeights: Object.freeze([...stageWeights])
    })
  });
}
