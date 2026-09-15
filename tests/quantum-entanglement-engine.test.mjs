import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildEntanglementGroups,
  calculateBellPairProbabilities,
  createEntanglementModel,
  deduplicateNodes,
  deriveObservedProjection,
  distanceGradientValue,
  generatePrototypeCandidates,
  normalizeContent,
  observeAmplitudeEntanglement,
  observeEntanglement,
  sampleAmplitudeObservation,
  sampleObservation
} from "../local/quantum-entanglement-engine.mjs";

const topics = Array.from({ length: 24 }, (_, index) => ({
  id: `topic-${index}`,
  label: `トピック${index}`,
  categoryId: `category-${Math.floor(index / 4)}`
}));

test("NFKCと空白差だけの同一本文を一件へまとめる", () => {
  const source = [
    { id: "a", sourceId: "source-a", text: "ＡＩ  の活用", topicId: "topic-0" },
    { id: "b", sourceId: "source-b", text: "  AI\nの活用  ", topicId: "topic-1" },
    { id: "c", sourceId: "source-c", text: "AIの慎重な活用", topicId: "topic-0" }
  ];
  const result = deduplicateNodes(source);
  assert.equal(normalizeContent(source[0].text), normalizeContent(source[1].text));
  assert.equal(result.length, 2);
  assert.equal(result[0].occurrenceCount, 2);
  assert.deepEqual(result[0].sourceIds, ["source-a", "source-b"]);
  assert.deepEqual(result[0].sourceTopicIds, ["topic-0", "topic-1"]);
});

test("5,400入力を重複排除すると固有ノードが5,000件になる", () => {
  const raw = generatePrototypeCandidates(topics, { uniqueCount: 5000, duplicateCount: 400 });
  const before = JSON.stringify(raw);
  const unique = deduplicateNodes(raw);
  assert.equal(raw.length, 5400);
  assert.equal(unique.length, 5000);
  assert.equal(new Set(unique.map(node => node.normalizedContent)).size, 5000);
  assert.equal(unique.reduce((sum, node) => sum + node.occurrenceCount, 0), 5400);
  assert.equal(JSON.stringify(raw), before, "入力配列を変更しない");
  assert.equal(buildEntanglementGroups(unique).length, 72);
});

test("同じseed・観測番号・軸なら観測結果を完全再現できる", () => {
  const unique = deduplicateNodes(generatePrototypeCandidates(topics, {
    uniqueCount: 240,
    duplicateCount: 20
  }));
  const model = createEntanglementModel(unique);
  const options = { basis: "overall", seed: "repeatable", epoch: 3 };
  assert.deepEqual(sampleObservation(model, options), sampleObservation(model, options));
  assert.deepEqual(observeEntanglement(model, options), observeEntanglement(model, options));
  assert.notDeepEqual(
    sampleObservation(model, options).outcomes,
    sampleObservation(model, { ...options, epoch: 4 }).outcomes
  );
});

test("量子もつれノードは複数の元文章から再現可能な観測生成文を作る", () => {
  const unique = deduplicateNodes(generatePrototypeCandidates(topics, {
    uniqueCount: 360,
    duplicateCount: 30
  }));
  const model = createEntanglementModel(unique);
  const options = { basis: "overall", seed: "content-observation", epoch: 2 };
  const first = observeEntanglement(model, options);
  const repeated = observeEntanglement(model, options);
  assert.deepEqual(first.groups, repeated.groups);

  for (const group of first.groups) {
    const content = group.derivedContent;
    assert.ok(content.text.length > 0);
    assert.ok(content.sourceNodeIds.length > 0);
    assert.ok(content.sourceNodeIds.length <= 3);
    assert.match(content.method, /^deterministic-/u);
    assert.equal(content.observationKey, `${options.seed}:${options.epoch}:${options.basis}:${group.id}`);
    for (const sourceNodeId of content.sourceNodeIds) {
      assert.ok(group.memberIds.includes(sourceNodeId));
      assert.ok(model.nodeById.has(sourceNodeId));
    }
    assert.equal(
      content.sourceNodeIds.some(sourceNodeId => model.nodeById.get(sourceNodeId).text === content.text),
      false,
      "生成文は元文章そのものの複製にしない"
    );
  }

  const changed = observeEntanglement(model, { ...options, epoch: 3 });
  assert.ok(first.groups.some((group, index) => (
    group.derivedContent.text !== changed.groups[index].derivedContent.text
    || group.derivedContent.sourceNodeIds.join("|") !== changed.groups[index].derivedContent.sourceNodeIds.join("|")
  )));
});

