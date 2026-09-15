const PI_OVER_FOUR = Math.PI / 4;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function assertFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function freezeRecord(value) {
  return Object.freeze(value);
}

function normalizedToken(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/\s+/gu, " ")
    .trim();
}

function asValues(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function uniqueNormalized(values) {
  return Object.freeze([...new Set(values.flatMap(asValues).map(normalizedToken).filter(Boolean))]);
}

function uniqueExactStrings(values) {
  return Object.freeze([...new Set(values.flatMap(asValues)
    .map(value => String(value ?? "").trim())
    .filter(Boolean))]);
}

function collectValues(members, keys) {
  return uniqueNormalized(members.flatMap(member => keys.flatMap(key => asValues(member[key]))));
}

function summarizeAxis(members, key) {
  const values = members.map(member => Number(member[key])).filter(Number.isFinite);
  if (values.length === 0) return freezeRecord({ mean: null, variance: null, count: 0 });
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return freezeRecord({ mean, variance, count: values.length });
}

function jaccard(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (left.size === 0 && right.size === 0) return 0;
  const intersection = [...left].filter(value => right.has(value)).length;
  return intersection / (left.size + right.size - intersection);
}

function sharedValues(leftValues, rightValues) {
  const right = new Set(rightValues);
  return Object.freeze(leftValues.filter(value => right.has(value)));
}

function hasAny(values, candidates) {
  const source = new Set(values);
  return candidates.some(candidate => source.has(candidate));
}

const POSITIVE_STANCES = Object.freeze([
  "support", "request", "approve", "favor", "賛成", "要求", "支持"
]);
const NEGATIVE_STANCES = Object.freeze([
  "oppose", "reject", "反対", "拒否"
]);
const SEMANTIC_DIMENSIONS = Object.freeze([
  Object.freeze({ key: "targets", weight: 0.3 }),
  Object.freeze({ key: "actions", weight: 0.2 }),
  Object.freeze({ key: "conditions", weight: 0.15 }),
  Object.freeze({ key: "lenses", weight: 0.15 }),
  Object.freeze({ key: "topics", weight: 0.1 }),
  Object.freeze({ key: "claims", weight: 0.1 })
]);
const RELATION_PHASES = Object.freeze({
  aligned: 0,
  "cross-domain": Math.PI / 4,
  structural: Math.PI / 3,
  conditional: Math.PI / 2,
  conflict: Math.PI
});
const OBSERVATION_BASIS_WEIGHTS = Object.freeze({
  overall: Object.freeze([0.5, 0.3, 0.2]),
  urgency: Object.freeze([1, 0, 0]),
  motivation: Object.freeze([0, 1, 0]),
  validity: Object.freeze([0, 0, 1])
});

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

export function buildQuantumNodeProfile(group, sourceNodeById) {
  if (!group || !Array.isArray(group.memberIds)) {
    throw new TypeError("group.memberIds must be an array");
  }
  if (!(sourceNodeById instanceof Map)) {
    throw new TypeError("sourceNodeById must be a Map");
  }
  const members = group.memberIds.map(id => sourceNodeById.get(id)).filter(Boolean);
  if (members.length === 0) throw new RangeError("quantum node must retain at least one source member");

  const semanticSignature = freezeRecord({
    targets: collectValues(members, ["target", "targets"]),
    actions: collectValues(members, ["action", "actions", "predicate", "predicates"]),
    conditions: collectValues(members, ["condition", "conditions"]),
    topics: collectValues(members, ["topicLabel", "topicId", "topics"]),
    lenses: collectValues(members, ["lens", "lenses"]),
    stances: collectValues(members, ["stance", "stances"]),
    emotions: collectValues(members, ["emotion", "emotions"]),
    claims: collectValues(members, ["statement", "statements"])
  });
  const statusSummary = freezeRecord({
    urgency: summarizeAxis(members, "urgency"),
    motivation: summarizeAxis(members, "motivation"),
    validity: summarizeAxis(members, "validity")
  });
  const sourceIds = uniqueExactStrings(members.flatMap(member => (
    member.sourceIds?.length ? member.sourceIds : [member.sourceId ?? member.id]
  )));

  return freezeRecord({
    id: String(group.id),
    groupKey: String(group.key ?? group.id),
    memberIds: Object.freeze([...group.memberIds]),
    sourceIds,
    semanticSignature,
    statusSummary,
    displayText: String(group.derivedContent?.text ?? ""),
    derivedSourceNodeIds: Object.freeze([...(group.derivedContent?.sourceNodeIds ?? [])]),
    observationKey: String(group.derivedContent?.observationKey ?? "")
  });
}

export function buildQuantumNodeProfiles(groups, sourceNodeById) {
  if (!Array.isArray(groups)) throw new TypeError("groups must be an array");
  return Object.freeze(groups.map(group => buildQuantumNodeProfile(group, sourceNodeById)));
}

function statusDistance(left, right) {
  const differences = ["urgency", "motivation", "validity"].flatMap(key => {
    const leftMean = left.statusSummary[key].mean;
    const rightMean = right.statusSummary[key].mean;
    return Number.isFinite(leftMean) && Number.isFinite(rightMean)
      ? [Math.abs(leftMean - rightMean) / 100]
      : [];
  });
  return differences.length > 0
    ? differences.reduce((total, value) => total + value, 0) / differences.length
    : 0;
}

function relationFacets(left, right, shared) {
  const leftStances = left.semanticSignature.stances;
  const rightStances = right.semanticSignature.stances;
  const leftPositive = hasAny(leftStances, POSITIVE_STANCES);
  const rightPositive = hasAny(rightStances, POSITIVE_STANCES);
  const leftNegative = hasAny(leftStances, NEGATIVE_STANCES);
  const rightNegative = hasAny(rightStances, NEGATIVE_STANCES);
  const commonSubject = shared.targets.length > 0 || shared.actions.length > 0 || shared.claims.length > 0;
  const facets = [];
  if (commonSubject && ((leftPositive && rightNegative) || (leftNegative && rightPositive))) {
    facets.push("conflict");
  }
  if (commonSubject
      && left.semanticSignature.conditions.length > 0
      && right.semanticSignature.conditions.length > 0
      && shared.conditions.length === 0) {
    facets.push("conditional");
  }
  if ((shared.targets.length > 0 || shared.actions.length > 0)
      && shared.topics.length === 0) {
    facets.push("cross-domain");
  }
  if (commonSubject && ((leftPositive && rightPositive) || (leftNegative && rightNegative))) {
    facets.push("aligned");
  }
  if (facets.length === 0) facets.push("structural");
  return Object.freeze(facets);
}

function primaryRelationKind(facets) {
  return ["conflict", "cross-domain", "conditional", "aligned", "structural"]
    .find(kind => facets.includes(kind)) ?? "structural";
}

export function calculateQuantumNodeRelation(left, right, options = {}) {
  if (!left?.semanticSignature || !right?.semanticSignature) {
    throw new TypeError("quantum node profiles must include semanticSignature");
  }
  const statusInfluence = clamp(Number.isFinite(options.statusInfluence)
    ? options.statusInfluence
    : 0.3);
  let availableWeight = 0;
  let comparableWeight = 0;
  let weightedOverlap = 0;
  const shared = {};

  for (const dimension of SEMANTIC_DIMENSIONS) {
    const leftValues = left.semanticSignature[dimension.key];
    const rightValues = right.semanticSignature[dimension.key];
    const available = leftValues.length > 0 || rightValues.length > 0;
    const comparable = leftValues.length > 0 && rightValues.length > 0;
    if (available) availableWeight += dimension.weight;
    if (comparable) comparableWeight += dimension.weight;
    weightedOverlap += dimension.weight * jaccard(leftValues, rightValues);
    shared[dimension.key] = sharedValues(leftValues, rightValues);
  }

  const semanticEvidence = availableWeight > 0 ? weightedOverlap / availableWeight : 0;
  const evidenceCoverage = availableWeight > 0 ? comparableWeight / availableWeight : 0;
  const normalizedStatusDistance = statusDistance(left, right);
  const sourceOverlap = jaccard(left.sourceIds, right.sourceIds);
  const baseStrength = clamp(semanticEvidence * (1 - statusInfluence * normalizedStatusDistance));
  const independentStrength = clamp(baseStrength * (1 - sourceOverlap));
  const frozenShared = freezeRecord(Object.fromEntries(
    Object.entries(shared).map(([key, values]) => [key, Object.freeze([...values])])
  ));
  const facets = relationFacets(left, right, frozenShared);

  return freezeRecord({
    id: [left.id, right.id].sort().join("|"),
    leftId: left.id,
    rightId: right.id,
    kind: primaryRelationKind(facets),
    facets,
    semanticEvidence,
    evidenceCoverage,
    statusDistance: normalizedStatusDistance,
    sourceOverlap,
    baseStrength,
    independentStrength,
    shared: frozenShared
  });
}

function basisValue(profile, basis) {
  const weights = OBSERVATION_BASIS_WEIGHTS[basis] ?? OBSERVATION_BASIS_WEIGHTS.overall;
  return clamp(
    ["urgency", "motivation", "validity"].reduce((total, key, index) => {
      const mean = profile.statusSummary[key].mean;
      return total + (Number.isFinite(mean) ? mean / 100 : 0.5) * weights[index];
    }, 0)
  );
}

function validityReliability(profile) {
  const mean = profile.statusSummary.validity.mean;
  return Number.isFinite(mean) ? clamp(mean / 100) : 0.5;
}

export function observeQuantumNodeRelation(relation, left, right, options = {}) {
  const basis = OBSERVATION_BASIS_WEIGHTS[options.basis] ? options.basis : "overall";
  const interferenceInfluence = clamp(Number.isFinite(options.interferenceInfluence)
    ? options.interferenceInfluence
    : 0.35);
  const leftMembership = clamp(0.65 * relation.baseStrength + 0.35 * basisValue(left, basis));
  const rightMembership = clamp(0.65 * relation.baseStrength + 0.35 * basisValue(right, basis));
  const entanglement = clamp(
    relation.independentStrength
    * Math.sqrt(validityReliability(left) * validityReliability(right))
  );
  const phase = Number.isFinite(options.phase)
    ? options.phase
    : RELATION_PHASES[relation.kind] ?? RELATION_PHASES.structural;
  const diagnostics = calculateMatchedBellDiagnostics({
    entanglement,
    phase,
    leftKetAngle: leftMembership * Math.PI / 2,
    rightKetAngle: rightMembership * Math.PI / 2,
    leftMeasurementPhase: Number(options.leftMeasurementPhase) || 0,
    rightMeasurementPhase: Number(options.rightMeasurementPhase) || 0
  });
  const observedStrength = clamp(
    relation.baseStrength * (1 + interferenceInfluence * diagnostics.normalizedInterference)
  );

  return freezeRecord({
    ...relation,
    basis,
    entanglement,
    phase,
    leftMembership,
    rightMembership,
    observedStrength,
    diagnostics
  });
}

function unionValues(left, right) {
  return uniqueNormalized([...left, ...right]);
}

function unionExactStrings(left, right) {
  return uniqueExactStrings([...left, ...right]);
}

function diversityScore(values) {
  const count = new Set(values).size;
  return count <= 1 ? 0 : 1 - 1 / count;
}

function meanValidity(left, right) {
  return (validityReliability(left) + validityReliability(right)) / 2;
}

function firstSharedOrFallback(relation, left, right) {
  return relation.shared.targets[0]
    || relation.shared.actions[0]
    || relation.shared.claims[0]
    || left.semanticSignature.targets[0]
    || right.semanticSignature.targets[0]
    || left.semanticSignature.actions[0]
    || right.semanticSignature.actions[0]
    || "観測対象";
}

function derivedProblemLabel(relation, left, right) {
  const subject = firstSharedOrFallback(relation, left, right);
  const topics = unionValues(left.semanticSignature.topics, right.semanticSignature.topics);
  const lenses = unionValues(left.semanticSignature.lenses, right.semanticSignature.lenses);
  if (relation.kind === "conflict") return `${subject}を巡る立場の対立`;
  if (relation.kind === "conditional") return `${subject}の成立条件に関する問い`;
  if (relation.kind === "cross-domain" && topics.length >= 2) {
    return `${subject}に関する${topics[0]}と${topics[1]}の接続問題`;
  }
  if (relation.kind === "aligned") return `${subject}に関する共通課題`;
  if (lenses.length >= 2) return `${lenses[0]}と${lenses[1]}から見た関連課題`;
  return `${subject}に関する観測上の関連課題`;
}

function mergeStatusSummary(left, right) {
  return freezeRecord(Object.fromEntries(["urgency", "motivation", "validity"].map(key => {
    const components = [left.statusSummary[key], right.statusSummary[key]];
    const totalCount = components.reduce((total, item) => total + item.count, 0);
    if (totalCount === 0) return [key, freezeRecord({ mean: null, variance: null, count: 0 })];
    const mean = components.reduce((total, item) => (
      total + (item.mean ?? 0) * item.count
    ), 0) / totalCount;
    const variance = components.reduce((total, item) => {
      if (item.count === 0) return total;
      return total + item.count * ((item.variance ?? 0) + ((item.mean ?? mean) - mean) ** 2);
    }, 0) / totalCount;
    return [key, freezeRecord({ mean, variance, count: totalCount })];
  })));
}

function createDerivedProblemNode(observedRelation, left, right, options) {
  const sourceIds = unionExactStrings(left.sourceIds, right.sourceIds);
  const topics = unionValues(left.semanticSignature.topics, right.semanticSignature.topics);
  const conditions = unionValues(left.semanticSignature.conditions, right.semanticSignature.conditions);
  const topicDiversity = diversityScore(topics);
  const conditionDiversity = diversityScore(conditions);
  const structuralNovelty = clamp(
    0.5 * (1 - observedRelation.sourceOverlap)
    + 0.3 * topicDiversity
    + 0.2 * conditionDiversity
  );
  const evidence = clamp(observedRelation.baseStrength * meanValidity(left, right));
  const observationDependence = Math.abs(observedRelation.diagnostics.normalizedInterference);
  const mainIssueConnection = clamp(
    0.55 * observedRelation.semanticEvidence
    + 0.25 * topicDiversity
    + 0.2 * observedRelation.evidenceCoverage
  );
  const coreAffinity = clamp(evidence * mainIssueConnection);
  const signature = freezeRecord(Object.fromEntries(
    Object.keys(left.semanticSignature).map(key => [
      key,
      unionValues(left.semanticSignature[key], right.semanticSignature[key])
    ])
  ));
  const identity = [
    left.id,
    right.id,
    options.basis,
    options.seed,
    options.epoch,
    observedRelation.kind
  ].join("|");

  return freezeRecord({
    id: `derived-problem-${hash32(identity).toString(16).padStart(8, "0")}`,
    kind: "derived-problem",
    relationKind: observedRelation.kind,
    label: derivedProblemLabel(observedRelation, left, right),
    sourceQuantumNodeIds: Object.freeze([left.id, right.id]),
    sourceIds,
    semanticSignature: signature,
    statusSummary: mergeStatusSummary(left, right),
    evidence,
    structuralNovelty,
    observationDependence,
    mainIssueConnection,
    coreAffinity,
    depth: 1,
    observationKey: `${options.seed}:${options.epoch}:${options.basis}:${observedRelation.id}`,
    diagnostics: observedRelation.diagnostics
  });
}

export function observeQuantumNodeNetwork(profiles, options = {}) {
  if (!Array.isArray(profiles)) throw new TypeError("profiles must be an array");
  const basis = OBSERVATION_BASIS_WEIGHTS[options.basis] ? options.basis : "overall";
  const seed = String(options.seed ?? "quantum-node-relations-v2");
  const epoch = Number.isInteger(options.epoch) ? options.epoch : 0;
  const minimumRelation = clamp(Number.isFinite(options.minimumRelation)
    ? options.minimumRelation
    : 0.18);
  const minimumEvidence = clamp(Number.isFinite(options.minimumEvidence)
    ? options.minimumEvidence
    : 0.2);
  const minimumNovelty = clamp(Number.isFinite(options.minimumNovelty)
    ? options.minimumNovelty
    : 0.45);
  const minimumObservationDependence = clamp(Number.isFinite(options.minimumObservationDependence)
    ? options.minimumObservationDependence
    : 0.04);
  const maximumRelations = Math.max(0, Math.trunc(options.maximumRelations ?? 256));
  const maximumDerivedNodes = Math.max(0, Math.trunc(options.maximumDerivedNodes ?? 24));
  const relations = [];

  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      const base = calculateQuantumNodeRelation(left, right, options);
      if (base.baseStrength < minimumRelation) continue;
      relations.push(observeQuantumNodeRelation(base, left, right, {
        ...options,
        basis
      }));
    }
  }

  relations.sort((left, right) => (
    right.observedStrength - left.observedStrength
    || right.independentStrength - left.independentStrength
    || left.id.localeCompare(right.id)
  ));
  const selectedRelations = relations.slice(0, maximumRelations);
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const derivedNodes = selectedRelations.flatMap(relation => {
    const left = profileById.get(relation.leftId);
    const right = profileById.get(relation.rightId);
    const candidate = createDerivedProblemNode(relation, left, right, { basis, seed, epoch });
    if (candidate.sourceIds.length < 2) return [];
    if (candidate.evidence < minimumEvidence) return [];
    if (candidate.structuralNovelty < minimumNovelty) return [];
    if (candidate.observationDependence < minimumObservationDependence) return [];
    return [candidate];
  }).sort((left, right) => (
    right.coreAffinity - left.coreAffinity
    || right.observationDependence - left.observationDependence
    || left.id.localeCompare(right.id)
  )).slice(0, maximumDerivedNodes);

  return freezeRecord({
    version: "quantum-node-relations-v2",
    basis,
    seed,
    epoch,
    profiles: Object.freeze([...profiles]),
    relations: Object.freeze(selectedRelations),
    derivedNodes: Object.freeze(derivedNodes),
    recursiveDepthLimit: 1
  });
}

