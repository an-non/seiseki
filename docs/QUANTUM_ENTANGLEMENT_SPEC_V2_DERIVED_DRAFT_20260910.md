# 量子もつれ観測 v2 派生仕様案

- 作成日: 2026-09-10
- 状態: 設計案のみ。現行コード、UI、D1、AI解析経路は変更しない
- 位置づけ: 現行仕様を不変の基準として残したまま比較する派生モデル

## 1. 出典と非置換原則

この文書は次の2資料を突き合わせた派生案であり、どちらかを訂正または置換するものではない。

- 現行仕様: `QUANTUM_ENTANGLEMENT_SPEC_AND_YUKI_PROPOSAL_20260907.md`
  - SHA-256: `e267a392b61284166fed170305ef1b537373e677fa8eb446192e3c96a340398c`
- 外部レビュー: `量子もつれ観測 仕様レビュー（案のみ）.txt`
  - SHA-256: `353c5fa051d83ed24ec50b48cd4397dd094ebc4d5882ab910508183b4e3eec3d`

外部レビューは教師データでも承認済み要件でもない。現行仕様に意図的に残された揺らぎ、比喩、未決定事項、矛盾を自動的に解消しない。

## 2. 変えない核

1. 原ノード、AI解析値、出典本文、回答revisionは観測によって更新しない。
2. 観測結果は派生投影であり、原DBへ新しい民意や事実として自動登録しない。
3. 位置、所属、関係線、観測値はローカルの決定的計算で求める。
4. AIを使う場合も計算後の説明候補に限定し、観測結果を決定させない。
5. 「つまり」は自由記述全体と集計を扱う別機能として維持する。
6. 「量子もつれ」は物理的量子計算の実行や証明ではなく、相関を再観測する古典計算上のモデルである。
7. 現行の量子語彙と表現は直ちに撤去しない。誤認防止と追跡可能性を先に強化する。

## 3. v2観測プロファイル

散在する係数を、版付きの単一プロファイルへ集約する。

```text
observationProfile = {
  version: "quantum-observation-v2-draft-1",
  basisWeights,
  couplingBase,
  couplingRange,
  nodeCouplingWeights,
  observedWeightWeights,
  distanceExponent,
  directionWeights,
  fallbackGroupingPolicy
}

profileHash = SHA-256(canonicalJson(observationProfile))
```

観測キーは次の情報を含む。

```text
observationKey = join(
  engineVersion,
  profileHash,
  mode,
  basis,
  seed,
  epoch,
  sourceRevision,
  groupId
)
```

係数、モード、入力revisionのいずれかが変われば、同じ観測として扱わない。

## 4. 群の状態

群を一律の「もつれ群」とせず、根拠別に状態を分ける。

| 状態 | 条件 | 結合度 | 関係線 |
|---|---|---:|---|
| `entangled` | 明示的な `entanglementKey` を共有する2件以上 | 現行式 | 生成する |
| `singleton` | 明示keyはあるが構成員が1件 | 0 | 生成しない |
| `ungrouped` | 明示keyがない | 未定義 | 生成しない |
| `empty` | 有効な構成員がない | 未定義 | 生成しない |

現行の72群hash配置は削除せず、比較用の `legacy-fallback-72` プロファイルとしてのみ残す。v2既定値では利用しない。

未群率を次で表示する。

```text
ungroupedRate = ungroupedNodeCount / validNodeCount
```

これは解析品質の診断値であり、利用者の意見に対する評価値ではない。

## 5. 観測計算

既存の基底スコア、古典相関、複素振幅、距離計算は比較のため維持する。単独群と未群には群由来の項を加えない。

```text
observedWeight_i = clamp(
  nodeWeight * s_i
  + groupWeight * groupScore
  + branchDelta
  + jitterWeight * jitter_i * (1-coupling_i),
  0, 1
)
```

`singleton` と `ungrouped` では次を適用する。

```text
groupWeight = 0
branchDelta = 0
coupling_i = 0
```

残った重みは正規化せず、現行との比較で移動量を観測する。採用時にだけ再校正する。

## 6. 複素振幅モード

Born確率は観測分岐を表す内部値として維持する。一方、`concurrence` と `entropy` は同じ `group_coupling` の単調変換であり、独立した二つの根拠として表示しない。

```text
concurrence = sin(2 * theta)
entropy = H(cos(theta)^2)
theta = (pi/4) * group_coupling
```

