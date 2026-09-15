import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuantumNodeProfile,
  buildQuantumNodeProfiles,
  calculateMatchedBellDiagnostics,
  calculateQuantumNodeRelation,
  observeQuantumNodeNetwork,
  observeQuantumNodeRelation
} from "../local/quantum-node-relations-v2.mjs";
import {
  createEntanglementModel,
  deduplicateNodes,
  generatePrototypeCandidates,
  observeAmplitudeEntanglement
} from "../local/quantum-entanglement-engine.mjs";

const quarterTurn = Math.PI / 4;

test("位相干渉と独立化の差を同じ周辺確率で分離する", () => {
  const constructive = calculateMatchedBellDiagnostics({
    entanglement: 1,
    phase: 0,
    leftKetAngle: quarterTurn,
    rightKetAngle: quarterTurn
  });
  assert.ok(Math.abs(constructive.probabilities.pure - 0.5) < 1e-12);
  assert.ok(Math.abs(constructive.probabilities.dephased - 0.25) < 1e-12);
  assert.ok(Math.abs(constructive.probabilities.product - 0.25) < 1e-12);
  assert.ok(Math.abs(constructive.interferenceDelta - 0.25) < 1e-12);
  assert.ok(Math.abs(constructive.normalizedInterference - 1) < 1e-12);

  const destructive = calculateMatchedBellDiagnostics({
    entanglement: 1,
    phase: Math.PI,
    leftKetAngle: quarterTurn,
    rightKetAngle: quarterTurn
  });
  assert.ok(destructive.probabilities.pure < 1e-12);
  assert.ok(Math.abs(destructive.interferenceDelta + 0.25) < 1e-12);
  assert.ok(Math.abs(destructive.normalizedInterference + 1) < 1e-12);
});

test("干渉ゼロでも古典相関と独立状態との差を保持する", () => {
  const diagnostic = calculateMatchedBellDiagnostics({
    entanglement: 1,
    phase: 0,
    leftKetAngle: 0,
    rightKetAngle: 0
  });
  assert.ok(Math.abs(diagnostic.probabilities.pure - 0.5) < 1e-12);
  assert.ok(Math.abs(diagnostic.probabilities.dephased - 0.5) < 1e-12);
  assert.ok(Math.abs(diagnostic.probabilities.product - 0.25) < 1e-12);
  assert.ok(Math.abs(diagnostic.interferenceDelta) < 1e-12);
  assert.ok(Math.abs(diagnostic.independenceDelta - 0.25) < 1e-12);
});

test("観測位相を含む相対位相で干渉を計算する", () => {
  const phaseCancelled = calculateMatchedBellDiagnostics({
    entanglement: 1,
    phase: Math.PI / 2,
    leftKetAngle: quarterTurn,
    rightKetAngle: quarterTurn,
    leftMeasurementPhase: Math.PI / 4,
    rightMeasurementPhase: Math.PI / 4
  });
  assert.ok(Math.abs(phaseCancelled.interferenceDelta - 0.25) < 1e-12);

  const orthogonal = calculateMatchedBellDiagnostics({
    entanglement: 1,
    phase: Math.PI / 2,
    leftKetAngle: quarterTurn,
    rightKetAngle: quarterTurn
  });
  assert.ok(Math.abs(orthogonal.interferenceDelta) < 1e-12);
});

test("入力を有限値と0から1の結合度へ制限する", () => {
  assert.equal(calculateMatchedBellDiagnostics({ entanglement: 9 }).entanglement, 1);
  assert.equal(calculateMatchedBellDiagnostics({ entanglement: -2 }).entanglement, 0);
  assert.throws(
    () => calculateMatchedBellDiagnostics({ phase: Number.NaN }),
    /phase must be finite/u
  );
});

function profileFixture({ id, memberIds, text = id }, nodes) {
  return buildQuantumNodeProfile({
    id,
    key: `key-${id}`,
    memberIds,
    derivedContent: {
      text,
      sourceNodeIds: memberIds,
      observationKey: `seed:0:overall:${id}`
    }
  }, new Map(nodes.map(node => [node.id, node])));
}

