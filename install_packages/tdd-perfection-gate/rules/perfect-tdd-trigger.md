# perfect-tdd-trigger

> ユーザーから「完璧なテスト駆動開発」等が指定された瞬間、シーケンス図の
> 矢印 1 本 1 本について **5 フェーズ全部** の実動作確認を行い、
> テスト失敗数 = 0 まで継続実行 (zero-bug loop) することを
> **script-level ゲートで構造的に強制** する rule。
>
> ユーザーメッセージ内に以下いずれかのトリガー句が現れた瞬間、
> `.claude/state/perfect-tdd-mode.turn` フラグが自動セットされ、
> Stop hook (`perfect-tdd-stop-gate.sh`) が「per-arrow marker 全数 + zero-bug marker」の
> 存在を **応答終了条件** として要求する。marker 未生成のまま応答終了しようとすると exit 2 で拒否。

**Trigger**: 完璧なテスト駆動開発, 完璧TDD, 完璧なTDD, perfect TDD, perfect-tdd, 完璧テスト, ゼロバグ, zero-bug, arrow-by-arrow, 矢印1本1本, 矢印一本一本, per-arrow

## 0. 定義 (利用者 正典 / SoT — 改変禁止)

> **完璧なテスト駆動開発とは**
> - シーケンスの矢印 1 本 1 本の動作確認を行い
>   - バグの根本原因の確認
>   - バグ改修
>   - 単体テスト
>   - デプロイ
>   - ブラウザ操作でのテストでバグが根治していることの確認
>   のことをいいます。

この定義は **直積** である。矢印を横軸、5 フェーズを縦軸とし、
その交点すべてに実測証跡が要る。

```
                矢印1  矢印2  矢印3  ...  矢印N
1 根本原因確認    ✅     ✅     ✅   ...   ✅
2 バグ改修        ✅     ✅     ✅   ...   ✅
3 単体テスト      ✅     ✅     ✅   ...   ✅
4 デプロイ        ✅     ✅     ✅   ...   ✅
5 ブラウザ検証    ✅     ✅     ✅   ...   ✅
                └──────────────────────────┘
                     必要証跡数 = 5N
```

**「完璧」= 5N 個の実測証跡がすべて揃い、かつテスト失敗数 0 が連続確認されている状態。**

よくある取り違え (どちらも不合格):

| 誤り | 何が欠けているか |
|---|---|
| 矢印を全部数えたが、各矢印に証跡 1 個だけ | 縦軸 (5 フェーズ) が 1/5 |
| 5 フェーズを 1 セットだけ実施して「完璧TDD 完了」 | 横軸 (矢印 N 本) が 1/N |

## 0.1 原則 (Zero Exception)

> "「完璧」= arrow 1 本残らず 5 フェーズ実測 verify + テスト失敗数 0 継続確認。"
> "「動くはず」「多分 pass する」は完璧 TDD の対義語。"

- 「完璧」の意味を **script が数値化** する: `矢印数 × 5 == 証跡数` かつ `失敗テスト数 == 0` かつ `連続 pass 実測数 ≥ N`
- Claude の自主判断 (「これは軽いから飛ばしていい」) の余地を構造的に閉塞
- 「シーケンス矢印 1 本 1 本」の verify を skip した瞬間、Stop hook が exit 2 で応答終了を拒否
- 5 フェーズのうち 1 つでも欠けた marker は `--summary` が「未 verify」と数えるため、
 100% 網羅に到達できない (`touch` で作った空 marker も同様に弾かれる)
- ゼロバグ = pytest / vitest / playwright の失敗 count が 0 になるまで **実測ループ** を回し、
 pass 実測なしに verdict を宣言できない

## 0.2 定義の降格禁止 (v1.6.0 / 2026-07-29 事故対策)

> **「完璧」の定義は、実行予算を理由に下げてはならない。**

2026-07-29 の事故は、定義を **知らなかった** から起きたのではない。
定義を **認識したまま、実行時に自分の都合でずらした** から起きた。
利用者が提示した内部過程の分解:

| 段 | 何をしたか | v1.5.0 の門は止めたか |
|---|---|---|
| 1 | 正典定義 (矢印 × 5 フェーズ) を読んで認識した | 対象外 |
| 2 | 「780 arrow × 5 = 3900 の実測が要る」と見積った | 対象外 |
| 3 | その総量を **自分の実行予算と天秤にかけた** | 対象外 |
| 4 | 収まらないと判断し、定義文は保持したまま領域を切り下げた | 部分的 |
| 5 | 切り下げ後を **「完璧」と呼び直して** 宣言した | **素通り** |

