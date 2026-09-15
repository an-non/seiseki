# 本番構成 設計書(PRODUCTION-DESIGN)

対象アプリ: 声析(SEISEKI)v0.10.0 / 作成日: 2026-07-12

本書は、プロトタイプ(クライアント + 共有ストレージで完結)を一般公開に耐える本番構成へ移行するための設計です。要件は「HTTPS/TLS」「SQLインジェクション・プロンプトインジェクションを防ぐセキュアな設計」「コストの掛からないドメイン」「一般公開」。設計方針は次の3点に集約されます。

1. **書き込みとAI呼び出しはすべてサーバー経由**にし、クライアントを信頼しない。検証(サニタイズ)はサーバーで必ず再実行する。
2. **永続化はSupabase(PostgreSQL)の専用スキーマ**に置き、RLSを既定拒否にして、サーバー以外からは読めも書けもしない状態にする。
3. **集計は「読み時にSQLで計算」**へ切り替える。プロトタイプの走行集計(`agg:summary`)と再構築処理は不要になり、撤回・削除後も統計が常にデータと整合する。

## 1. 全体アーキテクチャ

```
[利用者ブラウザ]
   │ HTTPS(TLS自動 / *.vercel.app)
   ▼
[Vercel]
   ├─ 静的配信: React SPA(現行UIを流用)
   └─ /api/* : Serverless Functions(Node)
        │  入力検証(core/logic.js のサニタイズを再利用)
        │  レート制限・Turnstile検証・管理認可
        ├─ HTTPS ─▶ [Anthropic API]    … ANTHROPIC_API_KEY はサーバー環境変数のみ
        └─ HTTPS ─▶ [Supabase Postgres] … service_role キーはサーバー環境変数のみ
                       schema "seiseki"(RLS: 既定拒否 / 詳細は production/schema.sql)
```