test("量子ノードは文章を再解析せず意味署名・分布・出典を継承する", () => {
  const nodes = [
    {
      id: "a",
      sourceIds: ["source-a"],
      target: "夜間バス",
      action: "増便",
      condition: "夜勤後",
      topicId: "交通",
      lens: "移動可能性",
      stance: "request",
      statement: "帰宅手段を確保する",
      urgency: 80,
      motivation: 60,
      validity: 70
    },
    {
      id: "b",
      sourceIds: ["source-b"],
      target: "夜間バス",
      action: "増便",
      condition: "通院後",
      topicId: "医療",
      lens: "移動可能性",
      stance: "request",
      statement: "帰宅手段を確保する",
      urgency: 60,
      motivation: 80,
      validity: 70
    }
  ];
  const profile = profileFixture({ id: "q-a", memberIds: ["a", "b"] }, nodes);
  assert.deepEqual(profile.semanticSignature.targets, ["夜間バス"]);
  assert.deepEqual(profile.semanticSignature.conditions, ["夜勤後", "通院後"]);
  assert.deepEqual(profile.sourceIds, ["source-a", "source-b"]);
  assert.equal(profile.statusSummary.urgency.mean, 70);
  assert.equal(profile.statusSummary.urgency.variance, 100);
});

test("同じ対象への対立を強い関連のまま分類し、数値差は補正だけに使う", () => {
  const nodes = [
    {
      id: "a", sourceId: "source-a", target: "夜間バス", action: "増便",
      topicId: "交通", stance: "request", urgency: 80, motivation: 60, validity: 70
    },
    {
      id: "b", sourceId: "source-b", target: "夜間バス", action: "増便",
      topicId: "交通", stance: "oppose", urgency: 70, motivation: 80, validity: 70
    }
  ];
  const left = profileFixture({ id: "q-a", memberIds: ["a"] }, nodes);
  const right = profileFixture({ id: "q-b", memberIds: ["b"] }, nodes);
  const relation = calculateQuantumNodeRelation(left, right, { statusInfluence: 0.3 });
  assert.equal(relation.kind, "conflict");
  assert.ok(relation.semanticEvidence > 0.5);
  assert.ok(relation.baseStrength > 0.5);
  assert.equal(relation.sourceOverlap, 0);
  assert.equal(relation.independentStrength, relation.baseStrength);
});

test("同じ出典から生まれた関係は独立した発見として加点しない", () => {
  const nodes = [
    {
      id: "a", sourceId: "shared", target: "夜間交通", action: "改善",
      topicId: "交通", urgency: 80, motivation: 70, validity: 75
    },
    {
      id: "b", sourceId: "shared", target: "夜間交通", action: "改善",
      topicId: "労働", urgency: 80, motivation: 70, validity: 75
    }
  ];
  const left = profileFixture({ id: "q-a", memberIds: ["a"] }, nodes);
  const right = profileFixture({ id: "q-b", memberIds: ["b"] }, nodes);
  const relation = calculateQuantumNodeRelation(left, right);
  assert.ok(relation.baseStrength > 0);
  assert.equal(relation.sourceOverlap, 1);
  assert.equal(relation.independentStrength, 0);
});

test("量子ノード間の観測は意味種別を変えず干渉と独立差を別々に残す", () => {
  const nodes = [
    {
      id: "a", sourceId: "source-a", target: "夜間交通", action: "増便",
      topicId: "交通", stance: "request", urgency: 85, motivation: 80, validity: 90
    },
    {
      id: "b", sourceId: "source-b", target: "夜間交通", action: "増便",
      topicId: "労働", stance: "oppose", urgency: 75, motivation: 70, validity: 90
    }
  ];
  const left = profileFixture({ id: "q-a", memberIds: ["a"] }, nodes);
  const right = profileFixture({ id: "q-b", memberIds: ["b"] }, nodes);
  const relation = calculateQuantumNodeRelation(left, right);
  const observed = observeQuantumNodeRelation(relation, left, right, { basis: "urgency" });
  assert.equal(observed.kind, "conflict");
  assert.ok(observed.entanglement > 0);
  assert.ok(Number.isFinite(observed.diagnostics.interferenceDelta));
  assert.ok(Number.isFinite(observed.diagnostics.independenceDelta));
  assert.ok(observed.observedStrength >= 0 && observed.observedStrength <= 1);
});

