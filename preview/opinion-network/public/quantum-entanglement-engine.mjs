const DEFAULT_BASIS_WEIGHTS = Object.freeze({
  overall: Object.freeze([0.5, 0.3, 0.2]),
  urgency: Object.freeze([1, 0, 0]),
  motivation: Object.freeze([0, 1, 0]),
  validity: Object.freeze([0, 0, 1])
});

export const DEFAULT_DISTANCE_BOUNDS = Object.freeze({ min: 5.5, max: 30 });

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

function random01(value) {
  let state = hash32(value) || 0x9e3779b9;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

function unitVector(value) {
  const longitude = random01(`${value}|longitude`) * Math.PI * 2;
  const vertical = random01(`${value}|latitude`) * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  return {
    x: radial * Math.cos(longitude),
    y: vertical,
    z: radial * Math.sin(longitude)
  };
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function weightedScore(node, weights) {
  return clamp(
    (node.urgency / 100) * weights[0]
    + (node.motivation / 100) * weights[1]
    + (node.validity / 100) * weights[2]
  );
}

function parameterSimilarity(node, mean) {
  const difference = Math.abs(node.urgency - mean.urgency)
    + Math.abs(node.motivation - mean.motivation)
    + Math.abs(node.validity - mean.validity);
  return clamp(1 - difference / 300);
}

function chooseObservedTopic(node, roll, groupBit, coupling) {
  const candidates = [...new Set([
    node.topicId,
    ...(node.candidateTopicIds || [])
  ].filter(Boolean))];
  if (candidates.length === 1) return candidates[0];

  const stayProbability = clamp(0.58 + coupling * 0.24, 0.58, 0.82);
  if (roll < stayProbability) return candidates[0];
  const alternatives = candidates.slice(1);
  const offset = Math.floor(
    ((roll - stayProbability) / Math.max(1e-9, 1 - stayProbability)) * alternatives.length
  );
  return alternatives[(offset + groupBit) % alternatives.length];
}

function edgeKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`;
}

function uniqueValues(values, limit = Infinity) {
  const result = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function trimSentence(value) {
  return String(value ?? "").trim().replace(/[。！？!?]+$/u, "");
}

function topicLabelFromText(value) {
  return String(value ?? "").match(/^(.+?)について[、,]/u)?.[1]?.trim() || "";
}

function compactQuote(value, maximum = 52) {
  const compact = trimSentence(value).replace(/\s+/gu, " ");
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function deriveEntangledContent(group, sourceMembers, projectionById, groupSample, sample) {
  const ranked = sourceMembers.map(source => {
    const observed = projectionById.get(source.id);
    const observationRoll = random01(
      `${sample.seed}|${sample.epoch}|${sample.basis}|${group.id}|content|${source.id}`
    );
    return {
      source,
      observed,
      score: observed.observedWeight * 0.45
        + observed.coupling * 0.2
        + (observed.bornProbability ?? (observed.bit === groupSample.groupBit ? 1 : 0)) * 0.2
        + observationRoll * 0.15
    };
  }).sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id));

  const selected = [];
  for (const candidate of ranked) {
    if (selected.some(item => item.source.normalizedContent === candidate.source.normalizedContent)) continue;
    selected.push(candidate);
    if (selected.length >= 3) break;
  }
  const sources = selected.map(item => item.source);
  const topics = uniqueValues(sources.map(source => source.topicLabel || topicLabelFromText(source.text)), 2);
  const targets = uniqueValues(sources.map(source => source.target), 2);
  const lenses = uniqueValues(sources.map(source => source.lens), 2);
  const statements = uniqueValues(sources.map(source => trimSentence(source.statement)), 2);
  const structured = topics.length > 0 && targets.length > 0 && lenses.length > 0 && statements.length > 0;

  let text;
  let method;
  if (structured) {
    const subject = topics.join("と");
    const target = targets.join("と");
    const lens = lenses.join("と");
    text = `${subject}について、${target}を対象に${lens}の観点を重ね、${statements[0]}。`;
    if (statements[1]) text += `あわせて、${statements[1]}。`;
    method = "deterministic-structured-recombination-v1";
  } else {
    const fragments = uniqueValues(sources.map(source => compactQuote(source.text)), 3);
    const quoted = fragments.map(fragment => `「${fragment}」`);
    text = quoted.length > 1
      ? `${quoted.slice(0, -1).join("、")}と${quoted.at(-1)}を重ねて検討する。`
      : `${quoted[0] || "構成意見"}を観測軸から再検討する。`;
    method = "deterministic-text-recombination-v1";
  }

  return Object.freeze({
    text,
    method,
    sourceNodeIds: Object.freeze(sources.map(source => source.id)),
    observationKey: `${sample.seed}:${sample.epoch}:${sample.basis}:${group.id}`
  });
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
  for (const value of [schmidtAngle, phase, leftAngle, rightAngle]) {
    if (!Number.isFinite(value)) throw new TypeError("quantum amplitude input must be finite");
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

function binaryEntropy(probability) {
  if (probability <= 0 || probability >= 1) return 0;
  return -probability * Math.log2(probability)
    - (1 - probability) * Math.log2(1 - probability);
}

function sampleJointOutcome(probabilities, roll) {
  let cumulative = 0;
  for (const outcome of ["00", "01", "10", "11"]) {
    cumulative += probabilities[outcome];
    if (roll < cumulative) return outcome;
  }
  return "11";
}

export function normalizeContent(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deduplicateNodes(nodes) {
  const byContent = new Map();
  for (const source of nodes) {
    const normalizedContent = normalizeContent(source.text);
    if (!normalizedContent) continue;
    const existing = byContent.get(normalizedContent);
    if (existing) {
      existing.occurrenceCount += 1;
      existing.sourceIds.push(source.sourceId ?? source.id);
      if (!existing.sourceTopicIds.includes(source.topicId)) {
        existing.sourceTopicIds.push(source.topicId);
      }
      continue;
    }
    byContent.set(normalizedContent, {
      ...source,
      normalizedContent,
      occurrenceCount: 1,
      sourceIds: [source.sourceId ?? source.id],
      sourceTopicIds: [source.topicId]
    });
  }
  return [...byContent.values()].map((node, index) => ({ ...node, index }));
}

export function buildEntanglementGroups(nodes) {
  const grouped = new Map();
  for (const node of nodes) {
    const key = node.entanglementKey || `fallback-${hash32(node.normalizedContent) % 72}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }

  return [...grouped.entries()].map(([key, members], index) => {
    const mean = members.reduce((result, node) => ({
      urgency: result.urgency + node.urgency / members.length,
      motivation: result.motivation + node.motivation / members.length,
      validity: result.validity + node.validity / members.length
    }), { urgency: 0, motivation: 0, validity: 0 });
    const meanSimilarity = members.reduce(
      (total, node) => total + parameterSimilarity(node, mean),
      0
    ) / members.length;
    return {
      id: `entanglement-${String(index).padStart(3, "0")}`,
      key,
      memberIds: members.map(node => node.id),
      mean,
      coupling: clamp(0.38 + meanSimilarity * 0.56, 0.38, 0.94)
    };
  });
}