/**
 * Compares a Bell-like pure state with two matched controls.
 *
 * ketAngle follows |v> = cos(a)|0> + exp(i beta)sin(a)|1> directly.
 * It is therefore half of the rotation angle used by the legacy engine.
 */
export function calculateMatchedBellDiagnostics({
  entanglement = 0,
  phase = 0,
  leftKetAngle = 0,
  rightKetAngle = 0,
  leftMeasurementPhase = 0,
  rightMeasurementPhase = 0
} = {}) {
  for (const [name, value] of Object.entries({
    entanglement,
    phase,
    leftKetAngle,
    rightKetAngle,
    leftMeasurementPhase,
    rightMeasurementPhase
  })) assertFinite(name, value);

  const normalizedEntanglement = clamp(entanglement);
  const schmidtAngle = PI_OVER_FOUR * normalizedEntanglement;
  const alpha = Math.cos(schmidtAngle);
  const beta = Math.sin(schmidtAngle);
  const leftCosine = Math.cos(leftKetAngle);
  const leftSine = Math.sin(leftKetAngle);
  const rightCosine = Math.cos(rightKetAngle);
  const rightSine = Math.sin(rightKetAngle);
  const relativePhase = phase - leftMeasurementPhase - rightMeasurementPhase;

  const zeroBranch = alpha * leftCosine * rightCosine;
  const oneBranch = beta * leftSine * rightSine;
  const interferenceTerm = 2 * zeroBranch * oneBranch * Math.cos(relativePhase);
  const pureProbability = clamp(
    zeroBranch * zeroBranch + oneBranch * oneBranch + interferenceTerm
  );
  const dephasedProbability = clamp(
    zeroBranch * zeroBranch + oneBranch * oneBranch
  );

  const zeroWeight = alpha * alpha;
  const oneWeight = beta * beta;
  const leftMarginalProbability = clamp(
    zeroWeight * leftCosine * leftCosine + oneWeight * leftSine * leftSine
  );
  const rightMarginalProbability = clamp(
    zeroWeight * rightCosine * rightCosine + oneWeight * rightSine * rightSine
  );
  const productProbability = clamp(leftMarginalProbability * rightMarginalProbability);
  const interferenceDelta = pureProbability - dephasedProbability;
  const independenceDelta = pureProbability - productProbability;

  return freezeRecord({
    family: "matched-bell-diagnostics-v2",
    entanglement: normalizedEntanglement,
    schmidtAngle,
    phase,
    measurement: freezeRecord({
      leftKetAngle,
      rightKetAngle,
      leftMeasurementPhase,
      rightMeasurementPhase
    }),
    probabilities: freezeRecord({
      pure: pureProbability,
      dephased: dephasedProbability,
      product: productProbability,
      leftMarginal: leftMarginalProbability,
      rightMarginal: rightMarginalProbability
    }),
    interferenceDelta,
    independenceDelta,
    normalizedInterference: clamp(interferenceDelta * 4, -1, 1),
    normalizedIndependence: clamp(independenceDelta * 4, -1, 1)
  });
}