test("独立した量子ノードの観測から出典付き二次問題ノードを一段だけ発生させる", () => {
  const nodes = [
    {
      id: "a", sourceId: "source-a", target: "夜間交通", action: "移動確保",
      condition: "夜勤後", topicId: "交通", lens: "生活基盤", stance: "request",
      urgency: 90, motivation: 85, validity: 95
    },
    {
      id: "b", sourceId: "source-b", target: "夜間交通", action: "移動確保",
      condition: "診療後", topicId: "医療", lens: "生活基盤", stance: "request",
      urgency: 85, motivation: 80, validity: 95
    }
  ];
  const profiles = [
    profileFixture({ id: "q-transport", memberIds: ["a"] }, nodes),
    profileFixture({ id: "q-medical", memberIds: ["b"] }, nodes)
  ];
  const first = observeQuantumNodeNetwork(profiles, {
    basis: "overall",
    seed: "derived-node",
    epoch: 2,
    minimumObservationDependence: 0,
    maximumDerivedNodes: 4
  });
  const repeated = observeQuantumNodeNetwork(profiles, {
    basis: "overall",
    seed: "derived-node",
    epoch: 2,
    minimumObservationDependence: 0,
    maximumDerivedNodes: 4
  });
  assert.deepEqual(first, repeated);
  assert.equal(first.relations.length, 1);
  assert.equal(first.derivedNodes.length, 1);
  const derived = first.derivedNodes[0];
  assert.equal(derived.depth, 1);
  assert.deepEqual(derived.sourceQuantumNodeIds, ["q-transport", "q-medical"]);
  assert.deepEqual(derived.sourceIds, ["source-a", "source-b"]);
  assert.match(derived.label, /接続問題/u);
  assert.ok(derived.coreAffinity > 0 && derived.coreAffinity <= 1);
  assert.equal(first.recursiveDepthLimit, 1);
});

test("出典が同一の量子ノードから二次問題ノードを作らない", () => {
  const nodes = [
    {
      id: "a", sourceId: "shared", target: "公共交通", action: "改善",
      topicId: "交通", urgency: 90, motivation: 80, validity: 90
    },
    {
      id: "b", sourceId: "shared", target: "公共交通", action: "改善",
      topicId: "医療", urgency: 90, motivation: 80, validity: 90
    }
  ];
  const result = observeQuantumNodeNetwork([
    profileFixture({ id: "q-a", memberIds: ["a"] }, nodes),
    profileFixture({ id: "q-b", memberIds: ["b"] }, nodes)
  ], {
    minimumObservationDependence: 0,
    minimumEvidence: 0,
    minimumNovelty: 0
  });
  assert.equal(result.derivedNodes.length, 0);
});

test("existing 5000-node prototype feeds the bounded v2 relation layer", () => {
  const topics = Array.from({ length: 24 }, (_, index) => ({
    id: `topic-${String(index).padStart(2, "0")}`,
    label: `Topic ${index + 1}`,
    categoryId: `category-${Math.floor(index / 4)}`
  }));
  const candidates = generatePrototypeCandidates(topics, {
    uniqueCount: 5000,
    duplicateCount: 400
  });
  const model = createEntanglementModel(deduplicateNodes(candidates));
  const projection = observeAmplitudeEntanglement(model, {
    basis: "overall",
    seed: "v2-compatibility",
    epoch: 3
  });
  const profiles = buildQuantumNodeProfiles(projection.groups, model.nodeById);
  const result = observeQuantumNodeNetwork(profiles, {
    basis: "overall",
    seed: "v2-compatibility",
    epoch: 3,
    maximumRelations: 256,
    maximumDerivedNodes: 24
  });

  assert.equal(candidates.length, 5400);
  assert.equal(model.nodes.length, 5000);
  assert.equal(profiles.length, 72);
  assert.ok(result.relations.length > 0 && result.relations.length <= 256);
  assert.ok(result.derivedNodes.length > 0 && result.derivedNodes.length <= 24);
  for (const relation of result.relations) {
    assert.ok(Number.isFinite(relation.observedStrength));
    assert.ok(Number.isFinite(relation.diagnostics.interferenceDelta));
    assert.ok(Number.isFinite(relation.diagnostics.independenceDelta));
  }
});

test("source identifiers retain their exact spelling", () => {
  const nodeById = new Map([
    ["a", {
      id: "a",
      sourceId: "Response-Aa-01",
      target: "transport",
      urgency: 50,
      motivation: 50,
      validity: 50
    }]
  ]);
  const profile = buildQuantumNodeProfile({
    id: "q-a",
    key: "a",
    memberIds: ["a"]
  }, nodeById);

  assert.deepEqual(profile.sourceIds, ["Response-Aa-01"]);
});
