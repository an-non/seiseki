# SEISEKI ローカルモデル統合記録 2026-08-28

## 既存実装

- `sbintuitions/modernbert-ja-30m` を量子化・語彙剪定したブラウザ用エンコーダ
- KRRヘッド、Web Worker、IndexedDB/Cache Storage、SHA-256検証
- `SeisekiLocalBridge` と画面上の取得・削除・状態表示
- Cloudflare解析が利用できない場合の端末内解析と規則解析

これは新規にゼロから構築したモデルではなく、以前のユキ作業で組み込まれた既存実装を現行Phase 5へ適合させたもの。

## 今回の実装

- 提供された補正版 `head-krr-full-v2.bin` をSHA-256照合後に追加した。
- manifestのversionを変えず、headのURLとSHA-256だけを更新した。
- 利用者がモデルを明示取得した後に `navigator.storage.persist()` を非強制で要求する。
- 端末内モデルの結果を初回POSTへ同梱できるようにした。
- Workerは結果を再検証し、`analysis_runs.engine='seiseki-local-v1'` として記録する。
- 端末内結果は暫定値として保存するが、responseは `pending` のまま維持する。
- Workers AIのQueue処理は従来どおり実行し、完了時に暫定chunkと解析結果を置換する。

## 指示書から変更した理由

旧指示書のように端末内結果を `completed` にすると、現行のrevision/lease対応Queueは解析済みと判断し、Workers AIが実行されない。そこで、解析JSONとchunkを暫定保存しながら `analysis_status='pending'` を保つ実装に変更した。

クライアントが送った解析値は公開集計の確定値にしない。公開集計はcompletedのみを対象とするため、Workers AIまたは既存fallbackが完了するまで暫定結果は集計へ入らない。

## 残る制約

- 回答POSTそのものが圏外で失敗した場合の未送信response再送は未実装。
- `ideology.soc` はローカルモデルでは未推定。
- 教師データの出典表示とWRIMEの再配布条件は、公開前に別途確認が必要。
- production deployとremote D1 migrationは未実行。
