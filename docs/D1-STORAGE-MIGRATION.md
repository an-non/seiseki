# window.storage から Cloudflare D1 への保存・解析継投

更新日: 2026-08-13

## 目的

旧版の `window.storage` が持っていた回答原本、回答時点の質問、解析結果、表示用集計の意味を保ちつつ、ブラウザからD1へ直接接続しない構成へ移す。

## 維持する要件

- 回答原文と解析結果を混同しない。
- 回答時点の質問文、選択肢、尺度両端の意味を保存する。
- 後日質問設定が変わっても、過去回答の解析文脈を変えない。
- 有効なAI解析結果をローカル規則で暗黙に置換しない。
- AI障害時だけ決定的なローカル解析へフォールバックする。
- 回答削除時は、回答、選択回答、質問スナップショット、解析履歴、意見チャンクを外部キーで連鎖削除する。
- 下書きと端末セッションは個人端末側に残し、共有回答原本はD1へ保存する。
- ブラウザへD1識別子やSQL実行機能を公開しない。

## 保存単位の対応

| 旧 `window.storage` | D1 / 現行処理 | 備考 |
| --- | --- | --- |
| `resp:<id>` の回答属性・原文 | `responses` | 原本。解析状態も保持する |
| `resp:<id>.answers` | `answers` | 一回答に複数行 |
| 回答時に参照した質問設定 | `response_questions` | 2026-08-13追加。回答時点の不変スナップショット |
| `resp:<id>.analysis` | `responses.analysis_json` | 互換表示用の解析全体 |
| `resp:<id>.analysis.chunks` | `opinion_chunks` | 検索・集計・可視化用に正規化 |
| 解析実行の状態 | `analysis_runs` | engine、model、prompt version、成否を記録 |
| `config:questions` | `app_config.questions` | `GET /api/config` 経由でUIへ配布 |
| `agg:summary` | D1から取得した回答・チャンクをUIで集計 | D1に重複キャッシュを作らない |
| `draft:current` | 端末側の個人ストレージ | サーバーへ送らない |
| `session:current` | 端末側 + Workerの認証セッション | 認証トークン自体は平文保存しない |

## 処理継投

```text
回答画面
  -> POST /api/responses
  -> Workerで同意・属性・選択肢を検証
  -> responses / answers / response_questions を同一batchで保存
  -> QueueへresponseIdだけを送信
  -> ConsumerがD1から回答原本と質問スナップショットを取得
  -> Workers AIへ一回の構造化解析を要求
  -> JSON Schemaと値域を検証
  -> responses.analysis_json / opinion_chunks / analysis_runs を同一batchで確定
  -> GET /api/responses/:id/analysis
  -> 概要・プロフィール・ビジュアル表示へ反映
```

## 互換性

- `0004_response_question_context.sql` は既存表を変更・削除せず、新しい表と初期質問設定だけを追加する。
- migration以前の回答には質問スナップショットを推測して補完しない。再解析時は保存済みの `qid -> value` を利用する。
- migration以後の回答は、その時点の質問定義を必ず保存する。
- `demo_batch` は既存デモ投入処理との互換目的に限り、`demoFlag=true` の場合だけ質問外メタデータとして許可する。

## 実装・検証状態

- ローカルD1 migration: 適用済み
- ステージングD1 migration `0004`: 適用済み
- ステージングWorker: デプロイ済み
- `/api/config`: D1由来の4問を返すことを確認済み
- 自由記述1件の保存、Queue解析、結果取得、削除: 確認済み
- 孤立した `response_questions`: 0件
- Cloudflareテスト: 26件成功
- アプリテスト: 54件成功
- 画面遷移・量子表示テスト: 18件成功

