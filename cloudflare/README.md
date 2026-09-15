# 声析 Cloudflare API

Cloudflare Workers + D1を用いた本番候補。既存UIおよびSupabase案から独立しており、
認証前でもWranglerのローカルD1で投稿・参照・削除を検証できる。

## 現在の範囲

- `POST /api/responses`: 同意、属性、選択回答、自由記述を検証してD1へ保存する。
- `GET /api/responses/:id`: 撤回確認用の最小メタデータだけを返す。
- `DELETE /api/responses/:id`: 回答と従属データをカスケード削除する。
- `GET /api/stats`: 回答数、解析状態、選択回答分布を返す。
- `GET /api/health`: D1接続を確認する。

投稿時の解析状態は必ず`pending`。クライアントから渡された解析、ノード、関係線は
信用せず保存しない。意見量子化、全文評価、「つまり」は後続の独立処理として接続する。

## ローカル確認

```powershell
npm install
npm run db:migrate:local
npm run dev
```

`wrangler dev`の既定URLは`http://127.0.0.1:8787`。ローカル設定ではTurnstileを
必須にしていない。本番では`TURNSTILE_REQUIRED=true`とし、`TURNSTILE_SECRET`を
Worker Secretとして登録する。

Wranglerを導入できない環境でも、`node --test tests/*.test.mjs`はNode内蔵SQLiteへ
migrationを適用し、Worker API経由の投稿、集計、参照、削除、外部キーのカスケードを
検証する。これはD1互換SQLの検証であり、Cloudflare上のリモートD1接続を証明する
ものではない。

## 本番接続前に必要な作業

1. CloudflareでD1データベース`seiseki-db`を作成する。
2. `wrangler.jsonc`の`database_id`を実IDへ置換する。
3. PreviewとProductionそれぞれにD1 bindingを設定する。
4. Turnstileのsitekeyとsecretを作成し、secretをWorkerへ登録する。
5. リモートmigrationとdeployを明示承認後に実行する。

秘密情報は`wrangler.jsonc`へ書かない。`.dev.vars`や`.env`もコミット対象外。
