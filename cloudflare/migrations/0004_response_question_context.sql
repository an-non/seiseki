PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS response_questions (
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  qid TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('single', 'scale')),
  text TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  left_label TEXT NOT NULL DEFAULT '',
  right_label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (response_id, qid),
  CHECK (position BETWEEN 0 AND 99),
  CHECK (length(qid) BETWEEN 1 AND 64),
  CHECK (length(text) BETWEEN 1 AND 200),
  CHECK (json_valid(options_json)),
  CHECK (length(left_label) <= 80),
  CHECK (length(right_label) <= 80)
);

CREATE INDEX IF NOT EXISTS response_questions_response_position_idx
  ON response_questions(response_id, position);

INSERT OR IGNORE INTO app_config (key, value_json, updated_at) VALUES (
  'questions',
  '[{"id":"q_support","type":"single","text":"現在の政権を支持しますか？","options":["支持する","どちらかといえば支持する","どちらかといえば支持しない","支持しない","わからない"]},{"id":"q_priority","type":"single","text":"いま最も重視する政策分野はどれですか？","options":["経済・雇用","社会保障・医療","子育て・教育","外交・安全保障","環境・エネルギー","行政改革・政治とカネ","その他"]},{"id":"q_econ","type":"scale","text":"経済政策の方向性について、あなたの考えに近いのはどちらですか？","left":"財政支出を拡大し再分配を強化すべき","right":"財政健全化と市場活力を優先すべき","options":["1","2","3","4","5"]},{"id":"q_free","type":"free","text":"政治・行政に対する意見・提言・不満があれば自由にお書きください。","placeholder":"例: ◯◯省の△△制度について…、地元の□□に関して…(任意・複数の話題可)"}]',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
