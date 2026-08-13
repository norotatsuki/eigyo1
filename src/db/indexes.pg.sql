-- 索引は **データを入れ終えてから** 作る。
--
-- 先に張ると 581 万行の投入のたびに索引を更新することになり、何倍も遅くなる。
-- 入れ終えてから作れば、まとめて 1 回で済む。
--
-- 中身は SQLite 版と同じ考え方。加えて PostgreSQL でしかできない形を 2 つ使う:
--   ・部分索引 (WHERE 付き) … 「メールがある先」だけを並べた小さな索引
--   ・GIN + pg_trgm       … 商号の部分一致 (SQLite の FTS5 の代わり)
--
-- 索引を増やすほど投入と更新は遅くなる。ここに並べたものは、実際に画面が
-- 投げる条件に対応したものだけに絞ってある。

-- ── 法人 ────────────────────────────────────────────────────────────
-- 「活動中」は既定で必ず付くため、複合索引の先頭に置く
CREATE INDEX IF NOT EXISTS idx_corp_active          ON corporations(is_active, kind);
CREATE INDEX IF NOT EXISTS idx_corp_active_name     ON corporations(is_active, name_core);
CREATE INDEX IF NOT EXISTS idx_corp_active_pref_kind ON corporations(is_active, pref_code, kind);
CREATE INDEX IF NOT EXISTS idx_corp_active_pref_name ON corporations(is_active, pref_code, name_core);
CREATE INDEX IF NOT EXISTS idx_corp_pref            ON corporations(pref_code);
-- 市区町村は県と組でしか意味を持たない (コードが県ごとに振り直されているため)
CREATE INDEX IF NOT EXISTS idx_corp_city            ON corporations(pref_code, city_code);
CREATE INDEX IF NOT EXISTS idx_corp_kind            ON corporations(kind);
CREATE INDEX IF NOT EXISTS idx_corp_namecore        ON corporations(name_core);
CREATE INDEX IF NOT EXISTS idx_corp_post            ON corporations(post_code);
CREATE INDEX IF NOT EXISTS idx_corp_assigned        ON corporations(assignment_date);

-- 商号の部分一致。SQLite の FTS5 の代わり。
-- 日本語は空白で語に切れないため、3 文字ずつの断片 (trigram) で引く
CREATE INDEX IF NOT EXISTS idx_corp_name_trgm
  ON corporations USING gin (name_normalized gin_trgm_ops);

-- ── 付加情報 ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_prof_industry ON company_profiles(industry_code, industry_confidence);
CREATE INDEX IF NOT EXISTS idx_prof_capital  ON company_profiles(capital);
CREATE INDEX IF NOT EXISTS idx_prof_emp      ON company_profiles(employees);
CREATE INDEX IF NOT EXISTS idx_prof_revenue  ON company_profiles(revenue);
CREATE INDEX IF NOT EXISTS idx_prof_site     ON company_profiles(website_url);
CREATE INDEX IF NOT EXISTS idx_prof_refused  ON company_profiles(solicitation_refused);
CREATE INDEX IF NOT EXISTS idx_prof_hiring   ON company_profiles(hiring);

-- 「〜がある先」だけを法人番号順に並べた小さな索引。
-- 一覧はこれを順に読んで、必要な件数で打ち切れる。
-- SQLite 側の実測では、この形があるかどうかで 1.37 秒と 0.06 秒の差になった。
CREATE INDEX IF NOT EXISTS idx_prof_reachable ON company_profiles(corporate_number)
  WHERE contact_email IS NOT NULL OR contact_form_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prof_email_cn  ON company_profiles(corporate_number)
  WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prof_form_cn   ON company_profiles(corporate_number)
  WHERE contact_form_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prof_site_cn   ON company_profiles(corporate_number)
  WHERE website_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prof_repr_cn   ON company_profiles(corporate_number)
  WHERE representative IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prof_social_cn ON company_profiles(corporate_number)
  WHERE social_links IS NOT NULL;

-- ── サイト ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_hosts_corp   ON web_hosts(corporate_number);
CREATE INDEX IF NOT EXISTS idx_hosts_status ON web_hosts(crawl_status);
-- 収集は「まだ訪ねていない先」を延々と引く。そこだけの索引を持たせる
CREATE INDEX IF NOT EXISTS idx_hosts_pending ON web_hosts(host)
  WHERE crawl_status = 'pending';

-- ── 送付まわり ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_suppress_reason  ON suppressions(reason);
CREATE INDEX IF NOT EXISTS idx_outreach_corp    ON outreach_log(corporate_number, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outreach_channel ON outreach_log(channel, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outreach_camp    ON outreach_log(campaign);
CREATE INDEX IF NOT EXISTS idx_outreach_sent
  ON outreach_log(corporate_number, channel, occurred_at) WHERE outcome = 'sent';
CREATE INDEX IF NOT EXISTS idx_runs_source      ON ingest_runs(source, started_at);