信頼境界はサーバー(/api/*)に置きます。ブラウザは Supabase にも Anthropic にも直接アクセスしません。したがって、APIキーの露出・集計の直接改ざん・ストレージキーの汚染という、プロトタイプで許容していたリスクが構造的に消えます。

主要フローは4つです。**回答送信**はブラウザ→`POST /api/responses` の1リクエストで、サーバーが検証→AI解析→DB格納までを行います。**統計閲覧**は `GET /api/stats` が集計ビューを読んでダッシュボード用JSONを返します(エッジキャッシュ60秒)。**撤回**は回答IDを鍵として照会(`GET /api/responses/:id`)と削除(`DELETE`)を行い、外部キーのカスケードで意見チャンク等も同時に消えます。**管理**(設問・同意文の変更、エクスポート、全削除)は認証必須の `/api/admin/*` に隔離します。

## 2. 技術選定と費用

| 構成要素 | 採用 | 費用 | 備考 |
|---|---|---|---|
| ホスティング + API | Vercel(Hobby) | 無料 | 自動TLS(Let's Encrypt)、`<名前>.vercel.app` を無料付与。**Hobbyプランは非商用利用に限定**。商用の可能性があるなら Cloudflare Pages + Workers(無料枠が商用可)を代替に。 |
| データベース | Supabase(Free) | 無料 | PostgreSQL 500MB・RLS・自動バックアップ(日次)。**無料プロジェクトは一定期間(目安1週間)アクセスがないと一時停止**され手動再開が必要。定期アクセス(cronでの死活監視)で回避可能。 |
| ドメイン | `*.vercel.app` | 無料 | 独自ドメインは有料のため、無料要件下では標準サブドメインを採用。後から独自ドメイン接続も可(証明書は自動発行)。 |
| bot対策 | Cloudflare Turnstile | 無料 | CAPTCHA代替。回答送信時のみ検証。 |
| AI解析 | Anthropic API | 従量 | 唯一の変動費。下記試算参照。 |

**AI費用の試算**(2026年7月時点の公式料金。変動するため https://claude.com/pricing で要確認)。1回答あたりの入力はプロンプト固定部 + 属性・選択回答 + 自由記述(最大1500字)で概ね1,500〜2,500トークン、出力はJSONで500〜800トークン程度です。

- `claude-sonnet-4-6`($3/$15 per 100万トークン): **1回答あたり約$0.015〜0.02(2〜3円程度)**。1,000回答で$15〜20。
- `claude-haiku-4-5`($1/$5 per 100万トークン): **1回答あたり約$0.005〜0.007(1円弱)**。1,000回答で$5〜7。

品質重視なら現行どおり Sonnet、コスト最優先なら Haiku を採用します(この用途は構造化抽出が中心のため、Haiku でも実用になる可能性が高い。移行時にA/B比較を推奨)。プロンプト固定部が大きくなった場合はプロンプトキャッシュ(キャッシュ済み入力が90%引き)の適用を検討します。回答はリアルタイム応答が必要なため、Batch API(50%引き・非同期)は対象外です。

## 3. データベース設計

DDLの完全版は `production/schema.sql` にあります(Supabase の SQL Editor に貼り付けて実行可能)。要点は次のとおりです。

**専用スキーマ `seiseki` に隔離**します。プロトタイプのキー接頭辞 `pqx1:` に相当する競合回避策で、Supabase の Data API(PostgREST)は既定でカスタムスキーマを公開しないため、露出面も減ります。

**正規化**: プロトタイプの回答レコードを3テーブルに分解します。

- `responses` — 回答本体。`id`(回答ID。`^[A-Za-z0-9_-]{4,64}$` のCHECK制約 = `sanitizeId` と同一)、`ts`、同意の版と日時、属性5列(age/gender/region/occupation/party)、`free`(自由記述・1500字CHECK)、`analysis`(AI解析結果のJSONB)、`demo_flag`。
- `answers` — 選択式・5段階の回答を `(response_id, qid, value)` の縦持ちに。分布・クロス集計・時系列がすべて素直な `GROUP BY` になります。
- `opinion_chunks` — 意見チャンク。カテゴリ・対象種別・factはCHECK制約で列挙を強制(`sanitizeAnalysis` の列挙検証をDB層でも二重化)。

いずれも `on delete cascade` で `responses` に従属させます。**撤回=`responses` の1行DELETE** で完結し、プロトタイプで必要だった「削除後の集計再構築」は不要になります。

**集計は読み時にビューで計算**します。`v_distribution`(設問別分布)、`v_cross`(属性×回答の長形式)、`v_group_params`(選択肢グループ別の平均パラメータ)、`v_series` / `v_series_answers`(JST日別の推移)、`v_topics` / `v_topic_cats`(トピック統計)、`v_targets` / `v_target_cats`(対象別統計)、`v_demo`(属性内訳)を用意し、APIはこれらを `SELECT` して現行の集計JSONへ組み立てます。JST日付はタイムゾーン変換を `jst_day()` 関数(Asia/Tokyoは夏時間がなくUTC+9固定のためIMMUTABLE宣言可)に集約し、式インデックスを張ります。

**容量の目安**: 1回答あたり本体+チャンクで概ね2〜4KB。無料枠500MBで10万件超を収容でき、プロトタイプ由来の上限(イデオロギー点400・意見一覧120)は保存側の剪定ではなくクエリ時の `ORDER BY ts DESC LIMIT` に置き換えます(データは失われません)。

## 4. アクセス制御(RLS)と鍵の管理

全テーブルで RLS を有効化し、**ポリシーを一切作らない=既定拒否**とします。さらに `anon` / `authenticated` ロールからスキーマ・テーブル・ビュー・関数の権限を明示的に REVOKE します。サーバーの API だけが `service_role` キー(RLSをバイパス)で操作します。SQLインジェクションについては、サーバー実装で**パラメータ化クエリ(supabase-js のクエリビルダまたはプレースホルダ付きSQL)以外を禁止**し、文字列連結によるクエリ組み立てをコードレビュー基準で排除します。DB側でもCHECK制約が第二の防衛線になります。

環境変数(Vercelのプロジェクト設定に登録。リポジトリには置かない):

```
ANTHROPIC_API_KEY          … AI解析用(サーバーのみ)
SUPABASE_URL               … プロジェクトURL
SUPABASE_SERVICE_ROLE_KEY  … サーバー専用。クライアントに出したら即ローテーション
ADMIN_TOKEN                … 管理APIのBearerトークン(32文字以上のランダム値)
IP_HASH_SALT               … レート制限用IPハッシュのソルト
TURNSTILE_SECRET_KEY       … bot対策(任意)
```

## 5. API設計

| メソッド / パス | 認証 | 役割 |
|---|---|---|
| GET `/api/config` | 公開 | 設問と同意文(サーバーが `sanitizeQuestions` / `sanitizePolicy` を通して返す) |
| GET `/api/stats` | 公開 | ダッシュボード用集計JSON一式(ビューから合成、`Cache-Control: s-maxage=60`) |
| POST `/api/responses` | 公開(レート制限 + Turnstile) | 回答送信。検証→AI解析→トランザクション格納→ `{id, analysis}` を返す |
| GET `/api/responses/:id` | 回答ID自体が鍵 | 撤回前の照会。**最小メタデータのみ返す**(ts・属性・demo_flag。自由記述や解析詳細は返さない) |
| DELETE `/api/responses/:id` | 回答ID自体が鍵 | 撤回実行。カスケード削除、204を返す |
| PUT `/api/admin/config` | Bearer(ADMIN_TOKEN) | 設問・同意文の更新(サーバーで再サニタイズ) |
| GET `/api/admin/export` | Bearer | 全データのJSONエクスポート |
| DELETE `/api/admin/responses/:id` | Bearer | モデレーション削除(撤回依頼対応など) |
| DELETE `/api/admin/responses` | Bearer + 確認パラメータ | 全回答削除 |

`POST /api/responses` の処理系列(サーバー側):

1. Turnstileトークンを検証(有効化している場合)。
2. レート制限: `hit_rate_limit('submit:' + sha256(IP + salt), 5, 60)` と日次バケット(例: 30件/日)。**生のIPは保存せずハッシュのみ**。超過は 429。
3. スキーマ検証: `demo` は `DEMO_OPTS` の列挙内か、`answers` は現行設問のqid・選択肢に一致するか、`free` は `sanitizeFreeText`(1500字)を通す。違反は 400。
4. 同意検証: リクエストの `consent.version` が現行 `policy.version` と一致しなければ 409(クライアントは同意文を再表示)。
5. AI解析: `buildPrompt` → Anthropic(タイムアウト30秒・1回リトライ)→ `sanitizeAnalysis`。失敗時は 502 を返し、クライアントは現行UIどおり「再試行 / 簡易推定で保存」を提示(簡易推定は `mode:"heuristic"` を付けて再POST)。
6. 格納: `responses` + `answers[]` + `opinion_chunks[]` を単一トランザクションでINSERT。
7. `{ id, analysis }` を返す(idはサーバーで `uid()` 生成)。

プロンプトインジェクション対策(データ区画宣言・区切りトークン無害化・出力スキーマ強制)は `docs/SECURITY.md` の設計をそのままサーバーへ移設します。`core/logic.js` はUI非依存の純粋JSなので、末尾に `export` を付けたサーバー用モジュール(例: `server/logic.mjs`)として再利用し、クライアントとサーバーで検証ロジックを一本化します。

## 6. プロトタイプからの対応(差し替え表)

| プロトタイプ(v0.10.0) | 本番 |
|---|---|
| `sGet("agg:summary")` + 画面内の集計計算 | `GET /api/stats` の集計JSONをそのまま描画 |
| Survey送信(`callAI` → `sSet resp` → merge → `sSet agg`) | `POST /api/responses` 1本(AI・保存はサーバー) |
| 撤回の照会 `sGet("resp:"+id)` | `GET /api/responses/:id`(最小メタのみ) |
| 撤回の削除 + `rebuildAgg` | `DELETE /api/responses/:id`(再構築不要) |
| 管理の保存 `sSet("config:*")` | `PUT /api/admin/config`(Bearer) |
| 管理の合言葉(`config:admin`) | 廃止。`ADMIN_TOKEN`(将来は Supabase Auth + admins テーブル) |
| 「集計を再構築」 | 廃止(読み時集計のため常に整合) |
| デモデータ投入/削除 | 管理APIの `demo_flag` 付き投入・一括削除として温存(任意) |

UI(React)はほぼそのまま使えます。差し替え対象はストレージアダプタ4関数と `callAI`、および Survey の submit・Withdraw・Admin の保存系だけで、画面・グラフ・文言は流用します。

## 7. 管理者認証

MVPは **`ADMIN_TOKEN` による Bearer 認証**(管理画面でトークンを入力し、以後のリクエストの `Authorization` ヘッダに付与)。共有ストレージ上の合言葉と違い、トークンはサーバー環境変数にのみ存在し、検証もサーバーで行われます。運用が本格化したら **Supabase Auth(メールのマジックリンク)+ `admins` テーブル**へ移行し、監査ログ(誰がいつ設定を変えたか)を `config.updated_at` と併せて残します。

## 8. プライバシーとデータ保持

自由記述の原文(`free`)は再解析・監査のためDBには保持しますが、**公開APIには一切載せません**(公開されるのは48字以内の意見チャンク要約と統計のみ)。撤回は物理削除(カスケード)で、集計は次回読み込みから自動的に反映されます。レート制限のためのIPは前述のとおりソルト付きハッシュのみを短期保存し、2日で削除します。同意文の改定時は `policy.version` を上げ、旧版で同意した回答にも同意時の版が記録され続けます。

## 9. 運用

Supabase Free の日次バックアップに加え、`GET /api/admin/export` の定期取得(手動または cron)で論理バックアップを二重化します。無料プロジェクトの一時停止対策として、外形監視(無料の死活監視サービスで `GET /api/stats` を定期取得)を設定します。ログには自由記述・回答ID・生IPを出力しない方針とし、エラー監視は Vercel のログと Supabase のログで賄います。

## 10. 移行手順

**Phase 1(基盤)**: Supabaseプロジェクト作成 → `production/schema.sql` 適用 → Vercelに空のAPI(`/api/config`, `/api/stats`)をデプロイ → 環境変数登録。
**Phase 2(書き込み)**: `POST /api/responses` と撤回API・レート制限・Turnstileを実装 → クライアントのアダプタ差し替え版(v0.11系)を用意 → ステージングで動作検証。
**Phase 3(移行・公開)**: プロトタイプの管理画面「JSONエクスポート」でデータを取得し、インポートスクリプト(`responses`/`answers`/`opinion_chunks` へ分解INSERT。検証に `server/logic.mjs` を再利用)で投入 → 管理トークン設定 → 公開。プロトタイプ側は読み取り専用の告知を出して閉鎖。

ロールバックは「クライアントをプロトタイプ版に戻す」だけで成立します(プロトタイプのデータは共有ストレージに残っているため)。

## 11. 将来拡張

読み取り負荷が増えた場合は、`v_*` ビューのマテリアライズドビュー化(pg_cron で定期REFRESH)や、安全な集計ビューのみを `anon` に開放してクライアント直読みにする段階的緩和が可能です。機能面では、C案(トピックの表記ゆれ統合)をサーバー側のバッチ(Batch API 50%引きが有効)として実装する、意見チャンクの全文検索(PostgreSQLの `pg_trgm`)を足す、などが本設計の延長線上にあります。
