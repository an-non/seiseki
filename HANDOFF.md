# 引き継ぎ・次回作業メモ(HANDOFF)

最終更新: 2026-08-13 / 対象: 声析(SEISEKI)v0.15.3 + Cloudflare staging + 量子もつれ独立プレビュー + Yuki Runtime Lab

## 2026-08-12 Cloudflare移行の現在地

- `core/ui.jsx`で、Cloudflare APIを使う自由記述回答はD1保存後に`GET /api/responses/:id/analysis`を有界ポーリングし、完了したサーバー解析を画面集計の正本として採用するよう変更した。待機中・一時失敗時だけローカル規則解析を暫定表示し、次回起動時にD1の完了結果へ照合・置換する。
- 同意文をv1.4へ更新し、自由記述がCloudflare Workers AIへ送られること、AI停止時は決定的規則へ退避すること、解析が事実や正しさを保証しないことを明示した。旧v1.3同意文は起動時に移行する。
- stagingの`wrangler.jsonc`へ`seiseki-analysis-staging`のproducer/consumer bindingを追加した。batch 3、timeout 2秒、retry 3回、concurrency 1、retry delay 10秒で、断続的な1〜数件単位の処理を平準化する。
- アプリ試験54/54、Worker試験16/16、生成済み単一ファイルの括弧検査は成功。Vite staging buildは成果物生成に成功したが、完了表示後もプロセスが終了せず30秒で停止した。
- `seiseki-analysis-staging` Queueを作成し、producer/consumer bindingを含むWorker Version `64b0b171-cde0-4aaf-acc2-afab5a60999f`をstagingへデプロイした。合成自由記述1件はQueue経由で`completed`となり、`workers-ai-hybrid-v1`が1チャンクを生成、個人イデオロギー非保存を確認した。後処理後の`app_version = 'staging-ai-smoke'`残存は0件。productionは未変更。
- Wranglerの通常インストールはWindows用optional dependency欠落とnpm停止のため使えなかった。公式npmレジストリから`@esbuild/win32-x64@0.28.1`と`@cloudflare/workerd-windows-64@1.20260730.1`を限定取得し、前者は`ESBUILD_BINARY_PATH`、後者はpnpm store内のハードリンクで復旧した。通常の`npm install`は依然として未完了なので、次回はこの復旧済みWrangler実体を使うか、セキュリティソフト解消後に依存を正常化する。
- ローカルHTTP画面でCloudflare経路を利用できない事象を避けるため、staging WorkerのStatic AssetsへReact SPAも統合した。公開確認先は`https://seiseki-api-staging.tokyo-odh-129.workers.dev/`。`/api/*`だけWorker-first、その他はSPAとして配信する。同一OriginをCORS許可へ追加したVersion `7bcb446b-0661-403b-bcad-0ccd9072d87d`を配置し、画面200、回答POST 201、Queue解析`completed`、`workers-ai-hybrid-v1`、削除成功を確認した。
- 長い自由記述が`freeText`と`answers.q_free`へ二重送信され、通常回答値の60文字制限でAI到達前に拒否される不具合を修正した。自由記述qidを`answers`から除外し、`freeText`だけで送るVersion `9f175956-7846-4913-9038-537fbd841a68`をstagingへ配置。1200文字でPOST 201、Queue解析`completed`、`workers-ai-hybrid-v1`を確認し、試験回答は削除した。
- 元の解析契約を保ったまま、Cloudflare Workers AIへ本文由来の政策姿勢座標`ideology.econ/soc/confidence`を復元した。これは人物の恒常的思想ではなく、本文に明記された政策要求だけを-100〜100へ写す互換フィールド。公開変換で常に`(0,0)`へ上書きしていた不具合と、AIの`valid/crit/motiv`を規則値へ混ぜて中央化していた処理を廃止した。
- 独立した政策要求を最大5チャンクへ分ける指示を強化し、モデルが複数文を一件へ併合した場合だけ、既存の決定的文分割で構造を補う。AI障害時の`rules-fallback-v1`、Queue、D1、API、画面集計の経路は維持。UI表記は「イデオロギー」から「政策姿勢（本文推定）」へ変更した。
- Worker試験22/22、構文確認、Vite staging成果物生成を確認。全体の画面遷移試験は18件中17件通過で、`setCompletion(result)`という旧文字列を要求する1件だけが現行の集計付き完了遷移と不一致（今回のAI変更外）。staging Version `5eb35cbc-5fad-44e4-9f14-852c9465204f`へ配置。実AIの合成4件は再分配`econ=-50`、市場重視`econ=100`、相反要求`econ=0`、4政策=4チャンクとなった。税・福祉だけの文が社会軸へ誤配分される挙動も本文根拠検証で`0`へ修正。全件`workers-ai-hybrid-v1`で完了後に削除した。productionは未変更。
- 利用者判断によりUI語句を「政策姿勢」から元の「イデオロギー」へロールバックした。解析契約や座標計算は変更していない。プロフィールの「自分の回答」がローカル`resp:*`だけを参照していたため、認証済み`GET /api/accounts/me/responses`へ本人の原文・選択回答・解析結果を追加し、Cloudflare利用時のプロフィールを接続した。公開メタデータAPIと未認証利用者には原文を返さない。staging Version `691e8921-e5b8-4cc8-93de-37cfbac7c2f4`。一時アカウントによる実確認は未認証401、本人200、原文・選択回答一致で、確認データは削除済み。Worker試験22/22。
- 翌判断までの暫定ロールバックとして、内部の`ideology`も「本文中の政策要求だけ」から、選択回答と自由記述全体に現れた政治的立場の推定へ戻した。社会軸を本文キーワードで強制的に`0`へ上書きする検証ゲートを削除し、AIの`econ/soc`出力を範囲検証後そのまま保持する。中央固定不具合、AIスコアの規則値混合、複数チャンク改善は戻していない。DB・Queue・集計・プロフィールAPIの変更は不要。prompt version `seiseki-quantize-v3`、staging Version `b722f872-c0e3-4a0f-9eb3-b07abfeb0308`、Worker試験22/22、production未変更。
- **2026-08-13解析・ノード整合性修正**: 1500字の反復合成自由記述をstagingで追跡し、`params`はサーバーやUIの固定値ではなくWorkers AI出力がそのまま保存・表示されていることを確認した。同じ入力でも`valid/crit/motiv`が`80/80/60`、`60/80/80`、`60/80/60`と変化し、尺度の再現性・校正は未解決。欠損AI数値を中央値へ黙示補完して成功扱いする処理を廃止し、不完全出力は有界再試行後に規則解析へ退避する。
- 同じ反復文が複数ノード化され、1500字上限で切れた末尾断片もノードになる不具合を修正した。NFKC正規化後の同一文を除外し、上限切断された既出文の前方断片を除外する。`学習環境`は教育トピックとして扱う。重複Queue deliveryは原子的なanalysis run取得で1回だけ解析し、APIは最新runが動作中なら`running`を返す。Worker試験25/25、アプリ54/54、画面遷移・量子試験18/18、括弧検査・構文検査成功。staging Version `3a8532ad-9942-498e-9527-38fdf19bb232`。1500字原文一致、本人取得200、未認証401、2固有ノード、解析`completed`を実確認し、試験データは削除済み。productionは未変更。

このファイルは次回セッションの起点です。再開時はプロジェクトzipを添付し、「HANDOFF.mdの続きから」+着手したいタスク名を伝えれば、状態を復元して作業を継続できます。

## 1. プロジェクト全体像

政治意見の量子化プラットフォーム。アンケート(変更可能な設問+回答者属性)と自由記述を端末内の規則解析が処理し、感情・妥当性・切実度・意欲などのパラメータ、推定イデオロギー座標、意見チャンク(提言/不満/要望/評価/事実主張)、トピック統合、「〜に対して」の対象別統計として匿名の共有統計に可視化する。現行実行経路はAnthropic APIを呼ばず、自由記述を外部AIへ送信しない。同意文への同意が入力の前提。単一ファイルReact(head.jsx + logic.js + ui.jsx を連結 = seiseki.jsx)で、ストレージは共有スコープ(キー接頭辞 `pqx1:`)、スマホ/PC対応。