export function createEntanglementModel(nodes) {
  const frozenNodes = nodes.map(node => Object.freeze({
    ...node,
    candidateTopicIds: Object.freeze([...(node.candidateTopicIds || [])]),
    sourceIds: Object.freeze([...(node.sourceIds || [node.sourceId ?? node.id])]),
    sourceTopicIds: Object.freeze([...(node.sourceTopicIds || [node.topicId])])
  }));
  const nodeById = new Map(frozenNodes.map(node => [node.id, node]));
  const groups = buildEntanglementGroups(frozenNodes);
  return Object.freeze({ nodes: Object.freeze(frozenNodes), groups: Object.freeze(groups), nodeById });
}

export function sampleObservation(model, options = {}) {
  const basis = DEFAULT_BASIS_WEIGHTS[options.basis] ? options.basis : "overall";
  const weights = DEFAULT_BASIS_WEIGHTS[basis];
  const seed = String(options.seed ?? "yuki-entanglement-prototype");
  const epoch = Number.isInteger(options.epoch) ? options.epoch : 0;
  const outcomes = [];
  const groups = [];

  for (const group of model.groups) {
    const members = group.memberIds.map(id => model.nodeById.get(id));
    const groupScore = members.reduce(
      (total, node) => total + weightedScore(node, weights),
      0
    ) / Math.max(1, members.length);
    const nearProbability = clamp(0.12 + groupScore * 0.76, 0.08, 0.92);
    const groupRoll = random01(`${seed}|${epoch}|${basis}|${group.id}|group`);
    const groupBit = groupRoll < nearProbability ? 1 : 0;
    const groupPhase = random01(`${seed}|${epoch}|${basis}|${group.id}|phase`) * Math.PI * 2;
    groups.push({
      id: group.id,
      groupBit,
      groupPhase,
      nearProbability,
      groupScore
    });

    for (const node of members) {
      const nodeScore = weightedScore(node, weights);
      const similarity = parameterSimilarity(node, group.mean);
      const coupling = clamp(group.coupling * (0.55 + similarity * 0.45), 0, 1);
      const prefix = `${seed}|${epoch}|${basis}|${group.id}|${node.id}`;
      const ownBit = random01(`${prefix}|own`) < nodeScore ? 1 : 0;
      const correlated = random01(`${prefix}|coupled`) < coupling;
      const bit = correlated ? groupBit : ownBit;
      outcomes.push({
        nodeId: node.id,
        groupId: group.id,
        bit,
        groupBit,
        coupling,
        nodeScore,
        membershipRoll: random01(`${prefix}|membership`),
        distanceJitter: random01(`${prefix}|distance`) - 0.5,
        directionSeed: `${prefix}|direction`,
        phase: (groupPhase + random01(`${prefix}|phase`) * Math.PI * 2) % (Math.PI * 2)
      });
    }
  }
  return Object.freeze({ mode: "correlated", basis, seed, epoch, outcomes, groups });
}

