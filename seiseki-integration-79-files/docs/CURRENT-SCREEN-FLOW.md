# 現行画面遷移図

作成日: 2026-08-04  
対象: 声析(SEISEKI) v0.15.2 現行プロトタイプ

この資料は将来構想ではなく、`core/ui.jsx` と独立プレビューの現在の挙動を記録する。

図形版: [ページ分離後の画面遷移図](./PAGE-ROUTE-MAP.svg)

## 1. 全体画面

```mermaid
flowchart TD
    LOAD["ブラウザで / を開く"] --> INIT["設定・集計・下書き・セッションを読込"]
    INIT --> ENTRY["入口 /"]

    ENTRY --> AUTH["登録 / ログイン"]
    ENTRY -->|"登録せず閲覧"| HOME["概要 /app"]
    AUTH --> HOME

    HOME --> SURVEY["回答 /survey"]
    HOME --> DASH["ダッシュボード /app内"]
    HOME --> TREE["意見ネットワーク /app内"]
    HOME --> MINE["自分の回答 /account/response"]
    NAV["共通ナビゲーション"] --> SURVEY
    NAV --> HOME
    NAV --> DASH
    NAV --> TREE
    NAV --> OPINIONS["意見一覧 /app内"]
    ACCOUNT["右上アカウントメニュー"] --> MINE

    TREE -->|"トピック・対象・ノードを選択\n絞り込み条件を引き渡す"| OPINIONS
    OPINIONS -->|"ツリーへ戻る"| TREE
    SURVEY -->|"回答完了後"| COMPLETE["完了 /survey/complete"]
    COMPLETE --> DASH
    COMPLETE --> SURVEY
    MINE -->|"撤回完了後"| HOME
    MINE --> DASH

    DIRECT["直接URLのみ"] --> ADMIN["管理 /admin"]
    ADMIN -. "デモ投入・集計再構築の結果が反映" .-> DASH
    ADMIN -. "データ生成・再構築の結果が反映" .-> TREE
```

### 現在の遷移方式

- 外部ルーターは追加せず、History APIとReactのviewを同期している。
- 入口、概要、回答、完了、自分の回答、AdminにURLがある。
- 共通ナビゲーションは回答を左端、概要をその次に置く。右上のアカウントメニューから「自分の回答」へ進み、同じページ内で名前・パスワードを変更する。
- ダッシュボード、意見ネットワーク、意見一覧、各ビジュアルは /app 内の表示状態だけを切り替え、ブラウザ履歴へ追加しない。
- 回答途中の入力は従来どおり個人スコープの下書きから復元する。
- 完了画面の再読込では、最後の回答IDから保存済み回答を読み直す。
- 未知のURLは入口 / として扱う。

## 2. 回答フロー

```mermaid
flowchart TD
    ENTRY["回答する"] --> AUTH{"ログイン済み?"}
    AUTH -->|"いいえ"| AUTHGATE["登録 / ログイン"]
    AUTHGATE -->|"認証成功"| STATUS{"回答履歴"}
    AUTH -->|"はい"| STATUS

    STATUS -->|"未回答"| CONSENT["同意文確認"]
    STATUS -->|"初回答済み"| ADDENDUM["自由記述の追記"]
    STATUS -->|"2回答済み"| LIMIT["回答上限表示"]

    CONSENT -->|"同意"| ATTR["回答者属性"]
    CONSENT -->|"同意しない"| HOME["ホーム"]
    ATTR --> QUESTIONS["設問 Q1...Qn"]
    ADDENDUM --> QUESTIONS
    QUESTIONS --> ANALYZE["端末内解析"]
    ANALYZE -->|"成功"| COMPLETE["完了・回答ID・解析結果"]
    ANALYZE -->|"失敗"| RETRY["エラー・再試行"]
    RETRY --> ANALYZE
    COMPLETE --> DASH["ダッシュボード"]
    COMPLETE -->|"回答ページへ戻る"| CONSENT

    DRAFT["個人スコープの下書き"] -. "1秒デバウンス保存 / 再訪時復元" .-> CONSENT
    DRAFT -.-> ATTR
    DRAFT -.-> QUESTIONS
```