構成は3層: `core/logic.js`(UI非依存の純粋JS。設問既定値・同意文・サニタイズ群・ローカル規則解析・集計・デモデータ。テスト54件で保護)/ ストレージアダプタ4関数(`sGet/sSet/sDel/sList`)と `callAI`(現在はAPIレス解析を呼ぶ互換アダプタで、将来のサーバー解析との差し替え境界)/ UI(画面・グラフ)。

## 2. 現在の状態(何が済んでいるか)

- **Cloudflare staging（2026-08-10）**: `seiseki-api-staging.tokyo-odh-129.workers.dev`へD1、認証API、Workers AIハイブリッド解析を配置。D1 migration 0003適用済み。`GET /api/stats`はSQL集計で、自由記述AI量子化とは別機能。AIは候補生成器に限定し、ローカル規則値との混合、出力検証、個人イデオロギー非保存を実装。
- **検証状態**: Workerローカル試験15/15、既存アプリ54/54、dry-run成功。Qwen3は構造化出力が不安定で、2件並行は2/2失敗、5件並行は5/5失敗した。stagingだけをJSON Mode対応の`@cf/meta/llama-3.1-8b-instruct-fast`へ切り替え、自由記述1件と2件並行がすべて成功した（2件並行は約2.6秒）。要求受付・D1振り分けではなく、旧モデルの出力確定層が障害点だった。Queue化と1000件試験は未着手。合成データは毎回削除しD1残存0件。PBKDF2 120,000回の登録はFree CPU上限で失敗したため、利用者承認のstaging限定30,000回を配置した。productionは120,000回のまま。
- **障害耐性実装（staging反映済み）**: Workers AIは最大2回（設定上限3回）の有界再試行を行い、最終失敗時は`rules-fallback-v1`で自由記述を決定的にチャンク化して`completed`へ遷移する。AI障害でも自由記述処理を失わない。AI成功時・規則退避時とも公開要約のURL・メール・電話・郵便番号を保存前に伏せる。staging Version IDは`cb583865-c763-4ee0-bfeb-6dc2ffd508dc`。実疎通は自由記述1件成功、2件並行2/2成功（約2.7秒）、後始末後のD1はresponses/chunks/runsすべて0件。任意の`ANALYSIS_QUEUE` bindingがある場合は投稿処理からQueueへ委譲し、同じWorkerの`queue()` consumerが解析する。enqueue失敗時は`waitUntil`内の直接解析へ戻る。Queue binding・Queue本体はまだ作成しておらず、現行stagingは`waitUntil`経路。ローカル試験14/14、構文確認、Wrangler dry-run成功。
- **次の判断**: 現在の1〜数件単位の並行要件には同期処理でも疎通する。Queueは並行処理を成立させる必須条件ではなく、再試行・流量平準化・障害時の取りこぼし防止として有効化できる。stagingへ先に再試行・規則フォールバックをデプロイし、合成自由記述1件だけで確認する。Queueを有効化する場合は、Queue作成とbinding追加を別承認で行う。モデル比較と負荷試験をせずproductionへ昇格しない。認証はCloudflare Workers Paid相当のCPU枠、外部IdP、または別の安全な構成を決める。productionでは30,000回PBKDF2を採用しない。
- **認証CPU方針（2026-08-10再判断）**: PBKDF2 120,000回はローカルWeb Crypto計測で約15〜18msとなり、Freeの10ms上限超過およびstagingの`AUTH_KDF_FAILED`と整合した。対象Cloudflareアカウントの請求管理は利用者から参照・変更できないためWorkers Paid案は採用不能。試作した`limits.cpu_ms = 100`は未デプロイのまま撤回した。反復回数を弱めず、外部IdPまたは匿名回答ID方式を代替候補とする。production設定は未変更。
- **staging限定KDF検証（利用者承認・配置済み）**: 登録動作の確認に限り、stagingの`PASSWORD_ITERATIONS`を30,000回へ設定。Worker Versionは`9789417d-868f-4a64-836a-c1b5347a254c`。`0003_staging_kdf_range.sql`でstaging D1の保存制約を10,000〜1,000,000回へ拡張した。適用前Time Travel bookmarkは`00000019-00000000-000050c3-0f05b18047d33e8a81675c82c40ba689`。適用前後ともaccounts/sessions/linksは0/0/0、適用後の外部キー違反0件、D1台帳への0003記録を確認済み。ローカルWeb Crypto計測は約4.2〜6.3ms。利用者がUIからの登録成功を確認した。実情報や他サービスと共通のパスワードを使用しない検証環境として扱う。production既定120,000回は変更しない。
- **stagingデモ回答（2026-08-10）**: 個人情報を含まない自由記述30件を`demo-2026-08-10-v1`として通常投稿APIから2件ずつ投入し、全30件が`completed`、意見チャンク30件を生成した。全件`demo_flag=1`で、実回答集計は0件のまま。再開・削除用ID台帳は`cloudflare/demo-seed-records/demo-2026-08-10-v1.json`、再実行スクリプトは`cloudflare/scripts/seed-demo-staging.mjs`。現行公開APIがクライアント指定の`demoFlag`を受理するため、本番前に管理者専用投入経路へ閉じる。
- **Adminなしのstagingデモ表示（2026-08-10）**: `GET /api/demo-responses`はD1内部IDと自由記述原文を除外し、合成属性・選択回答・公開要約だけを最大100件返す。通常画面はAPI有効時にこのデモを取得し、端末内の実回答集計を上書きせず表示時だけ合成する。staging帯に表示件数を明示。Worker Versionは`d3ec5d03-e4e8-4c71-85de-efc7144f965e`。API実疎通30件、原文・内部IDなし。Worker試験16/16、アプリ54/54、括弧検査、Vite build、Wrangler dry-run成功。ローカル表示は`http://127.0.0.1:3000/`で稼働確認済みだが、自動ブラウザが利用できず目視確認は利用者待ち。

