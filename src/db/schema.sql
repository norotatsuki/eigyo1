-- 営業リスト基盤 スキーマ
--
-- 出典と対応:
--   corporations      … 国税庁 法人番号公表サイト 全件データ (30列) をそのまま保持
--   company_profiles  … 収集・推定で得た付加情報。取込のたびに消えないよう別表にする
--   ingest_runs       … 取込の監査記録
--
-- 列名は国税庁の公表項目に対応させる。独自の番号や接頭辞は付けない。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 法人マスタ (国税庁 法人番号公表サイト = 唯一の正)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corporations (
  id                  INTEGER PRIMARY KEY,          -- FTS 連携用の内部 rowid
  corporate_number    TEXT    NOT NULL UNIQUE,      -- 02 法人番号 (13桁)
  process_kind        TEXT,                         -- 03 処理区分
  correction_kind     TEXT,                         -- 04 訂正区分
  update_date         TEXT,                         -- 05 更新年月日
  change_date         TEXT,                         -- 06 変更年月日
  name                TEXT    NOT NULL,             -- 07 商号又は名称
  kind                INTEGER,                      -- 09 法人種別 (下記の区分値)
  pref_name           TEXT,                         -- 10 国内所在地(都道府県)
  city_name           TEXT,                         -- 11 国内所在地(市区町村)
  street_number       TEXT,                         -- 12 国内所在地(丁目番地等)
  pref_code           TEXT,                         -- 14 都道府県コード
  city_code           TEXT,                         -- 15 市区町村コード
  post_code           TEXT,                         -- 16 郵便番号
  address_outside     TEXT,                         -- 17 国外所在地
  close_date          TEXT,                         -- 19 登記記録の閉鎖等年月日
  close_cause         TEXT,                         -- 20 登記記録の閉鎖等の事由
  successor_number    TEXT,                         -- 21 承継法人等の法人番号
  change_cause        TEXT,                         -- 22 変更事由の詳細
  assignment_date     TEXT,                         -- 23 法人番号指定年月日
  latest              INTEGER,                      -- 24 最新履歴等 (1=最新)
  name_en             TEXT,                         -- 25 商号又は名称(英語表記)
  pref_en             TEXT,                         -- 26 国内所在地(都道府県)英語表記
  city_en             TEXT,                         -- 27 国内所在地(市区町村丁目番地等)英語表記
  address_outside_en  TEXT,                         -- 28 国外所在地(英語表記)
  furigana            TEXT,                         -- 29 フリガナ
  search_excluded     INTEGER,                      -- 30 検索対象除外 (1=除外)

  -- ここから派生列 (取込時に算出)
  name_normalized     TEXT    NOT NULL,             -- 表記ゆれを吸収した商号
  name_core           TEXT    NOT NULL,             -- 法人格を除いた中核名 (名寄せ用)
  corp_form           TEXT,                         -- 法人格 (株式会社/合同会社/…)
  address_full        TEXT,                         -- 都道府県+市区町村+丁目番地等
  is_active           INTEGER NOT NULL,             -- 営業対象になりうるか (下記の判定)
  source_date         TEXT    NOT NULL,             -- データ基準日 (ファイル名の日付)
  ingested_at         TEXT    NOT NULL
);

-- is_active の判定 (取込時に算出):
--   検索対象除外 = 0  かつ  登記記録の閉鎖等年月日が空  かつ  最新履歴等 = 1
-- 法人種別 (kind) の区分値。鳥取県分の実データで法人格と突き合わせて確認済み:
--   101 国の機関 / 201 地方公共団体 /
--   301 株式会社 / 302 有限会社 / 303 合名会社 / 304 合資会社 / 305 合同会社 /
--   399 その他の設立登記法人 (一般社団・医療・学校・NPO など) /
--   401 外国会社等 / 499 その他
-- 営業先の本命は 301-305。法人格そのものは corp_form 列でも絞り込める。

CREATE INDEX IF NOT EXISTS idx_corp_pref      ON corporations(pref_code);
CREATE INDEX IF NOT EXISTS idx_corp_city      ON corporations(pref_code, city_code);
CREATE INDEX IF NOT EXISTS idx_corp_kind      ON corporations(kind);
CREATE INDEX IF NOT EXISTS idx_corp_active    ON corporations(is_active, kind);
CREATE INDEX IF NOT EXISTS idx_corp_namecore  ON corporations(name_core);

-- 「営業対象の、この都道府県を、商号順に」を 1 本でまかなう索引。
-- 画面で一番よく使う形であり、これが無いと
--   件数 … 115 万行それぞれに本体を引きに行く (3.3 秒)
--   一覧 … 115 万行を並べ替えてから先頭 50 件を取る (1.2 秒)
-- になる。この順序なら索引を順になぞって 50 件で打ち切れる。
CREATE INDEX IF NOT EXISTS idx_corp_active_pref_name
  ON corporations(is_active, pref_code, name_core);

