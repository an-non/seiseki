-- ============================================================
-- 声析(SEISEKI)本番スキーマ v1(PostgreSQL 15+ / Supabase)
-- 適用方法: Supabase Studio の SQL Editor に全文貼り付けて実行
--
-- 設計方針:
--   * 専用スキーマ seiseki に隔離(既存DBとの競合回避。
--     Supabase Data API はカスタムスキーマを既定で公開しない)
--   * RLS は「有効化 + ポリシーなし = 既定拒否」。anon / authenticated
--     には権限を一切与えず、サーバー(service_role)経由のみ許可
--   * アプリ側サニタイズ(sanitizeId / sanitizeAnalysis 等)と同じ
--     制約を CHECK で二重化し、DB を最後の防衛線にする
--   * 撤回 = responses の1行 DELETE(answers / opinion_chunks は
--     カスケード削除)。集計はビューで読み時に計算するため、
--     プロトタイプの「集計再構築」は不要
-- ============================================================

create schema if not exists seiseki;

-- ------------------------------------------------------------
-- テーブル
-- ------------------------------------------------------------

-- 回答本体。free(自由記述の原文)は公開APIに載せないこと。
create table if not exists seiseki.responses (
  id              text primary key
                    check (id ~ '^[A-Za-z0-9_-]{4,64}$'),  -- sanitizeId と同一
  ts              timestamptz not null default now(),
  ver             text not null default '' check (char_length(ver) <= 20),
  consent_version text not null check (char_length(consent_version) <= 20),
  consent_ts      timestamptz not null,
  age             text check (age is null or char_length(age) <= 20),
  gender          text check (gender is null or char_length(gender) <= 20),
  region          text check (region is null or char_length(region) <= 20),
  occupation      text check (occupation is null or char_length(occupation) <= 20),
  party           text check (party is null or char_length(party) <= 30),
  free            text not null default '' check (char_length(free) <= 1500),
  analysis        jsonb,                       -- sanitizeAnalysis 済みJSON(null=解析なし)
  ai              boolean not null default false,
  demo_flag       boolean not null default false
);
comment on table seiseki.responses is
  '回答1件。id は撤回のケーパビリティ(本人のみが知る)。削除で子テーブルもカスケード。';

-- 選択式・5段階の回答(縦持ち)。分布・クロス・時系列を GROUP BY で計算する。
create table if not exists seiseki.answers (
  response_id text not null references seiseki.responses(id) on delete cascade,
  qid         text not null check (qid ~ '^[A-Za-z0-9_-]{1,64}$'),
  value       text not null check (char_length(value) between 1 and 60),
  primary key (response_id, qid)
);

-- 意見チャンク(自由記述からAIが抽出)。列挙値は sanitizeAnalysis と同一。
create table if not exists seiseki.opinion_chunks (
  id          bigint generated always as identity primary key,
  response_id text not null references seiseki.responses(id) on delete cascade,
  ts          timestamptz not null,
  s           text not null check (char_length(s) between 1 and 48),
  cat         text not null check (cat in ('提言','不満','要望','評価','事実主張')),
  topic       text not null check (char_length(topic) between 1 and 14),
  tt          text not null check (tt in ('政党','省庁','地方自治体','企業','団体','政府全般','その他')),
  tn          text not null default '' check (char_length(tn) <= 24),
  emo         real not null check (emo between -1 and 1),
  crit        integer not null check (crit between 0 and 100),
  fact        text not null check (fact in ('意見','要検証')),
  demo_flag   boolean not null default false
);

