# SEISEKI 設問構成 2026-08-28

## 採用構成

選択式7件と自由記述1件の合計8件とする。

1. `q_support`: 現在の政権への支持
2. `q_priority`: 最も重視する政策分野
3. `q_econ`: 経済政策の方向性
4. `q_information`: 政策判断に必要な情報の入手状況
5. `q_social`: 個人の自由と社会全体の安全・秩序
6. `q_life`: 日常生活上の課題への政策対応
7. `q_participation`: 政策決定過程への国民意見の反映
8. `q_free`: 政治・行政への自由記述

## 移行規則

- 既存の `q_support`、`q_priority`、`q_econ`、`q_free` のIDと意味は変更しない。
- 新規回答には8件の現行設問を提示する。
- 過去回答は `response_questions` に保存済みの設問スナップショットを使う。
- 過去回答を新しい設問へ自動変換しない。
- `0008_questionnaire_seven_structured.sql` は `app_config.questions` の現行値だけを更新する。
- productionへのmigration適用は、この実装とは別の承認境界とする。

## 変更対象外

- アカウント重複対策
- パスワード再設定
- 自由記述の重複・冷やかし判定
- 過去回答の設問移行