## 3. 自分の回答

```mermaid
flowchart TD
    ENTRY["自分の回答"] --> SESSION{"ログイン中?"}
    SESSION -->|"はい"| ACCOUNT["アカウントに紐づく回答IDを取得"]
    SESSION -->|"いいえ"| INPUT["回答ID入力"]
    ACCOUNT --> LOOKUP["回答を照会"]
    INPUT --> LOOKUP
    LOOKUP -->|"見つからない"| INPUT
    LOOKUP -->|"見つかる"| VIEW["回答・分析・追記を表示"]
    VIEW --> CONFIRM["撤回確認"]
    CONFIRM -->|"やめる"| VIEW
    CONFIRM -->|"撤回"| DELETE["回答削除・集計再構築"]
    DELETE --> DONE["撤回完了"]
    DONE --> HOME["ホーム"]
```

## 4. 管理画面

```mermaid
flowchart TD
    ENTRY["/admin へ直接アクセス"] --> LOCK["共有ストレージ上の合言葉で簡易解錠"]
    LOCK --> ADMIN["管理画面"]

    ADMIN --> DATA["回答データ操作"]
    DATA --> DEMO["デモ投入 / 削除"]
    DATA --> REBUILD["集計再構築 / 旧解析補完"]
    DATA --> IMPORT["回答JSONインポート"]
    DATA --> EXPORT["全件JSONエクスポート"]
    DATA --> DELETE["回答ID指定削除 / 全回答削除"]

    ADMIN --> QUESTIONS["設問編集"]
    ADMIN --> POLICY["同意文編集"]
    ADMIN --> PASSWORD["管理用合言葉変更"]

    STORE[("共有ストレージ")]
    DEMO --> STORE
    REBUILD --> STORE
    IMPORT --> STORE
    DELETE --> STORE
    QUESTIONS --> STORE
    POLICY --> STORE
    PASSWORD --> STORE
    STORE --> EXPORT
```

管理画面は一般ナビゲーションと一般画面内の導線から除外した。ただし現行の合言葉は画面上の簡易ロックであり、サーバー側認証・権限分離ではない。現在は一般画面と同じバンドル、同じ実行環境、同じ共有ストレージを使用する。本番では別ビルド化または非搭載とし、Worker側の管理者認可を必須にする。

## 5. 独立プレビュー

```mermaid
flowchart LR
    MAIN["現行SEISEKI本体"]
    TWO_D["chunk-network-preview.html\n2D意見ネットワーク"]
    THREE_D["chunk-network-3d-preview.html\n3D階層ネットワーク"]
    QUANTUM["chunk-network-entanglement-preview.html\n量子もつれ観測"]

    MAIN -. "本体UIからの正式な遷移なし" .-> TWO_D
    MAIN -. "本体UIからの正式な遷移なし" .-> THREE_D
    MAIN -. "本体UIからの正式な遷移なし" .-> QUANTUM
```

- 3画面はいずれも`local/`配下の独立HTMLで、本体の`view`状態には含まれない。
- 量子もつれ画面はクエリ文字列の`count`と`seed`を受け取るが、本体の回答DBを直接参照する正式経路はまだない。
- 現在は開発用プレビューであり、本番画面遷移・認証・認可の対象外である。

## 6. 現行仕様から確認できる課題

1. Adminは一般導線から隔離したが、まだ同じバンドルとストレージ境界にある。
2. Adminの解錠はクライアント側の簡易合言葉で、セキュリティ境界ではない。
3. 本番サーバーでは /survey/* 等をSPAのindex.htmlへ戻すフォールバック設定が必要である。
4. 独立プレビューと本体の間に、認証済みのデータ受け渡し経路がない。
5. 量子観測結果をDBへ保存するか、再計算のみとするかは未確定である。