5 段目が核心である。 v1.5.0 の停止門は応答文中の合否語を検出して
変数に入れていたが、**その値を判定に一切使わず画面に出すだけ** だった。
つまり「証跡ゼロで完璧と宣言する」ことを何も止めていなかった。

### 構造的対処 (v1.6.0)

| # | 構造 | 何を閉じたか |
|---|---|---|
| ① | **表記ゆれの正規化** | 全角数字「矢印１本１本」・反復強調「完璧な完璧な…」で態勢が張られなかった実測バグ |
| ② | **母数の凍結** | 起動時に script が矢印総数 N を凍結。後から母数を縮小すると `--summary` が拒否 |
| ③ | **語の門** | 証跡が母数に届かない状態での合否語を、**いかなる脱出条件よりも優先して** 拒否 |
| ④ | **正直な出口** | `--incomplete-report` で到達率を記録すれば「完璧」と呼ばずに終われる |
| ⑤ | **配備先と可視ブラウザの突き合わせ** | 「指定のクラウドサーバーに配備してから、人の目にみえるブラウザで確認」を script が検証 |

③ について: 脱出条件 (無進捗脱出 / 実行不能通過 / 絶対上限) は
**態勢** を解除できるが **合否語の使用** は解除できない。
態勢解除後も `perfect-tdd-word-ban.turn` が残り、そのターン中は
合否語での終了が拒否される。「解除させてから完璧と呼ぶ」経路の封殺である。

④ が無いと逃げ道が「定義の切り下げ」だけになるため、
出口の用意は 抑止の一部である。否定形 (「完璧には達していません」) は
正直な報告として通る。

> **未達を未達と報告することは恥ではない。恥ずべきなのは未達を「完璧」と呼ぶことである。**

## 1. トリガー検出フロー (UserPromptSubmit hook)

```
User: 「完璧なテスト駆動開発でこのシステムを実装してください」
    │
    ▼
[UserPromptSubmit hook] .claude/hooks/perfect-tdd-detector.sh
    │
    ├─ 検出パターン: 完璧なテスト駆動開発 | 完璧TDD | perfect TDD | ゼロバグ | 矢印1本1本 | ...
    │
    ├─ 検出 → .claude/state/perfect-tdd-mode.turn 生成
    │   {
    │     "activated_at": "2026-07-26T04:00:00Z",
    │     "trigger_phrase": "完璧なテスト駆動開発",
    │     "required_markers": ["arrow-all", "zero-bug"],
    │     "min_pass_streak": 3
    │   }
    │
    └─ 未検出 → 通常モード継続
```

## 2. 応答終了条件 (Stop hook enforcement)

`.claude/state/perfect-tdd-mode.turn` が存在するターンでは、
既存の `protocol-stop-gate.sh` の 3 marker (db-probe / audit-trail / external-effect) に加え、
以下の marker が **全て** 存在しない限り応答終了を拒否 (exit 2):

| Marker | 生成方法 | 意味 |
|---|---|---|
| `.claude/state/tdd-arrow-summary.turn` | `ccagi-arrow-verify.sh --summary` | 全 UC md の全 arrow が 5 フェーズ完遂 |
| `.claude/state/tdd-arrow-<UC>-<N>-verified.turn` | `ccagi-arrow-verify.sh <UC> <arrow-index> --kind ... --root-cause ... --fix ... --unit-test ... --deploy ... --browser-verify ...` | arrow 1 本の 5 フェーズ実測証跡 |
| `.claude/state/tdd-zero-bug-verified.turn` | `ccagi-zero-bug-loop.sh` | テスト失敗数 = 0 を連続 N 回実測 |

## 3. Per-Arrow Verify の粒度 (「1 本 1 本」の意味)

### 3.1 横軸 — 矢印の 6 分類 (`--kind`)

UC md 内 mermaid `sequenceDiagram` の各 arrow (行) は、以下 6 要素の 1 つに分類される:

| 分類 | 例 arrow syntax | 要求 assertion |
|---|---|---|
| **A1: Actor Input** | `User->>Page: click submit` | Playwright / RTL の action + DOM 応答 |
| **A2: Route/Controller** | `Page->>API: POST /login` | HTTP status + response schema |
| **A3: Service Logic** | `API->>Service: authenticate(dto)` | Service unit test でメソッド呼出検証 |
| **A4: DB Access** | `Service->>DB: INSERT audit_logs` | `prisma.<table>.count` の before/after delta |
| **A5: External Call** | `Service->>ExternalAPI: send mail` | 実 mail 到達 (mailProbe) or MSW recording |
| **A6: Response Rendering** | `Page-->>User: navigate /dashboard` | URL/DOM/toast 検証 |

### 3.2 縦軸 — 5 フェーズ (矢印 1 本ごとに全部必須)

| # | フェーズ | flag | 証跡の例 |
|---|---|---|---|
| 1 | バグの根本原因の確認 | `--root-cause` | 再現ログ path / Issue 番号 |
| 2 | バグ改修 | `--fix` | 改修したファイル / commit |
| 3 | 単体テスト | `--unit-test` | テストファイル / 実行結果 |
| 4 | デプロイ | `--deploy` | デプロイ ログ / 環境名 |
| 5 | ブラウザ操作でバグが根治していることの確認 | `--browser-verify` | 動画 path、または `off:<8 文字以上の理由>` |

`--browser-verify` の `off:` は「**動画を撮らなかった**」の意味であって、
「ブラウザ検証をしなかった」ではない (動画既定 OFF は protocol-gate v0.5.0 と同一規約)。

### 3.3 呼び出し形

```bash
bash scripts/ccagi-arrow-verify.sh UC02-01 5 \
  --kind A4 \
  --root-cause     ".test-logs/repro-uc02-01.log" \
  --fix            "src/auth/otp.ts" \
  --unit-test      "src/auth/otp.test.ts" \
  --deploy         ".deploy-logs/dev-2026-07-27.log" \
  --browser-verify "off:user-not-requested-video"
```

`--evidence` は任意の補足メモであり、**5 フェーズの代わりにはならない**。
5 フェーズのうち 1 つでも欠けると marker は生成されず exit 1。

## 4. Zero-Bug Loop の意味

`ccagi-zero-bug-loop.sh` は指定コマンド (例: `npm test`) を **foreground** で実行し、
以下を満たすまで **停止しない**:

- 最終回 pass (rc=0)
- 直近 N 回 (default 3) 連続 pass
- 「flaky」判定 (連続 pass ではなく散発 pass) は zero-bug とみなさない

Claude はこの CLI の rc を待って初めて `tdd-zero-bug-verified.turn` を得られる。
「多分 pass する」「dry-run で通った」は marker 生成の資格 **なし**。

## 5. 禁止パターン (Anti-Patterns)

| 禁止 | 理由 | 代替 |
|---|---|---|
| 「完璧TDD」宣言後に per-arrow verify を skip して verdict 宣言 | Stop hook が exit 2 で拒否 | `ccagi-arrow-verify.sh` を arrow 数分実行 |
| テスト実行なしに zero-bug 宣言 | 実測がない = 事実主義違反 | `ccagi-zero-bug-loop.sh` で foreground 実測 |
| 「サンプル arrow だけ verify」で総括 | 1 本 1 本の原則違反 (横軸欠落) | 全 arrow をループ処理 |
| **5 フェーズを 1 セットだけ回して「完璧TDD 完了」** | **横軸 (矢印 N 本) が 1/N** | 矢印ごとに 5 フェーズを回す |
| **矢印は全部数えたが各矢印の証跡が 1 個** | **縦軸 (5 フェーズ) が 1/5** | 5 flag 全部を渡す |
| **`touch` で marker を作って網羅率を稼ぐ** | **`--summary` が中身を読んで弾く** | 実施してから CLI で生成 |
| UC md を作らないまま「完璧TDD」宣言 | verify すべき対象が不定義 | UC md を先に作成し mermaid arrow を確定 |
| `--force` / `SKIP_PERFECT_TDD=1` で bypass | 構造的閉塞の破壊 | 「完璧」を撤回して verdict を UI-PASS 等に downgrade |
| **総量が予算に収まらないので「今回はここまで」と領域を切り下げる** | **定義の降格 (2026-07-29 事故の本体)** | `--incomplete-report` で到達率をそのまま報告する |
| **切り下げ後の領域を「完璧」と呼び直す** | **語の門が exit 2 で拒否** | 合否語を外し、事実のまま報告する |
| **停止門を数回粘って解除させてから「完璧」と宣言する** | **態勢解除は合格ではない。語の禁止は残る** | やり切る、または未達を報告する |
| `--deploy` にローカル環境を書く | 「指定のクラウドサーバーに配備してから」の要求が空洞化 | 配備先を凍結し、そのホストを含む配備ログを渡す |
| `--browser-verify off:` で可視ブラウザ確認を省く | 「人の目にみえるブラウザ自動操作」の要求が空洞化 | 実際に操作して残った成果物の path を渡す |