export function sampleAmplitudeObservation(model, options = {}) {
  const basis = DEFAULT_BASIS_WEIGHTS[options.basis] ? options.basis : "overall";
  const weights = DEFAULT_BASIS_WEIGHTS[basis];
  const seed = String(options.seed ?? "yuki-entanglement-prototype");
  const epoch = Number.isInteger(options.epoch) ? options.epoch : 0;
  const outcomes = [];
  const groups = [];

  for (const group of model.groups) {
    const members = group.memberIds.map(id => model.nodeById.get(id));
    const rankedMembers = [...members].sort((left, right) => (
      random01(`${seed}|${group.id}|branch|${left.id}`)
      - random01(`${seed}|${group.id}|branch|${right.id}`)
      || left.id.localeCompare(right.id)
    ));
    const leftMembers = rankedMembers.filter((_, index) => index % 2 === 0);
    const rightMembers = rankedMembers.filter((_, index) => index % 2 === 1);
    if (rightMembers.length === 0) rightMembers.push(leftMembers[0]);
    const meanScore = branchMembers => branchMembers.reduce(
      (sum, node) => sum + weightedScore(node, weights),
      0
    ) / Math.max(1, branchMembers.length);
    const leftScore = meanScore(leftMembers);
    const rightScore = meanScore(rightMembers);
    const groupScore = (leftScore + rightScore) / 2;
    const schmidtAngle = Math.PI / 4 * group.coupling;
    const phase = random01(`${seed}|${epoch}|${basis}|${group.id}|quantum-phase`) * Math.PI * 2;
    const leftAngle = (leftScore - 0.5) * Math.PI;
    const rightAngle = (rightScore - 0.5) * Math.PI;
    const probabilities = calculateBellPairProbabilities({
      schmidtAngle,
      phase,
      leftAngle,
      rightAngle
    });
    const outcome = sampleJointOutcome(
      probabilities,
      random01(`${seed}|${epoch}|${basis}|${group.id}|born-measurement`)
    );
    const selectedProbability = probabilities[outcome];
    const amplitudeZeroProbability = Math.cos(schmidtAngle) ** 2;
    const concurrence = Math.sin(2 * schmidtAngle);
    const entanglementEntropy = binaryEntropy(amplitudeZeroProbability);
    const branchById = new Map([
      ...leftMembers.map(node => [node.id, 0]),
      ...rightMembers.map(node => [node.id, 1])
    ]);
    groups.push({
      id: group.id,
      groupBit: Number(outcome[0]),
      groupPhase: phase,
      nearProbability: (
        probabilities["10"] + probabilities["11"]
        + probabilities["01"] + probabilities["11"]
      ) / 2,
      groupScore,
      quantumState: Object.freeze({
        family: "bell-like-logical-pair",
        schmidtAngle,
        phase,
        leftAngle,
        rightAngle,
        concurrence,
        entanglementEntropy,
        probabilities,
        outcome,
        selectedProbability
      })
    });

    for (const node of members) {
      const branch = branchById.get(node.id) ?? 0;
      const bit = Number(outcome[branch]);
      const nodeScore = weightedScore(node, weights);
      const similarity = parameterSimilarity(node, group.mean);
      const coupling = clamp(group.coupling * (0.55 + similarity * 0.45), 0, 1);
      const prefix = `${seed}|${epoch}|${basis}|${group.id}|${node.id}|amplitude`;
      outcomes.push({
        nodeId: node.id,
        groupId: group.id,
        bit,
        groupBit: bit,
        coupling,
        nodeScore,
        membershipRoll: random01(`${prefix}|membership`),
        distanceJitter: selectedProbability - 0.25,
        directionSeed: `${prefix}|direction`,
        phase,
        branch,
        bornProbability: selectedProbability
      });
    }
  }
  return Object.freeze({ mode: "amplitude", basis, seed, epoch, outcomes, groups });
}

