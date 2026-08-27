# SEISEKI Phase 5 実装経路・画面遷移・回答UX復旧 指示書

- 作成日: 2026-08-27
- 対象: `codex/phase4-integration-20260826` (`4ed302c`以降)
- 比較対象staging: `dfcc12d`で実環境E2E済みの成果物
- 優先度: 実装経路とUI復旧を最優先。AIモデル品質の変更は後回し

## 1. 目的

Phase 4で追加した回答更新、再解析、量子観測遷移を、既存SEISEKIの表示品質と操作感を壊さず利用可能にする。
修正を先行せず、ソース、生成物、配信物、route、認証gate、API/D1状態のどこで差異が生じたかを先に特定する。

## 2. 利用者確認による最優先の再現対象

以下は重要な実利用報告である。ただし、再現と証拠取得が完了するまでは原因を断定しない。

1. 自由記述を追記しても解析へ至らない、または解析状態を目視判断できない。
2. 「追記」「修正」「解析を再試行」が同一画面に並び、用途と結果の違いが分からない。
3. フォントが部分的に変化または消失し、従来より表示品質が低下した。
4. 通常の項目から量子観測へ到達できず、`/app/quantum`がログイン画面へ置換される。
5. 個別修正ではなく、生成・統合・配信経路全体に不整合がある可能性がある。

## 3. 作業原則

- `core/`を編集元、`app/seiseki.jsx`と`local/src/App.jsx`を生成物として扱う。
- `node scripts/build-app.mjs`後に生成物の差分が残らないことを必須とする。
- ローカル、staging、productionの挙動を混同しない。各確認結果にcommit SHAとURLを付ける。
- UI文言、配色、フォント、レイアウトを原因特定前に広範囲変更しない。
- AIモデル、prompt、解析スコア仕様はPhase 5前半では変更しない。
- production、remote D1、staging deploy、GitHub pushは個別承認まで実行しない。
- 自動コード生成・自動commit・自動push workflowを復活させない。

## 4. 新しい工程

### Phase 5.0 ソース・配信物の凍結と所在確定

1. ローカル統合HEAD、remote feature HEAD、staging deploy SHAを記録する。
2. `core/`、生成済み2ファイル、`local/dist`、Cloudflare Assetsのhashを比較する。
3. 現行stagingの主要画面をスクリーンショット保存する。
4. 調査完了まではstagingを再deployしない。

完了条件:

- 利用者が見た画面が、どのcommitとbuild成果物か説明できる。
- 編集元と生成物の食い違いが一覧化されている。

### Phase 5.1 ビルド・runtime実装経路の監査

次の経路を順番に追跡する。

```text
core/head.jsx + core/logic.js + core/* + core/ui.jsx
  -> scripts/build-app.mjs
  -> app/seiseki.jsx / local/src/App.jsx
  -> Vite build
  -> Cloudflare Static Assets
  -> browser route
```

確認事項:

- 古い適用scriptが新しい`core/ui.jsx`を上書きしていないか。
- build後に量子preview HTML/JSが`dist/quantum/`へ含まれるか。
- staging環境変数が想定APIを指すか。
- service worker、browser cache、Assetsの混在がないか。

完了条件:

- 同じcommitから同じ成果物を再生成できる。
- 手編集された生成物が存在しない。

### Phase 5.2 route・認証gate・量子観測の復旧

対象route:

- `/app`
- `/app/dashboard`
- `/app/tree`
- `/app/quantum`
- `/survey`
- `/account/response`

要件:

1. 公開閲覧画面は未ログインでも閲覧できる。
2. 認証必須なのは回答作成・本人回答編集・アカウント操作だけとする。
3. `/app/quantum`を直接開く、再読込する、他画面から遷移する、ブラウザバックする全経路で量子観測を維持する。
4. 認証照会失敗を「未ログイン」や「初回回答なし」へ勝手に変換しない。
5. 量子previewがHTTP 200で同一originから読み込まれることを確認する。

完了条件:

- 未ログイン・ログイン済みの両方でroute表の期待結果を満たす。
- `/app/quantum`がログイン画面へ置換されない。

### Phase 5.3 回答更新から解析完了までの状態監査

1件のresponseについて以下を記録する。

```text
画面操作
  -> PATCH /free-text または PATCH /answers
  -> response revision +1
  -> analysis_status=pending
  -> Queue送信
  -> running
  -> completed または failed
  -> current revisionのanalysis/chunksをUI表示
```

各段階で、browser network、APIレスポンス、D1の`responses`、`analysis_runs`、`opinion_chunks`を対応付ける。
追記・修正直後に古いrevisionの解析結果を表示してはならない。

完了条件:

- 追記と修正の各1回について、revisionと解析runを端から端まで追跡できる。
- 解析未実行、実行中、失敗、完了をUIで区別できる。