UIでは「計算の内訳」にまとめる。現行モードとの比較で、順位、所属、距離、関係線に有意な差がなければ、複素振幅モードは診断用に留める。

## 7. epochと再観測

epochは削除しない。探索可能性を残しつつ、選択的な提示を防ぐため次を記録する。

- 表示中のepoch
- 比較対象となるepoch範囲
- seed、basis、mode、profileHash
- 各epochでの所属と距離

単一epochを「唯一の結果」としてエクスポートしない。共有・出力時は観測キーと「複数観測の一例」という表示を含める。

## 8. 感度分析

全基底と固定されたepoch集合を観測し、ノードごとの安定性を追加で求める。

```text
topicStability_i = 最頻所属の出現回数 / 全観測数
distanceVariance_i = variance(distance_i across observations)
movement_i = mean(distance(position_i, baselinePosition_i))
```

安定性は「合意」や「正しさ」を意味しない。観測条件を変えても配置が変わりにくいことだけを示す。

## 9. ヌル比較

同じseed、basis、epochで結合だけを0にした影の観測を行う。

```text
couplingContribution_i =
  distance(correlatedPosition_i, nullPosition_i)
  / max(epsilon, distance(correlatedPosition_i, baselinePosition_i))
```

値は0から1へclampして表示できるが、因果効果や統計的有意性とは呼ばない。「今回の移動のうち、群結合を除くと残らない割合」の診断値とする。

## 10. 再構成ノード

現行の文章再構成を削除せず、二つの表示方式を比較する。

1. `composed-preview`: 現行の決定的再構成文。試作表示に限定する。
2. `sourced-fragments`: 断片を連結文にせず、出典ID付きの要素として表示する。

どちらも次を保持する。

- `sourceNodeIds`
- `sourceRevision`
- `observationKey`
- `method`
- `classification = derived_projection`

コピーまたはエクスポート時にも、この識別情報を落とさない。正式意見、政策提言、集計対象へ自動昇格しない。

## 11. テキスト等価表現

3D表示と同じ観測結果を表形式で出力できるようにする。

| 項目 | 内容 |
|---|---|
| nodeId | 原ノードID |
| sourceTopic | 観測前所属 |
| observedTopic | 観測後所属 |
| distanceBefore / After | 距離差 |
| groupState | entangled / singleton / ungrouped |
| coupling | 結合度または未定義 |
| observationBit | 観測ビット |
| sourceIds | 出典ID |
| observationKey | 観測再現キー |

表は監査、アクセシビリティ、差分試験に使い、3D表現の代替正本にはしない。

## 12. 計算量の扱い

現行の関係線生成は、群内を整列して隣接要素を結ぶため、直ちに `O(n^2)` とは判定しない。v2では実測値を残す。

- ノード数: 5,000 / 10,000 / 20,000
- 最大群サイズ
- 関係線数
- モデル生成時間
- 観測時間
- 投影時間
- 描画開始までの時間

上限は測定後に決め、外部レビューの推測値だけで制限を追加しない。

## 13. A/B比較

現行版をA、派生版をBとして、同じ5,000ノード、seed、基底、epochで比較する。

1. 原ノードと出典の一致
2. 単独群数、未群率
3. 所属変更数
4. 平均距離差と順位相関
5. 関係線差分
6. 古典相関と複素振幅の実質差
7. 再構成ノードの出典追跡
8. 同一キーの再現性
9. profile変更時にキーが変わること
10. 既存量子UIが変更されていないこと

## 14. 実装境界

派生実装を始める場合も、次を守る。

- 現行 `local/quantum-entanglement-engine.mjs` を上書きしない。
- `quantum-entanglement-engine-v2.mjs` と独立した比較用previewを作る。
- 通常の `/app/quantum` は切り替えない。
- D1 migration、Workers AI、Queue、productionへ接続しない。
- 比較結果を確認してから、採用項目を一つずつ現行経路へ移す。

## 15. 未決定事項

- v2で「量子もつれ観測」という表示名を維持する範囲
- epochの固定集合と共有形式
- 安定性を色、透明度、リング、サイズのどれで表すか
- `sourced-fragments` と `composed-preview` の優先表示
- 追加基底として少数性、対立度、出現数、新しさを採用するか
- 「つまり」機能が安定性だけを参照可能にするか

これらは矛盾を消すために自動決定せず、実際のA/B表示を見て判断する。