export function deriveObservedProjection(model, sample, options = {}) {
  const bounds = {
    min: Number.isFinite(options.minDistance) ? options.minDistance : DEFAULT_DISTANCE_BOUNDS.min,
    max: Number.isFinite(options.maxDistance) ? options.maxDistance : DEFAULT_DISTANCE_BOUNDS.max
  };
  const groupSampleById = new Map(sample.groups.map(group => [group.id, group]));
  const projectedNodes = sample.outcomes.map(outcome => {
    const source = model.nodeById.get(outcome.nodeId);
    const groupSample = groupSampleById.get(outcome.groupId);
    const observedTopicId = chooseObservedTopic(
      source,
      outcome.membershipRoll,
      outcome.bit,
      outcome.coupling
    );
    const branchDelta = outcome.bit ? 0.09 : -0.09;
    const observedWeight = clamp(
      outcome.nodeScore * 0.68
      + groupSample.groupScore * 0.22
      + branchDelta
      + outcome.distanceJitter * 0.08 * (1 - outcome.coupling)
    );
    const distance = bounds.min
      + Math.pow(1 - observedWeight, 1.28) * (bounds.max - bounds.min);
    const topicDirection = unitVector(`topic|${observedTopicId}`);
    const randomDirection = unitVector(outcome.directionSeed);
    const correlatedDirection = unitVector(`group|${outcome.groupId}|${outcome.groupBit}`);
    const direction = normalizeVector({
      x: topicDirection.x * 0.5 + randomDirection.x * 0.34 + correlatedDirection.x * 0.16,
      y: topicDirection.y * 0.5 + randomDirection.y * 0.34 + correlatedDirection.y * 0.16,
      z: topicDirection.z * 0.5 + randomDirection.z * 0.34 + correlatedDirection.z * 0.16
    });
    return {
      id: source.id,
      groupId: outcome.groupId,
      observedTopicId,
      observedWeight,
      distance,
      position: {
        x: direction.x * distance,
        y: direction.y * distance,
        z: direction.z * distance
      },
      phase: outcome.phase,
      bit: outcome.bit,
      coupling: outcome.coupling,
      branch: outcome.branch ?? null,
      bornProbability: outcome.bornProbability ?? null
    };
  });

  const projectionById = new Map(projectedNodes.map(node => [node.id, node]));
  const membersByGroup = new Map();
  for (const node of projectedNodes) {
    if (!membersByGroup.has(node.groupId)) membersByGroup.set(node.groupId, []);
    membersByGroup.get(node.groupId).push(node);
  }

  const relationKeys = new Set();
  const relations = [];
  function addRelation(left, right, kind) {
    if (!left || !right || left.id === right.id) return;
    const key = edgeKey(left.id, right.id);
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    const distanceDifference = Math.abs(left.distance - right.distance) / (bounds.max - bounds.min);
    relations.push({
      id: key,
      leftId: left.id,
      rightId: right.id,
      groupId: left.groupId,
      kind,
      strength: clamp((left.coupling + right.coupling) * 0.5 * (1 - distanceDifference * 0.4))
    });
  }

  for (const members of membersByGroup.values()) {
    const byTopic = new Map();
    for (const member of members) {
      if (!byTopic.has(member.observedTopicId)) byTopic.set(member.observedTopicId, []);
      byTopic.get(member.observedTopicId).push(member);
    }
    for (const topicMembers of byTopic.values()) {
      topicMembers.sort((left, right) => left.phase - right.phase || left.id.localeCompare(right.id));
      for (let index = 1; index < topicMembers.length; index += 1) {
        addRelation(topicMembers[index - 1], topicMembers[index], "observed-membership");
      }
    }
    const ordered = [...members].sort((left, right) => left.phase - right.phase || left.id.localeCompare(right.id));
    for (let index = 0; index + 1 < ordered.length; index += 2) {
      addRelation(ordered[index], ordered[index + 1], "entangled-pair");
    }
  }

  const observedGroups = model.groups.map(group => {
    const members = group.memberIds.map(id => projectionById.get(id)).filter(Boolean);
    const sourceMembers = group.memberIds.map(id => model.nodeById.get(id)).filter(Boolean);
    const groupSample = groupSampleById.get(group.id);
    const centroid = members.reduce((result, node) => ({
      x: result.x + node.position.x / members.length,
      y: result.y + node.position.y / members.length,
      z: result.z + node.position.z / members.length
    }), { x: 0, y: 0, z: 0 });
    const length = Math.hypot(centroid.x, centroid.y, centroid.z);
    const direction = length > 1.5 ? normalizeVector(centroid) : unitVector(`anchor|${group.id}|${sample.epoch}`);
    const meanDistance = members.reduce((total, node) => total + node.distance, 0) / Math.max(1, members.length);
    const anchorDistance = clamp(meanDistance * 0.84, bounds.min + 1, bounds.max - 2);
    return {
      id: group.id,
      key: group.key,
      memberIds: group.memberIds,
      groupBit: groupSample.groupBit,
      nearProbability: groupSample.nearProbability,
      quantumState: groupSample.quantumState ?? null,
      derivedContent: deriveEntangledContent(
        group,
        sourceMembers,
        projectionById,
        groupSample,
        sample
      ),
      position: {
        x: direction.x * anchorDistance,
        y: direction.y * anchorDistance,
        z: direction.z * anchorDistance
      }
    };
  });

  return Object.freeze({
    mode: sample.mode ?? "correlated",
    basis: sample.basis,
    seed: sample.seed,
    epoch: sample.epoch,
    bounds: Object.freeze(bounds),
    nodes: Object.freeze(projectedNodes),
    relations: Object.freeze(relations),
    groups: Object.freeze(observedGroups)
  });
}

