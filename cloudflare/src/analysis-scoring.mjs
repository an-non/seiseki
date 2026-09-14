export const POSITIVE_SCORE_ANCHORS = Object.freeze([0, 25, 50, 75, 100]);
export const BIPOLAR_SCORE_ANCHORS = Object.freeze([-100, -50, 0, 50, 100]);

export const SCORE_DISTRIBUTION_SCHEMA = Object.freeze({
  type: "array",
  minItems: 5,
  maxItems: 5,
  items: { type: "number", minimum: 0, maximum: 100 }
});

export function normalizeScoringMode(value) {
  return String(value || "direct").toLowerCase() === "distribution"
    ? "distribution"
    : "direct";
}

export function scoreFromDistribution(distribution, anchors) {
  if (!Array.isArray(distribution) || !Array.isArray(anchors)
      || distribution.length !== anchors.length || anchors.length === 0) return null;
  const weights = distribution.map(Number);
  if (weights.some(weight => !Number.isFinite(weight) || weight < 0)) return null;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return null;
  const expected = weights.reduce((sum, weight, index) => sum + weight * anchors[index], 0) / total;
  return Math.sign(expected) * Math.round(Math.abs(expected));
}

export function deriveDistributedScores(value) {
  const distributions = value?.scoreDistributions;
  if (!distributions || typeof distributions !== "object" || Array.isArray(distributions)) return null;
  const valid = scoreFromDistribution(distributions.valid, POSITIVE_SCORE_ANCHORS);
  const crit = scoreFromDistribution(distributions.crit, POSITIVE_SCORE_ANCHORS);
  const motiv = scoreFromDistribution(distributions.motiv, POSITIVE_SCORE_ANCHORS);
  const econ = scoreFromDistribution(distributions.econ, BIPOLAR_SCORE_ANCHORS);
  const soc = scoreFromDistribution(distributions.soc, BIPOLAR_SCORE_ANCHORS);
  if ([valid, crit, motiv, econ, soc].some(score => score == null)) return null;
  return { valid, crit, motiv, econ, soc };
}

export function withDistributedScores(value) {
  const scores = deriveDistributedScores(value);
  if (!scores) return null;
  return {
    ...value,
    params: {
      ...value.params,
      valid: scores.valid,
      crit: scores.crit,
      motiv: scores.motiv
    },
    ideology: {
      ...value.ideology,
      econ: scores.econ,
      soc: scores.soc
    }
  };
}

export const DISTRIBUTION_PROMPT = [
  "For scoreDistributions, return five integer percentages for each scale.",
  "valid, crit, and motiv use anchors [0, 25, 50, 75, 100] in that order.",
  "econ and soc use anchors [-100, -50, 0, 50, 100] in that order.",
  "Each array must total exactly 100. Values are likelihood weights, not copies of the anchors.",
  "Example: [0, 10, 60, 30, 0] means 10% at the second anchor, 60% at the third, and 30% at the fourth.",
  "Use adjacent anchors to express uncertainty. The server computes the final expected score.",
  "Keep the ordinary numeric score fields present, but scoreDistributions is authoritative."
].join("\n");