-- 都道府県を選んでいないときの「商号順」用。
-- 上の索引だけだと、地域を絞らない一覧で 500 万行の並べ替えに落ちる (実測 23 秒)。
CREATE INDEX IF NOT EXISTS idx_corp_active_name
  ON corporations(is_active, name_core);

-- 「この都道府県の、この法人種別が何件か」を索引だけで数えるため
-- (無いと 68 万行それぞれに本体を引きに行き 6.3 秒かかる)。
--
-- この索引があると最適化器が一覧でもこちらを選び、商号順に並べ直せなくなる。
-- そのため一覧側は INDEXED BY で使う索引を明示している (src/search/query.ts)。
CREATE INDEX IF NOT EXISTS idx_corp_active_pref_kind
  ON corporations(is_active, pref_code, kind);
CREATE INDEX IF NOT EXISTS idx_corp_assigned  ON corporations(assignment_date);
CREATE INDEX IF NOT EXISTS idx_corp_post      ON corporations(post_code);

-- 商号の部分一致検索。日本語は語境界がないため trigram を使う (3文字以上が対象)。
--
-- 索引を張るのは name ではなく name_normalized。
-- 実データの商号には全角英数が多く (「ＡＩシステム開発」「株式会社ＡＢＣ」)、
-- name をそのまま索引すると半角「AI」で検索しても当たらない。
-- 検索語の側も同じ正規化をかけて突き合わせる (src/search/query.ts)。
CREATE VIRTUAL TABLE IF NOT EXISTS corporations_fts USING fts5(
  name_normalized,
  furigana,
  name_en,
  content='corporations',
  content_rowid='id',
  tokenize='trigram'
);

-- ---------------------------------------------------------------------------
-- 企業プロフィール (収集・推定で埋める付加情報)
--   法人マスタを再取込しても消えないよう、意図的に別表に分ける
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_profiles (
  corporate_number      TEXT PRIMARY KEY
                             REFERENCES corporations(corporate_number) ON DELETE CASCADE,

  -- サイト
  website_url           TEXT,
  website_confidence    REAL,           -- 0.0-1.0 商号・住所・電話の一致度から算出
  website_checked_at    TEXT,

  -- 業種 (日本標準産業分類)
  industry_code         TEXT,           -- 例: 391 (ソフトウェア業)
  industry_name         TEXT,
  industry_source       TEXT,           -- gbizinfo / site_classification / manual
  industry_confidence   REAL,

  -- 規模
  capital               INTEGER,        -- 資本金(円)
  employees             INTEGER,        -- 従業員数
  founded_date          TEXT,

  -- 接触経路
  contact_form_url      TEXT,
  contact_email         TEXT,
  contact_tel           TEXT,

  -- 送信前ゲートが参照する判定 (収集時に検出)
  solicitation_refused  INTEGER NOT NULL DEFAULT 0,  -- 1 = 営業お断りの表示を検出
  refused_evidence      TEXT,                        -- 検出した文言と URL

  updated_at            TEXT NOT NULL
);

-- 業種で絞るときは確信度も必ず併用するため、まとめて索引にする
CREATE INDEX IF NOT EXISTS idx_prof_industry ON company_profiles(industry_code, industry_confidence);
CREATE INDEX IF NOT EXISTS idx_prof_capital  ON company_profiles(capital);
CREATE INDEX IF NOT EXISTS idx_prof_emp      ON company_profiles(employees);
CREATE INDEX IF NOT EXISTS idx_prof_site     ON company_profiles(website_url);
CREATE INDEX IF NOT EXISTS idx_prof_refused  ON company_profiles(solicitation_refused);

-- ---------------------------------------------------------------------------
-- 取込の監査記録
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,     -- nta_zenken / nta_sabun / gbizinfo
  target        TEXT NOT NULL,     -- 00_zenkoku / 31_tottori など
  source_date   TEXT,              -- データ基準日
  file_name     TEXT,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,     -- running / ok / failed
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_source ON ingest_runs(source, started_at);

-- ---------------------------------------------------------------------------
-- 集計結果の控え
--   画面の選択肢 (都道府県・業種・法人種別の件数) は 500 万行の集計になり、
--   毎回作ると 46 秒かかる。中身が変わっていなければ作り直さない。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,   -- 基準日と件数から作る。変わっていたら作り直す
  payload     TEXT NOT NULL,   -- JSON
  computed_at TEXT NOT NULL
);
