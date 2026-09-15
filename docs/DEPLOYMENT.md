# デプロイと公開(DEPLOYMENT)

本書は「HTTPS/TLS対応」「コストの掛からないドメイン導入」「一般公開の厳守」という要件に沿って、声析を公開する方法をまとめます。プロトタイプのまま素早く公開する経路と、本番向けに堅牢化する経路の両方を示します。

## 1. HTTPS / TLS 通信

- **プロトタイプ(現状)**: 本アプリは Claude のアーティファクトとして動作し、配信は HTTPS(TLS)上で行われます。AI解析に用いる Anthropic Messages API(`https://api.anthropic.com`)への通信も HTTPS です。したがって現状でも通信路は暗号化されています。
- **本番(推奨ホスティング)**: Vercel / Cloudflare Pages / Netlify などの静的・サーバーレスホスティングは、いずれも **TLS証明書を自動発行・自動更新(Let's Encrypt 等)** します。独自の証明書運用は不要で、デプロイするだけで `https://` が有効になります。HTTPリクエストはHTTPSへ自動リダイレクトされます。
- **HTTPS前提の堅牢化**: 公開時は HSTS(Strict-Transport-Security)ヘッダの付与、混在コンテンツ(mixed content)の排除、Cookieを使う場合は `Secure` / `HttpOnly` / `SameSite` 属性の付与を行ってください。

## 2. コストの掛からないドメイン

- **無料サブドメイン**: 上記ホスティングは、追加費用なしのサブドメインを標準提供します。
  - Vercel: `<プロジェクト名>.vercel.app`
  - Cloudflare Pages: `<プロジェクト名>.pages.dev`
  - Netlify: `<プロジェクト名>.netlify.app`
  いずれも TLS 込みで、そのまま一般公開できます。**独自ドメイン(例: `example.jp`)の取得・維持は有料** のため、「コストを掛けない」要件のもとでは、まずこれらの無料サブドメインでの公開を推奨します。
- **独自ドメインを使う場合**: 取得済みドメインを各ホスティングに接続すると、証明書は同様に自動発行されます(ドメイン取得・更新費用のみ利用者負担)。

## 3. 一般公開

- **プロトタイプを即時公開**: Claude のアーティファクトは公開リンクを発行でき、追加コストなしにその場で一般公開できます。動作検証やデモ共有にはこれが最短です。
- **ホスティングで公開**: 本番相当の公開は、次節の構成でリポジトリを Vercel 等にデプロイすると、上記の無料サブドメイン + 自動TLSで恒久的に公開されます。
- **公開前チェックリスト**:
  - 管理画面の合言葉を初期値 `admin` から変更、または(推奨)サーバー認証へ置換したか(`docs/SECURITY.md` 参照)。
  - 同意文(個人情報の取り扱い)の版・文面が公開先の運用に合っているか。
  - 免責表示(AI推定である旨・統計的代表性がない旨)が表示されているか。
  - 大量投稿・自動投稿へのレート制限/bot対策を用意したか。

## 4. 本番構成への移行(Supabase 例)

プロトタイプは「クライアント + 共有ストレージ」で完結しています。一般公開で堅牢に運用するには、書き込みをサーバー経由にし、永続化をマネージドDBへ移すのが推奨です。無料枠のある Supabase(PostgreSQL)を例に、移行のポイントを示します。

### 4-1. データモデル(例)

- `responses` テーブル: `id (text, PK)`, `ts (timestamptz)`, `ver (text)`, `consent (jsonb)`, `demo (jsonb)`, `answers (jsonb)`, `free (text)`, `analysis (jsonb)`, `demo_flag (bool)`。
- `opinion_chunks` テーブル(任意・集計/検索最適化用): `id (bigserial, PK)`, `response_id (text, FK→responses.id, on delete cascade)`, `cat`, `topic`, `tt`, `tn`, `emo (real)`, `crit (int)`, `fact`, `ts`。
- インデックス: `responses(ts)`、`opinion_chunks(topic)`、`opinion_chunks(tt, tn)`、`opinion_chunks(ts)` など、ダッシュボードの集計軸に対応するものを付与。
- 集計は、サーバー側の集計API(またはDBのビュー/マテリアライズドビュー)で `responses` から算出します。プロトタイプの `agg:summary` は、サーバーが返す集計JSONに置き換わります。

### 4-2. アプリ側の差し替えポイント

現行実装は移行を見据え、外部I/Oを薄い層に集約してあります。移行時に触るのは基本的にこの2箇所です。

- **ストレージアダプタ `sGet / sSet / sDel / sList`(`core/ui.jsx`)**: `window.storage` への直接アクセスを、サーバーAPI(`GET /api/agg`、`POST /api/responses`、`DELETE /api/responses/:id` 等)への `fetch` に置き換えます。集計は `agg:summary` の読み出しをサーバー集計エンドポイントの呼び出しに、回答保存・削除はそれぞれのAPIに対応させます。
- **AI呼び出し `callAI`(`core/ui.jsx`)**: クライアントから直接 `api.anthropic.com` を叩くのをやめ、サーバーのAPIルート(例: `POST /api/analyze`)経由にします。**APIキー(`ANTHROPIC_API_KEY`)はサーバーの環境変数に格納し、クライアントに露出させません。** サーバー側で `buildPrompt` 相当のプロンプト生成と `sanitizeAnalysis` 相当の検証を行い、検証済みの結果のみ返します。

### 4-3. サーバー側で必須の再検証

`docs/SECURITY.md` の各サニタイズ(`sanitizeFreeText` / `sanitizeQuestions` / `sanitizePolicy` / `sanitizeId` / `sanitizeAnalysis`)は、クライアントの検証を信頼せず **サーバーでも再実行** してください。`core/logic.js` はUI非依存の純粋JSなので、同じロジックをサーバー(Node / Edge Functions 等)で再利用できます。あわせて、パラメータ化クエリの徹底・行レベルセキュリティ(RLS)・管理操作の認可・レート制限を実装します。

## 5. まとめ(最短の公開手順)

1. 検証・共有だけなら、アーティファクトの公開リンクをそのまま使う(無料・即時・TLS込み)。
2. 恒久公開は、`core/` を元に静的/サーバーレス構成を作り、Vercel等へデプロイ → 無料サブドメイン + 自動TLSで公開。
3. 一般公開で本格運用するなら、書き込みとAI呼び出しをサーバー経由に移し(Supabase等)、APIキー秘匿・認可・レート制限・DB側の検証を有効化する。