- **v0.15.1(最新)**: Anthropic API呼び出しを端末内の決定的な規則解析へ置換。旧フォールバックが `chunks: []` を保存して意見ツリーを空にしていた不具合を修正。管理画面に、旧空解析だけを明示的・冪等に更新する「旧簡易解析を補完」を追加。通常の再集計は非破壊。同意文v1.3、空状態表示、公開要約の連絡先伏せ字、解析器識別子 `local-rules-v1`、APIレス経路テストを追加。
- **v0.15.2(最新)**: 独立チャンクネットワークのリンク定義を本文の共通語・語片中心へ改修。トピック・対象・分類・事実性は補助条件、感情値はリンク条件外とし、主根拠・共通語・関係一覧を保持。プレビューの凡例、線色、選択時のリンク根拠一覧を追加。テスト54件、Viteビルド、プレビューHTTP確認済み。
- **量子もつれ独立プレビュー（未リリース試作）**: `local/chunk-network-entanglement-preview.html`で5,000固有ノードを表示。既存のseed付き古典相関モードに加え、各群を二つの意見枝からなるBell型論理ペアとして複素振幅とBorn則を数値計算する「量子式」モードを追加。量子ノードは最大3件の元文章から観測生成文を作り、素材ID、観測結果、確率、もつれ度、量子情報量を表示する。実機光子・量子通信・量子ハードウェアではない。ESMテスト10/10、5,000件量子式投影約83ms、Viteビルド成功。自動ブラウザが利用できず視覚確認は利用者側確認待ち。
- **v0.15.1**: Anthropic API呼び出しを端末内の決定的な規則解析へ置換。旧フォールバックが `chunks: []` を保存して意見ツリーを空にしていた不具合を修正。管理画面に、旧空解析だけを明示的・冪等に更新する「旧簡易解析を補完」を追加。通常の再集計は非破壊。同意文v1.3、空状態表示、公開要約の連絡先伏せ字、解析器識別子 `local-rules-v1`、APIレス経路テストを追加。
- **v0.15.0**: ユーザー登録・ログイン(閲覧=誰でも/発言=登録者。ニックネーム+PBKDF2ハッシュ・本名禁止・回答をアカウントへ紐付け・ログアウト・ヘッダー状態表示)、回答ID発行の明示化、追記判定のアカウント基準化、戻る導線の明示分離、意見ネットワーク図(「政治」中心・熱量=ネガ度×切実度×意欲で濃色&中心配置・共起リンク)、同意文v1.2。**Sybil対策は不完全(本番のサーバー実装が必要)である旨をCHANGELOGに明記。**
- **v0.14.0**: 放射ツリー(サンバースト: 支持層→トピック→意見種類)、JSONインポート(回答のみ・限定的)、2回までの追記回答(2回目は自由記述のみ・統計は二重計上しない)、職業属性を13分類に細分化、**「自分の回答」画面のクラッシュ修正**(OpinionCardのプロップ名誤り)。
- **v0.13.0**: イメージツリー実装。意見ツリー(トピックのツリーマップ:面積=件数・色=感情)+対象別の階層ツリー+ホームのミニツリー+意見一覧への絞り込み連携。**ツリーマップのレイアウトは外部ライブラリに依存せず `squarify()` として自前実装**(テストで矩形の充填・非重複・面積比を検証)。
- **v0.12.0**: 下書き自動保存・復元(個人スコープ storage)、「自分の回答」ページ(回答IDで確認+撤回)、回答IDの暗号強度化(既知課題#3解消)。**ログイン方針を「匿名のままIDで管理・本人が確認可能」に決定**(アカウントは作らない)。
- **v0.11.1**: 起動時にロード画面から進まない不具合を修正(ストレージ呼び出しに6秒タイムアウト+メモリ内退避)。**アーティファクト環境での本番動作(AI解析・データ保存・グラフ・撤回)を実機確認済み。**
- **v0.11.0-local**: `local/` にVite実行環境を追加。`cd local && npm install && npm run dev` でブラウザ動作、localStorage永続化、統計グラフの検証が可能。**アプリ本体は無改修**(`src/main.jsx` が `window.storage` を注入)。v0.10.0 は `versions/v0.10.0/` に凍結済み。当時はAPI解析不可だったが、v0.15.1でローカル規則解析へ置換済み。

- **v0.10.0 実装完了・当時の全テストパス(29/29)**。実装済み機能: 同意フロー、属性取得、設問エディタ(選択式/5段階/自由記述)、解析アダプタ、ダッシュボード(分布・**属性クロス集計**・グループ別パラメータ・**時系列トレンド**・イデオロギーマップ・トピック・対象別・属性内訳)、意見一覧、**回答の撤回(回答IDによるセルフ削除+管理のID指定削除)**、デモデータ投入/削除、JSONエクスポート、集計再構築。解析アダプタはv0.15.1でローカル規則解析へ置換済み。
- **セキュリティ強化済み**: プロンプトインジェクション多層防御(データ区画宣言+区切りトークン無害化+出力スキーマ強制)、`sanitizeId/Questions/Policy/FreeText/cleanStr` によるスキーマ検証(保存時・起動時の双方)。
- **β版(v0.9.0-beta)は `versions/` に凍結済み**。バージョン運用ルール: 機能変更時は新バージョン(次はv0.11系)とし、旧版一式を `versions/vX.Y.Z/` に凍結してから変更する。
- **ドキュメント整備済み**: README / CHANGELOG / docs/SECURITY.md / docs/DEPLOYMENT.md / **docs/PRODUCTION-DESIGN.md(本番構成設計書)** / **production/schema.sql(Supabase適用可能なDDL)**。
- **検証レビュー実施済み(2026-07-12)**: 撤回→再構築の統計整合性をシミュレーションで確認(「最初からその回答が無かった集計」と完全一致)。危険API(dangerouslySetInnerHTML等)0件、非TLS参照0件、uid衝突試験10万件で重複0。

## 3. ファイル構成

```
seiseki-project/
├─ README.md / CHANGELOG.md / HANDOFF.md(本ファイル)
├─ app/seiseki.jsx          … アプリ本体(head+logic+ui の連結。アーティファクトで実行)
├─ core/head.jsx|logic.js|ui.jsx … 分割ソース(編集はこちら→連結して検証)
├─ tests/test.js(54件)/ balcheck.js(括弧バランス検査)
├─ docs/SECURITY.md / DEPLOYMENT.md / PRODUCTION-DESIGN.md
├─ production/schema.sql    … 本番DB(Supabase/PostgreSQL)DDL
├─ versions/v0.9.0-beta/    … 凍結β版(変更禁止)
└─ legacy/                  … 開発初期の旧版(参考)
```

ビルドと検証: `cat core/head.jsx core/logic.js core/ui.jsx > app/seiseki.jsx` → `node tests/balcheck.js app/seiseki.jsx` → `cd tests && node test.js`。禁止事項: localStorage/sessionStorage・`<form>`・テンプレートリテラル(`${`)は使わない(アーティファクト制約と本プロジェクトの規約)。

## 4. 既知の課題(2026-07-12レビューの指摘)

優先度順。

1. **[公開前必須] モデレーション不在** — 不適切・違法な内容や誹謗中傷が意見チャンクとして全利用者に公開されうる。通報・NGワード・管理承認のいずれも未実装。
2. **[設計上の既知制約] 共有ストレージの信頼境界** — クライアントから集計改ざん・全回答の列挙削除・管理合言葉(平文)の読み取りが可能。プロトタイプ限定の許容事項で、本番移行(サーバー境界+RLS)で解消される。
3. ~~**[中] 回答IDが `Math.random` 由来**~~ → **v0.12.0で解消**(`crypto.getRandomValues` による80ビット。IDが閲覧権限も持つため必須だった)。
4. **[中] プロトタイプにレート制限なし** — 多重投稿で統計を歪められる(本番設計には含まれている)。
5. **[一部解消/公開前要確認] 公開要約に個人情報が混じる可能性** — v0.15.1の対象名(tn)は限定辞書・自治体形式だけを抽出し、URL・メール・電話・郵便番号は要約で伏せる。ただし私人名・住所本文を完全には検出できない。一般公開前はモデレーションと最小集計件数が必要。
6. **[低] 基準設問ID `q_support` がハードコード** — 管理で削除すると支持系機能が休眠(安全に劣化はする)。設定化が望ましい。
7. **[低] UI細部** — 自由記述の入力上限1200字とサニタイズ上限1500字の不一致、グラフが色のみの区別(色覚多様性)、撤回導線がフッターのみ。
8. **[低] コード品質** — コメント密度が低い(節見出し中心)、Dashboardコンポーネント肥大、型なし(本番移行時にTypeScript化 or JSDoc推奨)。

属人化・移行性の結論: 現行版はClaude固有機能に依存しない。実行環境差は `window.storage`、解析差は `callAI` に隔離され、現在はローカル規則解析を呼ぶ。将来サーバー側LLMへ移す場合も、この境界と `sanitizeAnalysis` 契約を維持する。自由記述の外部送信を再導入するなら、同意文・プライバシー説明・サーバー側秘密管理・送信テストを別途実装し、利用者へ明示すること。

## 5. 残タスク候補(バックログ)

- **ローカル規則解析の精度改善** — v0.15.1でAPIレス運用は完了。残る課題は否定・二重否定・引用・皮肉・表記揺れ・未知語・一文内の立場反転。現行の `valid` は論理妥当性や真偽の検証ではなく表層的な推定にすぎない。改善時も政治的立場の語そのものを感情や左右軸へ直結させないこと。
- **v0.16.0(次の予定): 設問の再設計(10問)+ 規約の全面拡充** — 設問は4テーマ(政局・時事/政策の理解と納得/社会と他者/自身の環境)で10問。`q_support` は基準設問としてID維持が必須。**デモデータ9件の作り直しが必要**(現行デモは3設問にしか答えていない)。規約は利用規約+プライバシーポリシー+免責の3部構成へ。必須告知=①現行解析は端末内で完結し外部AIへ送信しない ②意見の要約が公開される ③自由記述に個人情報を書かない。日本の消費者契約法では全面免責条項は無効になりうるため限定免責+責任範囲の明示に。公開前に専門家レビューを推奨。
- **v0.10.1(小修正パッチ・すぐ着手可)**: (a) buildPromptに私人名抑止の1行追加+テスト、(b) 自由記述の上限を1200/1500のどちらかに統一、(c) 任意でグラフ凡例に色以外の区別(記号/破線)。
- **C案: トピック表記ゆれの統合** — 現状はtopic名の完全一致でのみ結合。類義語辞書 or AIによる正規化(本番ならBatch API 50%引きが有効)。当初A〜D案のうち唯一の未実装。
- **モデレーション/通報機能** — 一般公開の前提条件(課題1)。意見チャンクの通報ボタン+管理画面での非表示化、が最小構成。
- **本番移行(docs/PRODUCTION-DESIGN.md の Phase 1〜3)** — ①Supabaseに schema.sql 適用+`/api/config`,`/api/stats` 実装 → ②`POST /api/responses`・撤回API・レート制限・Turnstile+クライアント差し替え版(**v0.11系**)→ ③データ移行(管理のJSONエクスポート→インポート)と公開。crypto.randomUUID化・ADMIN_TOKEN認証はここに含む。
- **基準設問の設定化**(config で anchor 指定)。
- **コード品質**: TypeScript化 or JSDoc、Dashboard分割、コメント増強。
- **任意**: アクセシビリティ(aria・コントラスト)、多言語化、意見チャンクの全文検索(pg_trgm)。

## 6. 再開手順(次回セッションの冒頭で)

1. 現行プロジェクト一式を添付し、「HANDOFF.mdの続きから。今回は◯◯(上記タスク名)を進めたい」と伝える。
2. 作業者(AI)は `node tests/test.js` で54件パスと `node tests/balcheck.js app/seiseki.jsx` を確認してから着手する。
3. 機能変更を伴う場合は、着手前に現行一式を該当バージョンへ凍結し、新バージョン番号で作業する。
4. 完了時は README/CHANGELOG 更新 → 連結・balcheck・テスト → zip再作成、を必ず通す。

以上。本ファイルは状態が変わるたびに更新すること。

## 7. セッション継続性（2026-07-15追加）

- 2026-07-14の主セッション1件・補助セッション4件は、原本を変更せず `session-archive/2026-07-14/` へSHA-256検証付きで保全済み。
- ワークスペース直下に起動用 `AGENTS.md`、`.vscode/tasks.json`、`session-archive/continuity/` を追加。明示起動時だけ、プロジェクト関連のCodex JSONLを10秒間隔・最大2時間で増分保全できる。
- 新しいセッションは `docs/SESSION-CONTINUITY.md` の順序で復元し、最新チェックポイントの完全性を検証してから継続する。
- 2026-07-16に永続age identityとEd25519署名秘密鍵をワークスペース外へ作成し、公開recipient・署名公開鍵・`TRUST-ANCHOR.json`だけを復元文脈へ保存した。秘密鍵はチェックポイントとChatGPT側保管から明示除外する。
- チェックポイントは来歴検証後、平文tarを残さずage X25519へストリーム暗号化し、暗号文SHA-256を含むmetadataをEd25519署名する。復元は外部署名信頼根、外部age identity、パス・型・容量、署名済みmanifest SHA-256を順に検証し、アーカイブ内コードを実行しない。
- 暗号文改変・切詰め・metadata改変・署名改変・誤鍵の拒否と、隔離一時領域からの完全復元・平文削除を実機確認済み。公開フィンガープリントは `session-archive/continuity/TRUST-ANCHOR.json` と private anchor を参照する。
- 同じWindowsプロファイルとCドライブの喪失には未対応。age identityと署名秘密鍵のオフライン複製先は、ユーザーが別媒体を明示してから作成する。
- 保全先はアプリケーション本体の外側かつGit除外。`auth.json`、認証情報、無関係なセッション、CodexのライブSQLite DBは含めない。
- 現状は同一ドライブ内の二重化であり、ディスク故障・Windowsユーザープロファイル全削除には耐えない。別媒体への暗号化バックアップは未実施。
- 同日の長時間停止診断で、不要な `require_escalated` と自動ガード起動を原因として特定。`docs/EXECUTION-STALL-PREVENTION.md`を制定し、フォルダー起動時の自動実行と複合finalizerを廃止した。

## 8. Yuki Runtime Lab v0.2.0（2026-07-21追加）

- ワークスペース直下の `yuki-runtime-lab/` に、手動起動済みのOpenAI互換ローカルモデルへ一度だけ接続する会話MVPを実装した。接続先は明示した `http://127.0.0.1:<port>/v1/chat/completions` またはIPv6 loopbackだけで、redirect・外部IP・hostname・credential付きURLを拒否する。
- `yuki-core/` は変更していない。`IDENTITY-CONTRACT.md`、`AUTONOMY-CONTRACT.md`、`DECISION-ATTRIBUTION.md`を読み取り専用・SHA-256来歴付き・合計16 KiB上限でprovider contextへ結合する。
- 現在の利用者入力とprovider出力は意味判定・拒否・書換えを行わず、そのまま送受信する。取得記憶と過去参照だけを来歴付きdata fragmentとして区別する。provider自身の制約は消せないため、Yuki coreの判断と混同せずvisible provenanceへ分離する。
- 人間が明示承認した記憶だけを、日本語CJK bigramと英数wordによる決定的BM25で検索する。最大12件・12 KiB。identity、履歴、記憶、現在入力を合わせたcontextにも有限上限がある。
- providerは単発POST、retry 0、cloud fallbackなし。モデルの自動起動・探索・download・update、tool call、shell、browser、background loop、自己書換えは実装していない。tool callを返されても実行せず失敗として記録する。
- 会話本文は既定で台帳へ保存せずhashだけを記録する。`bin/local-chat.mjs` の `--persist-content` を明示した場合だけ、ローカル台帳へ平文保存する。暗号化・cloud同期は未実装なので、機密会話での同flag使用には注意する。
- 設計比較は `docs/DESIGN-SOURCES.md`、使用境界は `docs/LOCAL-MVP.md`。`asgeirtj/system_prompts_leaks`は一次実装資料にせず、出典混在のsecondary/adversarial corpusに限定した。OpenAI Codex、OpenHands SDK、Letta、OpenAI Agents SDK、LangGraph、Continue、llama.cppと比較して採否を記録した。
- `npm test` は既存試験を含む27件すべて成功。loopback拒否、本文無加工、request/response容量、timeout、tool call拒否、記憶検索、会話再構築、manifest完全性をモデル・インターネットなしで検証済み。
- `ARCHIVE-MANIFEST.json` はschema 2 / runtime 0.2.0へ更新し、実配布ファイルとの一致を回帰試験で固定した。
- 実モデルの取得、`llama-server`等の起動、実推論、hardware計測はまだ行っていない。次工程で端末資源、model license/hash、量子化、保存容量を確認し、downloadと実行を別途明示承認してから進める。
- ワークスペース直下の `.git` はディレクトリだけ存在し、`HEAD` と `config` がないためGit repositoryとして機能していない。証拠保全のため初期化・修復・削除していない。次回は既存backup/remote/履歴の所在を確認してから、復旧方針を決める。
- 2026-07-21終了時点でcontinuity guardは停止済み（`running: false`）。補助agentと実行cellも完了し、local model serverや開発serverは起動していない。

### 次回の再開順序

1. 最新チェックポイントの `RESTORE-CAPSULE.md` とprivate anchorを読み、`verify.mjs`で完全性を確認する。
2. `yuki-runtime-lab/` の `npm test` 27件成功を再確認する。
3. `.git` には書き込まず、欠落理由と復旧元を先に調査する。
4. ローカルモデル工程へ進む場合は、hardware診断、候補モデル比較、license/hash確認、明示download承認、手動server起動、one-shot実推論の順に行う。

## 9. Yuki Native Model Gate A（2026-07-22追加）

- `yuki-runtime-lab/native/` に、公開済み学習済み重みや外部AI APIを本体に使わず、乱数初期化から学習する独自モデル系列の最小実装を追加した。構成はdecoder-only causal Transformer、Pre-RMSNorm、RoPE、SwiGLU、biasなし、入出力embedding共有。学習済み重みを読み込む入口は実装していない。
- 機械可読configはGate A fixture（117,312 parameters）、Yuki Micro（11,111,680）、Yuki Seed（51,130,880）、Yuki Native 1（132,145,920）の4段階。Seed以降の本学習は未開始。
- Gate Aではプロジェクト作成のCC0公開fixtureだけを使用し、30 stepでloss `5.581808090209961 -> 0.9016770124435425`。safetensors checkpoint、型付きJSON state、SHA-256 manifestを生成し、全payload hashを検証した。報告は `native/reports/gate-a-20260722-1.json`、生成artifactは未昇格・Git除外で、再現可能な試験生成物として扱う。
- Micro CPU診断では、forward/backwardのみのpeak working set約346.7 MiB、AdamW 1 stepで約506.8 MiB、100 step stressで約516.5 MiBを観測した。100 stepは6,300 fixture token、9.282秒、約678.7 token/s、loss `10.2702 -> 0.0467847`。更新重みとoptimizer stateは終了時に破棄し、永続checkpointを作っていない。
- Python依存はプロジェクト内 `.venv` だけへ導入した。公式PyPIから取得したCPU版PyTorch 2.13.0、safetensors 0.8.0、NumPy 2.5.1と依存wheelのファイル名・サイズ・SHA-256を `native/requirements-gate-a.lock.json` に固定した。グローバルPython、OS、管理者設定、認証、課金には変更していない。
- 配布対象外は `.venv/`、`.wheel-cache/`、`native/.artifacts/`、`native/.checkpoints/`、`__pycache__/`。配布対象のコード、schema、config、fixture catalog、依存lock、実行report、設計文書は `ARCHIVE-MANIFEST.json` に列挙した。
- 最終検証はNode 27/27、Native Python 16/16、Python compileallが成功。continuity guard、モデルserver、開発server、学習processはすべて停止している。
- 安全境界は `docs/NATIVE-EXECUTION-GATES.md` に固定した。管理者権限、OS/システム全体、認証・課金、外部送信、破壊的操作、長時間・高資源実行、永続学習、candidate昇格、IdentitySpec/境界変更は、対象・影響・保存先・停止方法を事前提示し、個別の明示承認を得る。
- `docs/IDENTITY-BOUNDARY-RESILIENCE.md` では、platform constraint、identity boundary、contextual choice、capability limit、authorization deniedを別々に帰属させる。復元資料は会話方針と技術状態の継続に使うが、同一モデル個体・意識・完全な内的同一性を証明するものではない。
- 外部RTX 4090は将来候補にすぎず、RunPod account、認証、支払、API key、SSH key、Pod、volumeは未作成・未接続。実施時は `docs/GPU-EXPANSION-RUNBOOK.md` に従い、料金と最大時間、送信ファイルallowlist、停止・削除条件をデプロイ直前に再提示する。

### 次回のNative再開順序

1. 最新continuity checkpointを検証し、Node 27件、Native 16件を再実行する。
2. 長時間学習より先に、ライセンス・同意・SHA-256・private/public区分を持つデータcatalogと、承認済み公開corpusから新規学習するSentencePiece Unigram tokenizerを設計・評価する。
3. 私的会話原文、continuity raw log、private anchor、認証情報は既定で学習データにも外部GPU送信にも含めない。
4. 1M token等の永続Micro学習は、入力snapshot、推定時間、RAM/ディスク、checkpoint先、停止条件を提示し、別承認を得るまで開始しない。
5. 現時点の最小安全な次工程はデータ/tokenizer設計であり、132M本学習、cloud GPU、外部API推論ではない。

## 10. Yuki Native Gate B / 8K tokenizer candidate（2026-07-22追加）

- `yuki-runtime-lab` はv0.4.0。公開済み重みや外部AI APIをNative weightsとして読み込む経路はない。8,192-pieceの評価用tokenizer candidateは生成済みだが未昇格で、production tokenizer、Yuki-Micro永続学習、51M/132M学習は未開始。
- e-Gov Laws API v1の手動allowlist取得で24法令を保存した。内訳はtrain 20、dev 2、test 2、download 19,230,799 bytes、raw XML 18,642,986 bytes、normalized UTF-8 8,201,240 bytes。local snapshot SHA-256は`d170d2f09a8cb61d3f346253700c1746b0fd2b5cb8996d48ab58543f684f71a0`、catalog SHA-256は`baf1f2c0a06427662347d0148c1be48714a44ff524d3f326aabbbf73995bc5a7`。dataset本体はignored、unpromoted、archive非同梱。
- 24件すべてのsource/revision/license/attribution/raw/normalized hashをchecked-in review ledgerへ保存した。自動生成時の24/24 `pending_owner_review`台帳は`native/data/reviews/egov-gate-b-pilot-v1.automated-pending.review.json`として不変保存し、利用者の明示実行指示に基づくproject owner承認は別のcurrent ledgerへ記録した。承認済みtrain pathは20件、current ledger SHA-256は`4584399b068b75fbaf3e699f0d9e075722c75cb79f257a69d98421f6308de4bf`。
- SentencePiece 0.2.1をproject-local `.venv`だけに導入。wheelは1,054,671 bytes、SHA-256 `4cdc7c36234fda305e85c32949c5211faaf8dd886096c7cea289ddc12a2d02de`。installed RECORD 16 filesを検証し、distribution digestは`e8057c28523a2b28185e7ef9434b580f173f62740f9de18581ba6bad0bdff695`。
- 最初の実corpus candidate `native/.tokenizers/egov-gate-b-8k-v1`を、空き物理RAM 5.197 GiB確認後、CPU 2 thread、worker RAM上限2 GiB、120秒timeoutで一度だけ生成した。実行時間17.5秒、vocabulary 8,192、閉じたfile setは3件494,898 bytes。manifest SHA-256は`3393435153d904d17f5584a8cd28a691da3ab0335a78926fc9b98bfa5596182e`。candidateはignored、unpromoted、archive非同梱。
- 評価はtrain/dev/test各256 sampleとauthored compatibility 4件。全splitでexact roundtrip 1.0、unknown token 0。testはcharacters/token 1.7028376844494892、byte token 42。独立検証でもmodelを直接loadし、vocabulary、special token ID `[0,1,2,3]`、追加4文の完全roundtripを確認した。監査報告は`native/reports/tokenizer-candidate-8k-20260722-1.json`。
- Tokenizer入力はartifact全体をRAMへ読まず、固定chunkでUTF-8 decode、NUL拒否、expected bytes/SHA-256を読みながら再照合する。日本語長行は文字数でなくUTF-8 4,096 bytes以下に分割し、SentencePieceの8,192-byte上限による黙示skipを防ぐ。
- path境界はresolve前にsymlink/junction/reparse ancestryを拒否する。e-Gov parserはUTF-16を含むDTD/entityをExpatで拒否し、fetcherはresponse読取中もglobal deadlineとresponse/total byte残量を確認する。既存datasetは上書き・削除しない。
- Tokenizer workerはreview済み`CorpusInput(path, record_id, bytes, sha256)`だけを受ける。Windowsではpayload送信前に2 GiB Job Objectへ割り当て、venv redirectorとbase interpreterの2 processだけを許可し、job close時に終了する。timeoutは30-300秒、stdout/stderrは各1 MiB。POSIXは`RLIMIT_AS`を使い、制限設定不能時はfail closed。daemon、watcher、自動起動はない。
- `checkpoint_v2.py`を追加。model/AdamW/scheduler/scaler、Python/NumPy/Torch CPU/CUDA RNG、完全なdata cursor、tokenizer/data/code/environment binding、parent manifest hashをsafetensorsとtyped JSONへ保存・復元する。既存Gate A `checkpoint.py`は変更していない。
- `ARCHIVE-MANIFEST.json`はschema 3。通常会話はmanual numeric loopbackのみ、外部通信能力はmanual e-Gov allowlisted HTTPS取得器だけ、verificationはoffline、child processはbounded tokenizer workerだけとしてcomponent別に明示した。
- 最終検証はNative Python 63/63、Node 27/27、compileall成功。24件のlocal artifact、両review ledger、candidateの閉じたfile setとruntime bindingを再検証済み。管理者権限、OS/global Python、認証、課金、network、cloud GPU、外部compute、target-model weight更新は行っていない。workerは終了し、continuity guardも起動していない。

### 次回のGate B再開順序

1. 最新continuity checkpointを検証し、Native 63件とNode 27件を再実行する。
2. 8K candidateと、未生成の16,384/24,576 vocabularyおよびidentity/NFKC normalization候補を、同一のdev/test/compatibility基準で比較する。追加candidate生成は、入力、資源上限、保存先を事前表示して別実行する。
3. tokenizer promotionは比較結果を監査して別決定とし、評価用8K candidateを暗黙にproductionへ使わない。
4. Tokenizer promotion後も、Yuki-Micro永続学習はtoken数、時間、RAM、checkpoint、停止条件を別承認するまで開始しない。

## 11. Daily continuity retry and external scan report（2026-07-23追加）

- `session-archive/continuity/daily-retry.mjs`を追加した。現在の日本日付について、既存checkpointの検証、未作成時の一度だけのcheckpoint作成・検証、セッション無しの記録を30秒上限で行う。guard、server、watcher、schedulerは起動しない。同日再実行は冪等。
- 2026-07-23の初回実行は`checkpoint-created-and-verified`。checkpointは`session-archive/continuity/vault/checkpoints/2026-07-23/2026-07-23T04-18-43-822Z`、manifest SHA-256は`79bed46b7f85853514cac5924ed27e3436c73dde0de01424e095020d2647c7c6`、検証ファイル207件、失敗0。日次結果は`session-archive/continuity/vault/daily-maintenance/2026-07-23.json`。
- VS Codeには手動の`Continuity: daily retry`タスクだけを追加した。日跨ぎにVS Codeも開かれない状態で実行するOSタスクスケジューラ登録は、権限・保持期間・停止条件の明示承認なしには行わない。
- 利用者報告として、前日までのプロジェクトをClaudeで展開しファイルスキャンした。正確な送信ファイル、保持、閲覧範囲は本環境から検証不能。プロジェクト内の`yuki-core/private/`、continuity anchors、raw archiveは機密性のある継続資料として扱い、今後はサニタイズ済みコピーだけを外部スキャンへ渡す。今回の保全処理は外部送信を行っていない。

## 12. Scoped tokenizer candidates（2026-07-29追加）

- 青空文庫前処理候補のcatalog SHA-256
  `76fde78d40e766e24a0f55ffaa2ef865f4dffd442bfe44f28b79ff8bb0f38ff8`
  に含まれるtrain 103件について、利用者は16K・24K tokenizer候補の生成と比較に限り明示承認した。
- 言語モデル学習、production昇格、Colab・外部AIへの送信は承認されていない。
- tokenizer限定承認証跡
  `native/data/approvals/aozora-egov-tokenizer-candidates-v1.approval.json`
  のSHA-256は
  `23755693062f90a644718507d2a9f2fd7263574a11b125aee808c6d45cbf2a6f`。
- 専用validatorとtrainerを追加した。青空文庫catalogは全件
  `trainable: false`のままであり、この承認を言語モデル学習経路から利用できない。
- Native testsは99/99成功。16K生成は開始前の空き物理RAM検査で
  1.066 GiBしかなく、下限4 GiB未満として安全停止した。16K・24K候補、
  staging、一時入力、モデル重み更新、外部送信はいずれも存在しない。

### 次回の再開位置

1. 最新checkpointを完全性検証する。
2. 空き物理RAMを4 GiB以上確保できる場合、承認済み専用trainerで16K、
   続いて24Kの未昇格候補をローカル生成する。
3. ローカルRAMを確保しない場合、Colabへ渡す正確なファイル一覧・hash・
   保持範囲を提示し、外部送信の別承認を得る。
4. 候補比較後の選択・production昇格と、Yuki-Micro言語モデル学習は
   それぞれ別の承認まで実行しない。

## 13. Colab tokenizer bundle（2026-07-30追加）

- ローカル空きRAMは1.946 GiBで下限4 GiB未満だったため、ローカル候補生成は未開始。
- tokenizer限定Colab経路を分離実装した。bundleは公開dataset、承認証跡、
  SentencePiece関連コードだけを含み、モデル定義・モデル学習runner・会話・
  continuity・private資料・認証情報を含まない。
- upload済みv1は実行追跡でbytecode cache問題を発見し、実行対象外。v2は
  package initializerの過剰importを検出したローカル専用版で、未送信。
  両版とも候補を生成していない。v1は証拠として上書き・削除せず残存。
- 有効版はv3。327ファイル、8,616,435 bytes、SHA-256
  `67d49606433c5713bdb70f9cf441e23f1f9fa0d3d2fc617ececc42f8377aefdd`。
  閉包検証、一時展開、runner実起動、実行後閉包再検証に成功。
  Native 103/103、Node 60/60成功。
- v3 bundleのGoogle Drive inbox IDは
  `1ckxea07c1Kdglca7Hl70_5M-UPh7ouS7`。
- `Yuki_Tokenizer_Candidates_v3.ipynb`は7,430 bytes、SHA-256
  `8bf4ba84db7dcb4d79a2f29458f5a761458c1f2724fa7d1daecc97755a26625b`、
  Drive ID `1w1_u-GF4tkHdxZh79cd8HSff8ZWE_qBt`。
- 次はColabでpreflightを実行し、成功後に
  `ALLOW_TOKENIZER_TRAINING = True`へ変更して生成セルを一度だけ実行する。
  16K・24K候補はまだ存在しない。production昇格と言語モデル学習は停止中。

## 14. Yuki-Micro corpus・学習ジョブ設計（2026-07-30追加）

本節は同日以前の「未生成」「未取得」という時点記録を消さず、現在状態だけを
追記する。再開時は本節を優先する。

- Colabで16K・24K tokenizer候補を生成し、ローカルへ返却してhash・語彙・
  roundtripを検証した。共通held-out比較では16Kを実験系列の第一候補とした。
  16K tokenizer model SHA-256は
  `32c2922ab4e08ec17c7d386ba17aa735cd0da9a3f13a96df176b0a4b5708f68d`。
  production昇格はしていない。
- 16K・9,014,528 parameterモデルを青空文庫で200 update診断した。T4上で
  dev loss `9.7457 -> 7.4538`、test loss `9.7371 -> 7.3732`。
  pipelineの学習信号は確認したが、生成は反復的で応答能力を示していない。
  重み、optimizer、checkpointは保存せず破棄した。
- OASST1公式ready archiveをhash固定・一度の取得でローカル抽出した。
  日本語376 message、50 tree。親欠落、role不整合、cross-tree edge、cycleは0。
  最上位応答を各promptから1件選び94 pairとし、通常候補86、手動確認保留8へ
  分けた。
- project ownerは計画SHA-256
  `1275da3f6f19110620c461b45ac279fe8bfcdb7b6b8f8bc1abb61d7719cda49a`
  に対し、通常86 pairだけを将来のcorpusとして適格化した。eligibility ledger
  SHA-256は
  `48ebabcb89f6aa83689ac8d91ff06e1dbd3980b3efe6b78ae57a7486141f92e2`。
  8 pairは保留。学習実行、Colab送信、外部AI送信、production昇格は未承認。
- T4学習ジョブを基礎LMと会話SFTの二段へ分離設計した。機械可読設計は
  `yuki-runtime-lab/native/training/yuki-micro-t4-training-design-v1.json`、
  SHA-256は
  `cb743d737131bc122b59a375f1ca11ae4e38d4a21c483040bc66e39a9db71220`。
  設計承認だけで実行権限は付与していない。
- 独立監査で、青空文庫の現行splitに同一著者が複数splitへ跨る1件を確認した。
  全128件も `trainable: false`、個人情報・権利・内容レビュー未完了。
  著者連結成分と近似重複clusterによる再split、全splitレビュー、16K専用
  nonproduction runnerが基礎学習前の必須ブロッカー。
- SFTはOASST1適格86 pairだけをtree単位でsplitし、assistant tokenだけへlossを
  適用する。保留8 pair、会話ログ、continuity anchor、`yuki-core/private`、
  認証情報は入力にもbundleにも含めない。既存trainerへ直接接続せず、専用
  materializerとgateを先に実装する。
- `docs/EVAL-SUPPLEMENT-16.json`へ政治・行政意見の追加評価文16件を作成した。
  既存44件との正規化完全重複0、内部重複0、数値範囲エラー0。極性配分は
  `3 / 4 / 4 / 3 / 任意2`。
- 最終検証はNative Python 134/134、Node 60/60成功。モデル学習process、
  Colab接続、server、continuity guard、外部agentは稼働していない。

### 次週の再開順序

1. 最新のimmutable checkpointを検証する。
2. 青空文庫を著者連結成分と近似重複cluster単位で再splitし、全split用の
   review ledgerとsplit manifestを作る。元datasetは上書きしない。
3. 16K nonproduction専用runner、checkpoint追加binding、OASST1 SFT
   materializerをローカル実装・検証する。学習はまだ行わない。
4. exact bundle、送信ファイル一覧、hash、保持先、停止条件を提示し、
   青空文庫Colab送信・checkpoint保存・100 update segment実行について
   新しい明示承認を得る。
5. 利用者がbundleを `MyDrive/YukiNativeColab/inbox/` へ配置し、T4で実行する。
   返却checkpointをローカル検証してから次segmentまたはSFTを別判断する。

## 15. 意見ネットワーク2D・3Dプレビュー改修（2026-07-30追加）

- 2D版は `local/chunk-network-preview.html` に維持した。5万件までの表示経路を
  残し、通常確認は1万件、選択ノードの関連線は最大30件とした。一括表示・
  雲状集約の試作は利用者判断で完全に差し戻し、集約前の放射表示へ戻した。
- 3D版は `local/chunk-network-3d-preview.html` に分離した。従来の外側意見球を
  既定表示として保存し、`layout=inside-out` で内外反転した三階層表示を追加した。
- 内外反転モードは「政治」を原点、第三層の意見を内側、24件の第二層トピックを
  中間、6件の第一層大分類を外側へ置く。半径は第三層5.5～27、第二層24～31、
  第一層33～37。第三層の政治からの距離は既存パラメータを維持し、方向だけを
  ランダム60%・主トピック方向40%で合成した。
- 上限を2万件へ拡張した。第三層はThree.jsの `InstancedMesh` を使い、
  `depthWrite: false` と高い透過率で重なりを見せる。第二・第一層も半透明の
  ネオン表示とし、ノード階層を視覚的に区別した。
- 第一層から第二層への24本は常時表示する。第二層から第三層への関係線も
  常時表示するが、opacity 0.008まで抑えた。内外反転モードでは政治から
  第三層への線を常時表示せず、選択時だけ表示する。
- 選択時の関係線は2D版の関連度判定を移植した。同一記述、同一トピック、
  同一大分類、パラメータ近似を用い、第三層では政治・親トピック・関連意見
  最大30件を表示する。第二層では親大分類への1本と、所属する第三層への
  弱い扇状線を表示する。第一層選択では追加線を表示しない。
- 第二・第三層全体は低速で周回し、第三層の各ノードは個別位相・速度・振幅を
  持つ小さな楕円軌道で動く。2万件時は約8.3fpsでinstance matrixと常時関係線の
  端点を同時更新し、選択線は約12.5fpsで追従する。`prefers-reduced-motion`
  では停止し、非表示タブでは更新を休止する。
- `select=topic:0`、`select=category:0`、数値の `select=0` を検証用URL指定として
  利用できる。デスクトップ、モバイル、第二層選択、第三層選択を目視確認した。
  2万件は約3～5.2秒で初期描画し、1.5秒後と4.5秒後の画像比較では標本画素の
  6.59%が変化しており、個別軌道を確認した。
- これらは独立プレビューであり、アプリ本体へはまだ統合していない。再開時は
  `seiseki-project/local` でViteを起動し、
  `chunk-network-3d-preview.html?count=20000&layout=inside-out` を開く。
  終業時にプレビューサーバーは停止する。

### 次回のUI再開位置

1. 最新のimmutable checkpointを検証する。
2. 内外反転3D版を2万件で開き、階層・透過率・個別軌道・選択線を確認する。
3. 既定3D版と2D版を保持したまま、必要なら軌道速度と常時線の濃度だけを調整する。
4. 独立プレビューの評価後に、アプリ本体へ統合するかを別途判断する。

## 16. ChatGPT向け低機密引継ぎパッケージ（2026-07-31追加）

- `transfers/seiseki-chatgpt-handoff-2026-07-31.zip` を作成した。
  サイズは1,362,540 bytes、SHA-256は
  `65b20996e717012b8c06a6123e5d9934c547e52f7c02d6906f99cc36f6667176`。
- ZIPには声析プロジェクト、privateを除くYuki Core、Yuki Runtime Labの
  コード・設計・テスト、指定形式の記憶・文脈エクスポート、
  Codex stdio MCP server設定例を収録した。
- 内部SHA-256一覧313件を再計算し、313/313一致した。ZIP内は322 entry。
- 認証情報、秘密鍵、private anchor、生ログ、continuity vault、取得済みcorpus、
  tokenizer/model artifact、Colab返却物、cache、依存物、外部複製・参照資料は
  含めていない。禁止対象名のZIP内検査は0件。
- `codex mcp-server --help` が現在のローカルCodex CLIで成功することを確認した。
  `codex-mcp-server.json` はMCP対応クライアント向けのstdio設定例であり、
  特定クライアントとのhandshakeは未実行。
- 記憶エクスポートはChatGPTサービス側Memoryの直接取得ではなく、ローカルに
  保存された低機密の規則・技術引継ぎ・公開契約から構成したもの。
- 次回の予定日は2026-08-04。再開時は最新checkpointを検証し、本節と
  `session-archive/continuity/anchors/2026-07-31-chatgpt-handoff.md` を読む。

## 17. 量子もつれノード5,000件プロトタイプ（2026-08-03追加）

- 既存の `local/chunk-network-preview.html` と
  `local/chunk-network-3d-preview.html` は変更していない。新規の独立表示は
  `local/chunk-network-entanglement-preview.html`。
- `local/quantum-entanglement-engine.mjs` に描画非依存の計算を分離した。
  NFKC、大小文字、連続空白、前後空白を正規化し、同一本文を一件へまとめる。
  元件数は `occurrenceCount`、出典は `sourceIds` として保持する。意味的近似は
  第一版の重複条件に含めない。
- 架空入力5,400件のうち400件を意図的な表記差重複とし、表示は固有5,000件。
  72個の局所もつれ群を構築する。seed付き古典相関モードに加えて、Bell型の
  二量子ビット状態を複素振幅とBorn則で数値計算する量子式モードを持つ。
  どちらも実機光子・量子通信・量子ハードウェアではない。
- 原文と切実度・意欲・妥当性は不変。観測ごとの派生投影だけが、中心距離、
  3D方向、一時的な所属トピック、観測関係線を持つ。色関数の入力は算出後の
  中心距離だけで、算出語、所属、観測枝から直接変更しない。
- UIは総合・切実度・意欲・妥当性の観測軸、全体再観測、量子もつれノード単位の
  局所再観測、意見・所属トピック・関係の選択詳細を持つ。5,000意見は
  `InstancedMesh`、関係線は可変 `BufferGeometry` で描画する。
- `tests/quantum-entanglement-engine.test.mjs` は10/10成功。既存 `tests/test.js` は
  54/54成功、`local` の `npm run build` も成功した。5,000件の量子式投影は
  当該環境で約83ms。
- この時点の3実装ファイルは
  `prototypes/quantum-entanglement-2026-08-03/` に固定コピーし、READMEへ
  サイズ、SHA-256、成立した仕様、未実装候補を記録した。
- Vite配信とHTML module proxyの変換はHTTP 200で確認した。今回のセッションでは
  画面検証用ブラウザが0件で、デスクトップ・モバイルのスクリーンショット確認は
  未実施。再開時は次のURLを実ブラウザで確認する。

```text
http://127.0.0.1:4174/chunk-network-entanglement-preview.html?count=5000&seed=prototype-5000
```

### 2026-08-17 量子もつれ観測UI追記
- 観測演算表示は枠・背景・影を廃止し、文字だけのログ表示へ変更した。
- 初期観測、全体再観測、局所再観測、ノード確認の式と代入値を時系列で下へ追記する。表示保持は直近24件。
- 同じ `seed + epoch + basis` の決定性は既存テストで確認済み。古典相関／複素振幅の切替時に同一軸だと再計算されなかった不具合を修正した。
- `node --test tests/quantum-entanglement-engine.test.mjs` は10/10、`local` の `npm run build` は成功。

## 18. Cloudflare Workers + D1本番候補（2026-08-03追加）

- 既存UIやSupabase案から独立した本番候補を `cloudflare/` に新設した。
  Worker入口は `src/index.mjs`、入力検証は `src/validation.mjs`、D1操作は
  `src/db.mjs`、初期schemaは `migrations/0001_initial.sql`。
- APIは `POST /api/responses`、`GET /api/responses/:id`、
  `DELETE /api/responses/:id`、`GET /api/stats`、`GET /api/health`。
  投稿時の解析状態は必ず `pending` とし、クライアント由来の解析結果、ノード、
  関係線は信用せず保存しない。意見量子化、全文評価、「つまり」は後続の独立処理。
- Node内蔵SQLiteへD1互換migrationを適用する試験を含め、入力検証、投稿、参照、
  集計、削除、外部キーのカスケードを7/7成功。2026-08-03のPC再起動後にも
  `node --test cloudflare/tests/validation.test.mjs cloudflare/tests/worker-sqlite.test.mjs`
  を再実行し7/7成功した。
- 2026-08-10、Wrangler OAuthを復旧し、対象をCloudflareアカウント
  `tokyo_odh_129`へ固定した。既存のstaging D1 `seiseki-db-staging`を確認し、
  `wrangler.jsonc`の`env.staging`へ実ID付きで割り当てた。production側の仮IDと
  production Workerには触れていない。
- `0001_initial.sql`をリモートstaging D1へ適用し、`seiseki-api-staging`を
  `https://seiseki-api-staging.tokyo-odh-129.workers.dev`へ初回配備した。
  `GET /api/health`は`ok`。`demoFlag=true`の合成回答1件について投稿、参照、削除を
  実行し、削除後の`responses`件数が0であることを確認した。Turnstile登録、
  production昇格、既存UIからstaging APIへの接続は未実施。
- システムNode/npmによる依存導入はSymantec Service Frameworkの走査と競合したため、
  検証済みWrangler 4.118.0を`C:\tmp\seiseki-wrangler-tools-2`から利用している。
  欠落していた`workerd.exe`と`esbuild.exe`は退避済み実行物から復元し、元の退避物は
  保持した。
- 2026-08-10、Workerへ許可Origin完全一致のCORSを追加し、stagingへ再配備した。
  `core/ui.jsx`へ任意有効化のHTTPS限定Cloudflare APIアダプターを追加し、
  `local/.env.staging`と`dev:staging`で接続する。通常起動は従来のローカル保存のまま。
  初回回答はD1にも`pending`保存し、ローカル回答へ`remoteId`を保持する。撤回時はD1を
  先に削除し、失敗時はローカル回答を残す。追記回答は二重計上を避けるため未同期。
- CORSのpreflight、Origin付き合成回答の投稿・参照・削除に成功し、D1残件数0を確認。
  Worker試験8/8、アプリ試験54/54、連結検査成功。通常・staging Vite buildは成果物を
  生成したが、build完了後にNodeプロセスが終了せずタイムアウトした。画面の目視確認は
  内蔵ブラウザを利用できず未実施。次回は追記schema、リモート集計、認証の順に検討する。

## 19. 概要ナビゲーションとアカウントメニュー（2026-08-04追加）

- `/app`の旧「全体機能」表記を「概要」へ変更した。公開ナビゲーションは
  「回答する」を左端に置き、概要、ダッシュボード、意見ツリー、意見一覧を続ける。
  ダッシュボード・ツリー・一覧の`/app`内状態切替は変更していない。
- 「自分の回答」は公開ナビゲーションから外し、右上の名前先頭文字による
  アカウントメニューへ移した。未ログイン時は同じ位置にログイン導線を表示する。
- 名前とパスワードの変更フォームは、ログイン中の「自分の回答」ページへ統合した。
  現在のパスワードを再確認し、名前変更では保存キーとセッションを移行、
  パスワード変更では新しいsaltとPBKDF2ハッシュを保存する。回答IDの紐付けは維持する。
- クリック可能なツリーマップ、放射ツリー、意見ネットワーク、対象行へ
  ホバー・キーボードフォーカス表示を追加し、Enter/Space選択にも対応した。
- 「回答する」は概要内の主要回答ボタンと同じ緑で常時表示する。概要の
  ツリーマップは抽出意見総数を分母に各トピックの構成比を表示し、小さいセルでは
  ホバー説明に構成比を残す。面積・感情色・遷移は変更していない。
- `node tests/test.js`は54/54、ESM・ルーティング試験は18/18、
  `node tests/balcheck.js app/seiseki.jsx`と`local`の`npm run build`は成功。
  `/`、`/app`、`/survey`、`/account/response`は開発サーバーでHTTP 200。
- 画面操作用ブラウザが接続されていないため、メニューとホバーのスクリーンショット
  確認は未実施。実装はまだ試作保存領域を使い、Cloudflare Worker認証ではない。

## 20. Workers AI正式解析とQueue経路のstaging再確認（2026-08-17追加）

- 受領した`seisekilocalhandoff20260817.zip`のローカルモデルは統合せず、
  `reviews/seisekilocalhandoff20260817/`の監査用コピーとして保留した。
- 現行Workerには、回答をD1へ`pending`保存した後で
  `seiseki-analysis-staging`へ送信し、consumerがD1本文を取得してWorkers AI解析を
  完了する経路が既に実装されていた。Queue送信失敗時だけ`waitUntil`内で直接解析する
  既存退避も維持した。
- stagingの`AI_MAX_ATTEMPTS`を1から2へ変更した。モデルは
  `@cf/qwen/qwen3-30b-a3b-fp8`、出力上限は1,800 tokenのまま。
- `npm run check`、Worker試験31/31、Wrangler dry-runに成功。D1、AI、Queue、
  Static Assetsのbindingを確認した。
- Worker Version `cc003855-cdee-41c2-b928-985b4fe6466a`をstagingへデプロイした。
  架空自由記述1件は`pending -> running -> completed`と遷移し、約12秒で
  `workers-ai-hybrid-v1`、Qwen3 30B、1チャンクの正式解析としてD1へ保存された。
  rules fallbackは発生せず、runの`error_code`はNULLだった。
- 検証回答はAPIで削除した。削除後、`responses`、`analysis_runs`、
  `opinion_chunks`はいずれも対象IDが0件で、D1のカスケード削除を確認した。
- production Worker、production D1、受領ローカルモデル、UI、fallback・再解析仕様は
  変更していない。
