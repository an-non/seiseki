INSERT INTO app_config (key, value_json, updated_at)
VALUES (
  'questions',
  '[{"id":"q_support","type":"single","text":"現在の政権を支持しますか？","options":["支持する","どちらかといえば支持する","どちらかといえば支持しない","支持しない","わからない"]},{"id":"q_priority","type":"single","text":"いま最も重視する政策分野はどれですか？","options":["経済・雇用","社会保障・医療","子育て・教育","外交・安全保障","環境・エネルギー","行政改革・政治とカネ","その他"]},{"id":"q_econ","type":"scale","text":"経済政策の方向性について、あなたの考えに近いのはどちらですか？","left":"財政支出を拡大し再分配を強化すべき","right":"財政健全化と市場活力を優先すべき","options":["1","2","3","4","5"]},{"id":"q_information","type":"single","text":"政策や制度について判断するために必要な情報を、十分に得られていると思いますか？","options":["十分に得られている","どちらかといえば得られている","どちらかといえば不足している","不足している","わからない"]},{"id":"q_social","type":"scale","text":"公共政策で価値が衝突するとき、あなたの考えに近いのはどちらですか？","left":"個人の選択と自由を優先すべき","right":"社会全体の安全と秩序を優先すべき","options":["1","2","3","4","5"]},{"id":"q_life","type":"single","text":"現在の制度や政策は、あなたが日常生活で感じる課題に対応していると思いますか？","options":["対応している","どちらかといえば対応している","どちらかといえば対応していない","対応していない","わからない"]},{"id":"q_participation","type":"single","text":"政策の決定過程に、国民の意見が十分に反映されていると思いますか？","options":["十分に反映されている","どちらかといえば反映されている","どちらかといえば反映されていない","反映されていない","わからない"]},{"id":"q_free","type":"free","text":"政治・行政に対する意見・提言・不満があれば自由にお書きください。","placeholder":"例: ◯◯省の△△制度について…、地元の□□に関して…(任意・複数の話題可)"}]',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT(key) DO UPDATE SET
  value_json = excluded.value_json,
  updated_at = excluded.updated_at;
