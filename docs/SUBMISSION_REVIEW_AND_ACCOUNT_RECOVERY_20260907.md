# 重複投稿対策・アカウント復旧 実装記録

日付: 2026-09-07

## 対象

以前の残件のうち、次をローカル実装した。

- 3: 重複投稿・複数アカウントによる同文投稿への対策
- 4: メールアドレスを収集しないアカウント復旧

2026-09-07にstaging限定でD1 migration、HMAC secret設定、Worker deployまで実施した。productionは未変更。

- staging Worker: `seiseki-api-staging`
- staging Version ID: `c84cd054-b9de-40ea-ad92-ff31e4d236fe`
- D1: `0009`、`0010`、`0011`適用済み
- HMAC secret: 解析キャッシュ用と投稿指紋用を別々に設定済み（値は非保存・非表示）
- Turnstile: 実装は含むが、stagingの必須設定は`false`

## 3. 重複投稿対策

自由記述と追記をNFKC正規化し、制御文字除去、空白統合、小文字化を行う。既定では8文字以上の本文を対象に、サーバー秘密鍵付きHMAC-SHA-256を計算する。対象となる最小文字数は `SUBMISSION_FINGERPRINT_MIN_LENGTH` で8〜200文字の範囲に調整できる。

同じHMACが別responseに存在した場合:

- 新しいresponse自体は削除しない。
- 所有者は自分の回答として参照できる。
- `publication_status = held_duplicate` とする。
- 公開集計と公開統計から除外する。
- Workers AI解析は現在どおり実行する。

新規投稿では、response、回答、質問snapshot、所有関係、HMAC、公開状態を同じD1 batchへ入れる。重複判定だけ失敗して保存済みresponseが残る中間状態を避ける。

### 追加したstaging管理経路（ローカル実装、未デプロイ）

- `GET /api/staging-admin/submission-reviews`: 保留状態、response ID、アカウント名、revision、解析状態、正規化後文字数だけを取得する。本文とHMAC値は返さない。
- `PATCH /api/staging-admin/submission-reviews/:responseId`: 管理者が`accepted`または`held_duplicate`へ明示変更する。
- `POST /api/staging-admin/submission-reviews/backfill`: 既存responseを最大100件ずつHMAC補完する。staging専用かつ管理トークン必須。
- アカウント一覧にも公開状態を表示する。

この追加は現在のローカルworktreeにだけ存在する。stagingへの再デプロイ、既存D1へのbackfill実行、production適用は行っていない。

### 意図的に未実装の範囲

- 意味が似ているだけの文章を自動拒否しない。
- 政治的な定型句を自動的に不正扱いしない。
- 「冷やかし」の意図を規則やAIで断定しない。
- 既存responseのHMAC backfillは、管理APIだけ実装し実行はしない。
- 保留一覧専用の画面はまだない。既存staging管理画面ではアカウントごとの公開状態だけを表示する。

## 4. アカウント復旧

メールアドレスを保存しない現行方針を維持する。登録時に高エントロピーの復旧コードを一度だけ表示し、D1にはSHA-256 hashだけを保存する。

復旧時:

1. アカウント名、復旧コード、新パスワードを送る。
2. 復旧コードのhashを照合する。
3. パスワードsalt/hashを再生成する。
4. 既存sessionをすべて失効する。
5. 使用済み復旧コードを無効化する。
6. 新sessionと次の復旧コードを発行する。

ログイン中は現在のパスワードを再確認して復旧コードを再発行できる。旧アカウントは、ログイン後に再発行するまで復旧コードを持たない。

## HMACと暗号化の違い

HMACは本文を後から復号する暗号化ではない。同じ正規化本文かをサーバー側で照合するための秘密鍵付き指紋である。

- 平文: D1の既存response設計に従って保存される。
- HMAC: 重複照合用。秘密鍵がなければ第三者は同じ指紋を再現しにくい。
- 復旧コード: 平文は初回表示だけ。D1には一方向hashだけを置く。
- パスワード: PBKDF2 salt/hash。復号できる形では保存しない。

天から暗号化方式の参考資料を受け取る場合は、本文の暗号化、鍵管理、検索・集計との両立を別工程として評価する。HMAC secretと本文暗号鍵を兼用してはいけない。

## production適用前の必須項目

1. stagingで同文保留と公開集計除外のlive E2Eを追加確認する。
2. 既存アカウント向け復旧コード発行導線を受け入れ確認する。
3. production専用のHMAC secretをstagingとは別に生成する。
4. production D1 migration、secret設定、deployはそれぞれ別承認とする。

## 検証

- Cloudflare test: 105 / 105 PASS
- UI contract testを含むroot node:test: 48 / 48 PASS
- local Vite build: PASS
- 旧統合テストのノード本文上限を現契約160 Unicode文字へ同期
- staging live recovery smoke: 登録201、復旧200、旧session 401、試験アカウント削除204