### Phase 5.4 追記・修正・再試行UIの再設計

機能を次の意味で分離する。

- 追記: 現在全文を残し、新しい段落を追加した後、統合全文を再解析する。
- 修正: 現在全文を置換し、置換後全文を再解析する。
- アンケート修正: 保存時点の設問スナップショットに対する選択回答だけを更新する。
- 解析再試行: 本文を変えず、現在revisionの失敗・停滞解析だけを再投入する。

表示要件:

1. 通常時に4操作を同列のボタン群として並べない。
2. 追記と修正は別の見出し、説明、入力状態を持つ。
3. 操作前に「本文がどう変わるか」「再解析されるか」を短く示す。
4. 解析状態にはrevision、状態、更新時刻、失敗時の再試行可否を表示する。
5. `pending/running`中は不要な再試行を促さない。一定時間停滞または`failed`時だけ再試行を出す。

完了条件:

- 初見利用者が追記と修正の差を説明なしで識別できる。
- 操作後に解析が始まったこと、完了したことを同一画面で確認できる。

### Phase 5.5 タイポグラフィ・外観の回帰監査

1. Phase 4以前の基準画面または承認済みスクリーンショットを比較基準にする。
2. `FONT_BODY`、`FONT_DISP`、`FONT_MONO`の役割と実際のcomputed styleを記録する。
3. `FONT_BODY`と`FONT_DISP`が意図せず同一定義になった経緯を確認する。
4. フォント読込失敗時のfallbackを確認する。
5. 色、余白、カード、ボタンを広く作り直さず、差分原因だけを戻す。

完了条件:

- 主要画面の見出し、本文、数値、操作部品のfontが一貫する。
- desktop/mobileの比較画像で明白な意図しない退行がない。

### Phase 5.6 Backend hardeningの統合確認

ローカルcommit `4ed302c`の次を維持する。

- stale更新敗者が`responses / answers / opinion_chunks / analysis_runs`を変更しない。
- requeueは同一response/revisionにつき15秒に1回まで。
- public POSTは`demoFlag=true`を自己指定できない。
- invalid Bearerを匿名権限へ降格しない。
- current revisionだけを公開集計へ含める。

完了条件:

- Cloudflare全テストがPASSする。
- 既存デモは信頼済みseed経路でのみ作成できる。

### Phase 5.7 自動試験と実ブラウザE2E

最低限のE2Eシナリオ:

1. 未ログインで概要、ツリー、量子観測を閲覧する。
2. 登録して初回回答を送信し、解析完了を確認する。
3. 自由記述を追記し、revision更新と再解析を確認する。
4. 自由記述を修正し、追記との差を確認する。
5. 保存時点のアンケート回答を修正する。
6. 解析失敗fixtureでのみ再試行を実行する。
7. 全画面で再読込・戻る・進むを確認する。
8. desktop/mobileでfontと主要UIを画像比較する。

完了条件:

- unit/contract/full regression/browser E2Eがすべてgreen。
- テストが文字列の存在だけでなく、実際の画面とAPI状態を検証する。

### Phase 5.8 staging再統合

順序を固定する。

```text
local integration review
  -> 明示承認
  -> feature branchへpush
  -> CI hard gate
  -> staging migration確認
  -> staging deploy
  -> live E2E
  -> 利用者目視確認
```

既存stagingデータはデモとして扱えるが、E2Eが作成したデータは必ずcleanupする。
productionは対象外とする。

## 5. 作業分担

### ユキだけで実行可能

- Phase 5.0から5.7のローカル調査、実装、テスト
- build成果物とhashの比較
- route/auth state machineの作図
- browser自動試験の作成
- タイポグラフィ差分の特定
- handoffと監査レポートの作成

### 利用者の承認が必要

- feature branchへのpush
- GitHub Actionsの手動workflow実行
- remote staging D1 migration
- Queue/DLQの外部変更
- staging deployとlive E2E
- productionに関する全操作

## 6. 今回扱わない項目

- AIモデル比較、prompt調整、スコア精度改善
- 量子計算ロジックの追加
- 大規模DB再設計
- production deploy
- 外観の全面リデザイン

## 7. Phase 5完了判定

次の全条件を満たした時だけPhase 5完了とする。

1. 表示中の成果物をcommit SHAまで追跡できる。
2. `/app/quantum`が認証状態にかかわらず正しく表示される。
3. 追記・修正・アンケート修正・再試行の違いが画面上で明確である。
4. 更新後の解析状態をcurrent revision単位で目視確認できる。
5. 承認済みタイポグラフィと画面品質が復元される。
6. 全回帰試験と実ブラウザE2EがPASSする。
7. staging目視確認が完了する。