export function observeEntanglement(model, options = {}) {
  const sample = sampleObservation(model, options);
  return deriveObservedProjection(model, sample, options);
}

export function observeAmplitudeEntanglement(model, options = {}) {
  const sample = sampleAmplitudeObservation(model, options);
  return deriveObservedProjection(model, sample, options);
}

export function distanceGradientValue(distance, bounds = DEFAULT_DISTANCE_BOUNDS) {
  return clamp(1 - (distance - bounds.min) / Math.max(1e-9, bounds.max - bounds.min));
}

export function generatePrototypeCandidates(topics, options = {}) {
  const uniqueCount = Math.max(1, Math.floor(options.uniqueCount ?? 5000));
  const duplicateCount = Math.max(0, Math.floor(options.duplicateCount ?? 400));
  const statements = [
    "負担を抑える制度が必要",
    "長期的な支援を優先してほしい",
    "地域差を小さくするべき",
    "情報公開を進めてほしい",
    "現場の意見を制度へ反映したい",
    "将来世代への影響を検証してほしい"
  ];
  const targets = ["生活者", "若年層", "高齢者", "地域事業者", "自治体", "現場職員", "将来世代"];
  const lenses = ["公平性", "持続性", "透明性", "実効性", "安全性", "選択可能性"];
  const capacity = topics.length * statements.length * targets.length * lenses.length;
  if (uniqueCount > capacity) throw new RangeError(`uniqueCount must be ${capacity} or less`);

  const topicByCategory = new Map();
  for (const topic of topics) {
    if (!topicByCategory.has(topic.categoryId)) topicByCategory.set(topic.categoryId, []);
    topicByCategory.get(topic.categoryId).push(topic);
  }

  const nodes = [];
  for (let index = 0; index < uniqueCount; index += 1) {
    let cursor = index;
    const topic = topics[cursor % topics.length];
    cursor = Math.floor(cursor / topics.length);
    const statementIndex = cursor % statements.length;
    cursor = Math.floor(cursor / statements.length);
    const lensIndex = cursor % lenses.length;
    cursor = Math.floor(cursor / lenses.length);
    const targetIndex = cursor % targets.length;
    const sameCategory = topicByCategory.get(topic.categoryId);
    const topicOffset = sameCategory.findIndex(candidate => candidate.id === topic.id);
    const secondary = sameCategory[(topicOffset + 1 + (lensIndex % Math.max(1, sameCategory.length - 1))) % sameCategory.length];
    const tertiary = topics[(topics.indexOf(topic) + 5 + targetIndex * 3) % topics.length];
    const id = `opinion-${String(index).padStart(5, "0")}`;
    nodes.push({
      id,
      sourceId: `source-${String(index).padStart(5, "0")}`,
      text: `${topic.label}について、${targets[targetIndex]}を対象に${lenses[lensIndex]}の観点から${statements[statementIndex]}。`,
      topicId: topic.id,
      categoryId: topic.categoryId,
      candidateTopicIds: [topic.id, secondary.id, tertiary.id],
      entanglementKey: `s${statementIndex}-l${lensIndex}-b${targetIndex % 2}`,
      statement: statements[statementIndex],
      target: targets[targetIndex],
      lens: lenses[lensIndex],
      urgency: 24 + Math.round(random01(`${id}|urgency`) * 76),
      motivation: 20 + Math.round(random01(`${id}|motivation`) * 80),
      validity: 32 + Math.round(random01(`${id}|validity`) * 68)
    });
  }

  for (let index = 0; index < duplicateCount; index += 1) {
    const original = nodes[(index * 37) % uniqueCount];
    nodes.push({
      ...original,
      id: `duplicate-${String(index).padStart(4, "0")}`,
      sourceId: `duplicate-source-${String(index).padStart(4, "0")}`,
      text: index % 2 === 0 ? `  ${original.text}  ` : `　${original.text}\n`
    });
  }
  return nodes;
}