-- 設定(設問・同意文など)。value はサーバーで sanitizeQuestions /
-- sanitizePolicy を通してから保存すること。
create table if not exists seiseki.config (
  key        text primary key check (char_length(key) <= 40),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- レート制限(固定時間窓)。bucket には sha256(IP + ソルト) 等の
-- ハッシュのみを入れ、生IPは保存しない。
create table if not exists seiseki.rate_limits (
  bucket       text not null check (char_length(bucket) <= 120),
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

-- ------------------------------------------------------------
-- JST日付関数とインデックス
-- ------------------------------------------------------------

-- タイムゾーン変換は本来 STABLE だが、Asia/Tokyo は夏時間がなく
-- UTC+9 固定のため、式インデックス用に IMMUTABLE として宣言する。
create or replace function seiseki.jst_day(t timestamptz)
returns date
language sql
immutable
as $$ select (t at time zone 'Asia/Tokyo')::date $$;

create index if not exists responses_ts_idx      on seiseki.responses (ts desc);
create index if not exists responses_jst_day_idx on seiseki.responses (seiseki.jst_day(ts));
create index if not exists answers_qid_value_idx on seiseki.answers (qid, value);
create index if not exists chunks_topic_idx      on seiseki.opinion_chunks (topic);
create index if not exists chunks_target_idx     on seiseki.opinion_chunks (tt, tn);
create index if not exists chunks_ts_idx         on seiseki.opinion_chunks (ts desc);

-- ------------------------------------------------------------
-- 集計ビュー(サーバーAPI /api/stats が参照)
-- ------------------------------------------------------------

-- 設問別の回答分布
create or replace view seiseki.v_distribution as
select a.qid, a.value, count(*)::int as n
from seiseki.answers a
group by a.qid, a.value;

-- 属性クロス集計(長形式: 設問 × 属性フィールド × 属性値 × 回答)
create or replace view seiseki.v_cross as
select a.qid, d.field, d.value as field_value, a.value as answer, count(*)::int as n
from seiseki.answers a
join seiseki.responses r on r.id = a.response_id
cross join lateral (values
  ('age', r.age), ('gender', r.gender), ('region', r.region),
  ('occupation', r.occupation), ('party', r.party)
) as d(field, value)
where d.value is not null
group by a.qid, d.field, d.value, a.value;

-- 選択肢グループ別の平均パラメータ(「支持しない」人の統計 など)
create or replace view seiseki.v_group_params as
select a.qid, a.value,
  count(*)::int as n,
  count(*) filter (where r.analysis is not null)::int as an,
  avg((r.analysis->'params'->'emo'->>'pol')::numeric) filter (where r.analysis is not null) as emo,
  avg((r.analysis->'params'->>'valid')::numeric)      filter (where r.analysis is not null) as valid,
  avg((r.analysis->'params'->>'crit')::numeric)       filter (where r.analysis is not null) as crit,
  avg((r.analysis->'params'->>'motiv')::numeric)      filter (where r.analysis is not null) as motiv
from seiseki.answers a
join seiseki.responses r on r.id = a.response_id
group by a.qid, a.value;

-- 日別(JST)の回答数と平均パラメータ
create or replace view seiseki.v_series as
select seiseki.jst_day(r.ts) as day,
  count(*)::int as n,
  count(*) filter (where r.analysis is not null)::int as an,
  avg((r.analysis->'params'->'emo'->>'pol')::numeric) filter (where r.analysis is not null) as emo,
  avg((r.analysis->'params'->>'valid')::numeric)      filter (where r.analysis is not null) as valid,
  avg((r.analysis->'params'->>'crit')::numeric)       filter (where r.analysis is not null) as crit,
  avg((r.analysis->'params'->>'motiv')::numeric)      filter (where r.analysis is not null) as motiv
from seiseki.responses r
group by 1;

-- 日別(JST)× 設問 × 選択肢(支持構成比の推移などに使用)
create or replace view seiseki.v_series_answers as
select seiseki.jst_day(r.ts) as day, a.qid, a.value, count(*)::int as n
from seiseki.responses r
join seiseki.answers a on a.response_id = r.id
group by 1, 2, 3;

-- トピック統計(似た意見の結合はAIが付与した topic 名で行う)
create or replace view seiseki.v_topics as
select topic, count(*)::int as n, avg(emo) as emo, avg(crit) as crit
from seiseki.opinion_chunks
group by topic;

create or replace view seiseki.v_topic_cats as
select topic, cat, count(*)::int as n
from seiseki.opinion_chunks
group by topic, cat;

-- 「〜に対して」の対象別統計
create or replace view seiseki.v_targets as
select tt, coalesce(nullif(tn, ''), '(対象名なし)') as tn,
  count(*)::int as n, avg(emo) as emo, avg(crit) as crit
from seiseki.opinion_chunks
group by 1, 2;

create or replace view seiseki.v_target_cats as
select tt, coalesce(nullif(tn, ''), '(対象名なし)') as tn, cat, count(*)::int as n
from seiseki.opinion_chunks
group by 1, 2, 3;

-- 回答者属性の内訳
create or replace view seiseki.v_demo as
select d.field, d.value, count(*)::int as n
from seiseki.responses r
cross join lateral (values
  ('age', r.age), ('gender', r.gender), ('region', r.region),
  ('occupation', r.occupation), ('party', r.party)
) as d(field, value)
where d.value is not null
group by 1, 2;

-- 補足: イデオロギー散布(直近400点)と意見一覧(直近120件)は
-- 件数制限つきの通常クエリで取得する(ビュー化しない)。
--   select (analysis->'ideology'->>'econ')::int as e,
--          (analysis->'ideology'->>'soc')::int  as s,
--          コード側で結合した基準設問の回答 as g
--   from seiseki.responses where analysis is not null
--   order by ts desc limit 400;
--   select s, cat, topic, tt, tn, emo, crit, fact, ts, demo_flag
--   from seiseki.opinion_chunks order by ts desc limit 120;

-- ------------------------------------------------------------
-- レート制限関数(固定時間窓・上限超過で false)
-- ------------------------------------------------------------
create or replace function seiseki.hit_rate_limit(
  p_bucket text, p_limit int, p_window_seconds int
) returns boolean
language plpgsql
as $$
declare
  w timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c integer;
begin
  insert into seiseki.rate_limits (bucket, window_start, count)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start)
  do update set count = seiseki.rate_limits.count + 1
  returning count into c;

  -- 古い窓の掃除(約1%の確率で実行し、テーブル肥大を防ぐ)
  if random() < 0.01 then
    delete from seiseki.rate_limits where window_start < now() - interval '2 days';
  end if;

  return c <= p_limit;
end;
$$;

-- ------------------------------------------------------------
-- アクセス制御: RLS有効化(ポリシーなし = 既定拒否)+ 権限剥奪
-- service_role(サーバー)は RLS をバイパスするため影響を受けない。
-- ------------------------------------------------------------
alter table seiseki.responses      enable row level security;
alter table seiseki.answers        enable row level security;
alter table seiseki.opinion_chunks enable row level security;
alter table seiseki.config         enable row level security;
alter table seiseki.rate_limits    enable row level security;

revoke all   on all tables    in schema seiseki from public, anon, authenticated;
revoke all   on all functions in schema seiseki from public, anon, authenticated;
revoke usage on schema seiseki                  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 初期設定の投入(任意)
-- 設問・同意文はサーバー起動時に core/logic.js の既定値
-- (DEFAULT_QUESTIONS / DEFAULT_POLICY)を upsert する運用を推奨。
-- SQLで投入する場合の形:
--   insert into seiseki.config (key, value)
--   values ('questions', '<DEFAULT_QUESTIONSのJSON>'::jsonb),
--          ('policy',    '<DEFAULT_POLICYのJSON>'::jsonb)
--   on conflict (key) do nothing;
-- ------------------------------------------------------------