test("Bell型の複素振幅はBorn則に従う正規化確率を返す", () => {
  const probabilities = calculateBellPairProbabilities({
    schmidtAngle: Math.PI / 4,
    phase: 0,
    leftAngle: 0,
    rightAngle: 0
  });
  assert.ok(Math.abs(probabilities["00"] - 0.5) < 1e-12);
  assert.ok(Math.abs(probabilities["11"] - 0.5) < 1e-12);
  assert.ok(probabilities["01"] < 1e-12);
  assert.ok(probabilities["10"] < 1e-12);
  assert.ok(Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test("振幅観測は論理光子対の状態・Born確率・測定結果を再現できる", () => {
  const unique = deduplicateNodes(generatePrototypeCandidates(topics, {
    uniqueCount: 360,
    duplicateCount: 30
  }));
  const model = createEntanglementModel(unique);
  const options = { basis: "validity", seed: "amplitude-observation", epoch: 4 };
  const sample = sampleAmplitudeObservation(model, options);
  const projection = observeAmplitudeEntanglement(model, options);
  assert.deepEqual(sample, sampleAmplitudeObservation(model, options));
  assert.deepEqual(projection, observeAmplitudeEntanglement(model, options));
  assert.equal(sample.mode, "amplitude");
  assert.equal(projection.mode, "amplitude");
  assert.equal(projection.nodes.length, model.nodes.length);

  for (const group of projection.groups) {
    const quantum = group.quantumState;
    assert.equal(quantum.family, "bell-like-logical-pair");
    assert.ok(quantum.selectedProbability >= 0 && quantum.selectedProbability <= 1);
    assert.ok(quantum.concurrence >= 0 && quantum.concurrence <= 1);
    assert.ok(quantum.entanglementEntropy >= 0 && quantum.entanglementEntropy <= 1);
    assert.ok(Math.abs(
      Object.values(quantum.probabilities).reduce((sum, value) => sum + value, 0) - 1
    ) < 1e-12);
    assert.match(quantum.outcome, /^(?:00|01|10|11)$/u);
  }
  for (const node of projection.nodes) {
    assert.ok(node.branch === 0 || node.branch === 1);
    assert.ok(node.bornProbability >= 0 && node.bornProbability <= 1);
  }
});

test("観測結果から距離・位置・所属・関係線を派生し、原ノードを変えない", () => {
  const unique = deduplicateNodes(generatePrototypeCandidates(topics, {
    uniqueCount: 360,
    duplicateCount: 30
  }));
  const model = createEntanglementModel(unique);
  const sample = sampleObservation(model, { basis: "overall", seed: "projection", epoch: 0 });
  const first = sample.outcomes[0];
  const forcedSample = {
    ...sample,
    outcomes: sample.outcomes.map(outcome => outcome.nodeId === first.nodeId ? {
      ...outcome,
      bit: first.bit ? 0 : 1,
      membershipRoll: 0.999999,
      distanceJitter: first.distanceJitter === 0.5 ? -0.5 : 0.5
    } : outcome)
  };
  const initial = deriveObservedProjection(model, sample);
  const changed = deriveObservedProjection(model, forcedSample);
  const initialNode = initial.nodes.find(node => node.id === first.nodeId);
  const changedNode = changed.nodes.find(node => node.id === first.nodeId);
  assert.notEqual(initialNode.distance, changedNode.distance);
  assert.notDeepEqual(initialNode.position, changedNode.position);
  assert.notEqual(model.nodeById.get(first.nodeId).observedTopicId, changedNode.observedTopicId);
  assert.equal("observedTopicId" in model.nodeById.get(first.nodeId), false);

  const nodeIds = new Set(changed.nodes.map(node => node.id));
  const relationIds = new Set();
  for (const relation of changed.relations) {
    assert.ok(nodeIds.has(relation.leftId));
    assert.ok(nodeIds.has(relation.rightId));
    assert.notEqual(relation.leftId, relation.rightId);
    assert.equal(relationIds.has(relation.id), false);
    relationIds.add(relation.id);
  }
});

test("色入力は距離だけで決まり、中心へ近いほど値が高い", () => {
  const bounds = { min: 5.5, max: 30 };
  assert.equal(distanceGradientValue(12, bounds), distanceGradientValue(12, bounds));
  assert.ok(distanceGradientValue(6, bounds) > distanceGradientValue(18, bounds));
  assert.ok(distanceGradientValue(18, bounds) > distanceGradientValue(29, bounds));
});

test("5,000件の投影は有限座標と有効な観測関係を返す", () => {
  const raw = generatePrototypeCandidates(topics, { uniqueCount: 5000, duplicateCount: 400 });
  const model = createEntanglementModel(deduplicateNodes(raw));
  const projection = observeEntanglement(model, {
    basis: "overall",
    seed: "prototype-5000",
    epoch: 0
  });
  assert.equal(projection.nodes.length, 5000);
  assert.equal(projection.groups.length, 72);
  assert.ok(projection.relations.length > 0);
  for (const node of projection.nodes) {
    assert.ok(Number.isFinite(node.distance));
    assert.ok(Number.isFinite(node.position.x));
    assert.ok(Number.isFinite(node.position.y));
    assert.ok(Number.isFinite(node.position.z));
  }
});

test("独立プレビューのmodule scriptを構文解析できる", () => {
  const previewPath = fileURLToPath(new URL(
    "../local/chunk-network-entanglement-preview.html",
    import.meta.url
  ));
  const html = readFileSync(previewPath, "utf8");
  const modules = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/gu)];
  assert.equal(modules.length, 1);
  const withoutImports = modules[0][1].replace(/^\s*import[\s\S]*?;\s*$/gmu, "");
  assert.doesNotThrow(() => new Function(withoutImports));
  assert.match(html, /updateOpinionColors/);
  assert.doesNotMatch(html, /entanglementInstances\.rotation\.y/);
});