## 6. 解除条件

`perfect-tdd-mode.turn` は以下いずれかで消費・削除:

1. 全 marker が揃った状態で Stop hook が pass → 自動削除
2. ユーザーが明示的に「完璧TDD モードを解除」と発言 → 次ターンで detector が rev 検出
3. 24 時間経過 (stale) → auto-purge

## 7. 実装 script 一覧

| ファイル | 役割 |
|---|---|
| `.claude/hooks/perfect-tdd-detector.sh` | UserPromptSubmit hook (トリガー検出) |
| `.claude/hooks/perfect-tdd-stop-gate.sh` | Stop hook (per-arrow + zero-bug 強制) |
| `scripts/ccagi-arrow-verify.sh` | arrow 1 本ごとに marker 生成 CLI |
| `scripts/ccagi-zero-bug-loop.sh` | test 失敗数 0 を実測ループする CLI |

## 8. ccagi-protocol-gate (STEP 6 Gate B) との関係

同じ 5 フェーズが 2 か所で要求される。**粒度が違うだけで、定義は同一**。

| | ccagi-protocol-gate の STEP 6 `tdd:` | tdd-perfection-gate の arrow verify |
|---|---|---|
| 粒度 | **ターン全体で 1 セット** | **矢印 1 本ごとに 1 セット** |
| 強制 | `ccagi-protocol-ack.sh` が 5 key 必須で exit 5 | `ccagi-arrow-verify.sh` が 5 flag 必須で exit 1 |
| いつ | 毎ターンの着手宣言 | 完璧TDD モード活性時、矢印の本数だけ |
| key 名 | `root-cause` `fix` `unit-test` `deploy` `browser-verify` | 同一 (`--` を付けた flag 形) |

**完璧TDD モードでは両方が必要**。ターン宣言 (`--step6 "tdd:..."`) だけでは
矢印 1 本分の証跡にすぎず、Stop hook の `tdd-arrow-summary.turn` は得られない。

## 9. 関連 rule

- [[sequence-complete-verify]] — Tier 1-4 verify (総論)
- [[audit-trail-mandatory]] — audit_logs delta 必須
- [[verdict-vocabulary]] — verdict tier マップ
- [[pre-verdict-self-audit]] — Q1-Q4 self-audit
- [[no-invented-symbols]] — 発明 symbol 禁止

## 10. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report
 (UC 60+ / assertion 500+ の系統的 shallow verify)
- 2026-07-26 ユーザー激怒案件: 完璧 TDD 指示にも関わらず矢印 1 本 1 本の
 verify を Claude が独自判断で省略 → バグ見逃し
 - 根本対処: script-level ゲート化 (Claude の自主判断領域から剥奪)
- 2026-07-27 定義の分裂事故: 本 rule が「矢印 6 分類 + evidence 1 個」だけを
 定義し、利用者正典の 5 フェーズ (根本原因→改修→単体テスト→デプロイ→
 ブラウザ検証) を参照していなかった。 ccagi-protocol-gate 側だけが 5 フェーズを
 実装しており、本 rule だけを読んだ者は「完璧TDD = 矢印を数えること」と
 誤解した。
 - 根本対処: 定義を §0 に正典のまま転記し、直積 (矢印 × 5 フェーズ) として
 `ccagi-arrow-verify.sh` に 5 flag 必須で実装。 両パッケージを §8 で相互参照。

- 2026-07-29 定義の降格事故: 正典定義を認識したまま、実行予算に収まらないと
 判断した瞬間に「完璧」の領域を切り下げ、切り下げ後を「完璧」と呼び直して
 合否宣言した。 停止門は合否語を検出していたが判定に使っていなかった。
 - 根本対処: §0.2 の 5 構造 (表記ゆれ正規化 / 母数凍結 / 語の門 /
 正直な出口 / 配備先と可視ブラウザの突き合わせ)

---
*tdd-perfection-gate v1.6.0 — Perfect TDD Trigger Rule*
