-- PostgreSQL 版のスキーマ。
--
-- 方針: **列名も表名も SQLite 版と同じにする。**
--
--   既存アプリとの互換を最優先する。表を分けて正規化する案もあるが、
--   いま動いている検索・収集・書き出しが全部この形を前提にしており、
--   移行と同時に形を変えると「移行の失敗」と「設計変更の失敗」が
--   区別できなくなる。まず同じ形で移し切り、正規化はその後の別作業にする。
--
-- 型の対応:
--   TEXT              → TEXT
--   INTEGER (真偽)    → SMALLINT  (アプリが = 1 で比べているのでそのまま残す)
--   INTEGER (件数)    → INTEGER
--   INTEGER (金額)    → BIGINT    (年商は 21 億円を超える。int4 では溢れる)
--   REAL              → DOUBLE PRECISION
--   INTEGER PRIMARY KEY (rowid) → BIGINT PRIMARY KEY (SQLite の値をそのまま入れる)
--
-- 全文検索:
--   SQLite の FTS5 は移せない。日本語は語で切れないため tsvector も向かない。
--   pg_trgm の GIN 索引を name_normalized に張り、部分一致で引く。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 法人 (国税庁 法人番号公表サイト)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corporations (
  id                  BIGINT PRIMARY KEY,
  corporate_number    TEXT    NOT NULL UNIQUE,   -- 法人番号 (13桁)
  process_kind        TEXT,
  correction_kind     TEXT,
  update_date         TEXT,
  change_date         TEXT,
  name                TEXT    NOT NULL,
  kind                INTEGER,                   -- 法人種別 101/201/301/401
  pref_name           TEXT,
  city_name           TEXT,
  street_number       TEXT,
  pref_code           TEXT,
  city_code           TEXT,
  post_code           TEXT,
  address_outside     TEXT,
  close_date          TEXT,
  close_cause         TEXT,
  successor_number    TEXT,
  change_cause        TEXT,
  assignment_date     TEXT,
  latest              SMALLINT,
  name_en             TEXT,
  pref_en             TEXT,
  city_en             TEXT,
  address_outside_en  TEXT,
  furigana            TEXT,
  search_excluded     SMALLINT,
  -- 取込時に算出する派生列
  name_normalized     TEXT    NOT NULL,
  name_core           TEXT    NOT NULL,
  corp_form           TEXT,
  address_full        TEXT,
  is_active           SMALLINT NOT NULL,
  source_date         TEXT    NOT NULL,
  ingested_at         TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 法人ごとの付加情報 (収集で埋める)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_profiles (
  corporate_number      TEXT PRIMARY KEY
                             REFERENCES corporations(corporate_number) ON DELETE CASCADE,
  website_url           TEXT,
  website_confidence    DOUBLE PRECISION,
  website_checked_at    TEXT,
  industry_code         TEXT,
  industry_name         TEXT,
  industry_source       TEXT,
  industry_confidence   DOUBLE PRECISION,
  capital               BIGINT,        -- 円
  employees             INTEGER,
  founded_date          TEXT,
  contact_form_url      TEXT,
  contact_email         TEXT,
  contact_tel           TEXT,
  solicitation_refused  SMALLINT NOT NULL DEFAULT 0,
  refused_evidence      TEXT,
  updated_at            TEXT NOT NULL,
  revenue               BIGINT,        -- 円。100 億を超えるので BIGINT
  scale_source          TEXT,
  hiring                SMALLINT,
  hiring_roles          TEXT,
  hiring_new_grad       SMALLINT,
  hiring_mid_career     SMALLINT,
  hiring_checked_at     TEXT,
  representative        TEXT,
  field_sources         TEXT,          -- JSON 文字列 (取得元 URL)
  business_evidence     TEXT,
  social_links          TEXT           -- JSON 文字列
);

-- ---------------------------------------------------------------------------
-- 発見したサイト (収集の作業台でもある)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_hosts (
  host                TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  discovered_at       TEXT NOT NULL,
  crawl_status        TEXT NOT NULL DEFAULT 'pending',
  crawled_at          TEXT,
  http_status         INTEGER,
  error               TEXT,
  site_name           TEXT,
  site_address        TEXT,
  site_tel            TEXT,
  contact_url         TEXT,
  refused_text        TEXT,
  corporate_number    TEXT,
  match_confidence    DOUBLE PRECISION,
  match_method        TEXT,
  site_email          TEXT,
  site_text           TEXT,
  site_representative TEXT,
  field_sources       TEXT,
  social_links        TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 送ってはいけない先 / 送った記録 / 保存した条件 / 取込の履歴
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  corporate_number TEXT PRIMARY KEY,
  reason           TEXT NOT NULL,
  note             TEXT,
  added_by         TEXT,
  added_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id               BIGINT PRIMARY KEY,
  corporate_number TEXT NOT NULL,
  channel          TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  blocked_reason   TEXT,
  campaign         TEXT,
  note             TEXT,
  occurred_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id         BIGINT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  filter     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id            BIGINT PRIMARY KEY,
  source        TEXT NOT NULL,
  target        TEXT NOT NULL,
  source_date   TEXT,
  file_name     TEXT,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS host_discovery_pages (
  source      TEXT NOT NULL,
  collection  TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  page        INTEGER NOT NULL,
  hosts_found INTEGER NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (source, collection, pattern, page)
);

CREATE TABLE IF NOT EXISTS meta_cache (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  payload     TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
