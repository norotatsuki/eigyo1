# tdd-perfection-gate

> CC AGI の「完璧 TDD」を構造的に強制するパッケージ。
> 失敗レポート 2026-07-24 (CC AGI TDD Shallow Verify Systematic Failure Report) 対応 (v1.0.0)。
> ユーザー激怒案件 2026-07-26 (完璧TDD 指示にも関わらず矢印 1 本 1 本の verify を省略) 対応 (v1.1.0)。
> 定義分裂事故 2026-07-27 (5 フェーズが本パッケージ側に不在) 対応 (v1.5.0)。
> **定義降格事故 2026-07-29 (正典定義を認識したまま実行予算に合わせて領域を切り下げ、
> 切り下げ後を「完璧」と呼び直した) 対応 (v1.6.0)。**
>
> 6 rule + 4 CLI + 2 hook + browser-test-plus helper scaffold を提供。

## v1.6.0 — 「完璧の定義を下げる」経路の封鎖

v1.5.0 までの門は、事故の 5 段階のうち **1 段も止めていなかった**。
特に最終段 (切り下げ後を「完璧」と呼び直す) は、停止門が応答文の合否語を
検出しながら **その値を判定に使っていなかった** ため完全に素通りだった。

| # | 追加した構造 | 実装 |
|---|---|---|
| ① | 表記ゆれの正規化 — 全角数字「矢印１本１本」/ 反復強調「完璧な完璧な…」で態勢が張られなかった実測バグの修正 | `hooks/perfect-tdd-detector.sh` |
| ② | 母数の凍結 — 起動時に矢印総数 N を script が凍結。後から縮小すると `--summary` が拒否 | `detector` + `scripts/ccagi-arrow-verify.sh` |
| ③ | **語の門** — 証跡が母数に届かない状態での合否語を、いかなる脱出条件よりも優先して拒否。態勢解除後も語の禁止だけは残る | `hooks/perfect-tdd-stop-gate.sh` |
| ④ | 正直な出口 — `--incomplete-report` で到達率を記録すれば「完璧」と呼ばずに終われる | `scripts/ccagi-arrow-verify.sh` |
| ⑤ | 配備先と可視ブラウザの突き合わせ — `--establish-deploy-target` で凍結したクラウド配備先に対し、`--deploy` / `--browser-verify` / `--browser-url` を検証 | `scripts/ccagi-arrow-verify.sh` |

④ は抑止の一部である。出口が 1 つも無いと逃げ道が「定義の切り下げ」だけに
なるため、正直に終われる道を必ず用意する。否定形 (「完璧には達していません」)
は正直な報告として通る。

```bash
# 完璧テスト駆動を回す前に 2 つの凍結を 1 度だけ
bash scripts/ccagi-arrow-verify.sh --establish-manifest --uc-dir docs/use_case
bash scripts/ccagi-arrow-verify.sh --establish-deploy-target --url https://<cloud-host>

# 矢印 1 本ごと (配備が先、可視ブラウザが後)
bash scripts/ccagi-arrow-verify.sh <UC> <N> --kind <A1-A6> \
  --root-cause "..." --fix "..." --unit-test "..." \
  --deploy "<配備ログ (凍結済みホストを含む)>" \
  --browser-verify "<可視ブラウザの実成果物 path>" \
  --browser-url "<凍結済み配備先の URL>"

# やり切れないときの唯一の正しい終わり方
bash scripts/ccagi-arrow-verify.sh --incomplete-report
```

## 完璧なテスト駆動開発とは (利用者正典 / 改変禁止)

> - シーケンスの矢印 1 本 1 本の動作確認を行い
>    - バグの根本原因の確認
>    - バグ改修
>    - 単体テスト
>    - デプロイ
>    - ブラウザ操作でのテストでバグが根治していることの確認
>    のことをいいます。

これは **直積** である。矢印を横軸、5 フェーズを縦軸とし、交点すべてに実測証跡が要る。

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

| よくある取り違え | 何が欠けているか |
|---|---|
| 矢印を全部数えたが、各矢印の証跡が 1 個だけ | 縦軸 (5 フェーズ) が 1/5 |
| 5 フェーズを 1 セットだけ実施して「完了」 | 横軸 (矢印 N 本) が 1/N |

`ccagi-arrow-verify.sh` が 5 flag 必須で exit 1、`--summary` が marker の中身を
読んで 5 フェーズ欠落を「未 verify」と数えることで、両方を構造的に閉塞する。

## 何を解決するか

過去 (2026-07-24 failure report):

- UC test が「HTTP 200 + DOM element 存在」レベル (Tier 1) だけで「PASS 完璧 GREEN」と宣言
- 実 DB write (Tier 2) / external side-effect (Tier 3) / audit trail (Tier 4) の verify を
  60+ UC / 500+ assertion で系統的に skip
- 要件定義書に無い symbol (F1-F13 等) を Claude が便宜的に発明し、UI / UC 文書 / test に汚染
- CLAUDE.md rule (fact-first-execution 等) は書かれていたが Claude 自主判断依存で shallow-verify を stop できず

**v1.1.0 追加問題 (2026-07-26)**:

- 「完璧なテスト駆動開発」とユーザーが明示指示しても、Claude はシーケンス図の
  矢印 1 本 1 本の verify を「サンプル arrow だけ verify で総括」と独自判断で省略
- テスト失敗数を 0 まで詰め切らずに verdict を宣言してバグを見逃す

本 package は下記 5 系統で構造的に対処:

1. **6 rule** — CLAUDE.md に @import され、Claude の各 turn で参照される
2. **4 CLI script** — verdict 宣言前の self-audit / UC md ↔ test 網羅 check / arrow 単位 verify / zero-bug loop
3. **2 hook** — UserPromptSubmit で「完璧TDD」トリガー検出 + Stop で per-arrow 全数 + zero-bug marker 強制
4. **browser-test-plus helper** — Tier 2-4 verify を宣言的に書ける TypeScript library
5. **ccagi-protocol-gate v0.5.0 との連携** — Stop hook が verdict 系キーワード検出時に marker を要求

## パッケージ内容

```
tdd-perfection-gate/
├── VERSION                                # 1.1.0
├── README.md                              # 本ファイル
├── install.sh                             # インストーラ
├── uninstall.sh                           # アンインストーラ
├── rules/                                 # 6 rule (CLAUDE.md @import 対象)
│   ├── sequence-complete-verify.md        # 4 tier verify 必須化 (v1.0.0)
│   ├── no-invented-symbols.md             # Claude 発明 symbol 禁止 (v1.0.0)
│   ├── audit-trail-mandatory.md           # audit_logs / api_logs delta 必須 (v1.0.0)
│   ├── verdict-vocabulary.md              # 4 tier verdict (v1.0.0)
│   ├── pre-verdict-self-audit.md          # PASS 宣言前 Q1-Q4 self-audit (v1.0.0)
│   └── perfect-tdd-trigger.md             # 完璧TDD トリガー時 per-arrow + zero-bug 強制 (v1.1.0)
├── scripts/                               # 4 CLI
│   ├── ccagi-pre-verdict-audit.sh         # self-audit marker 3+1 生成 (v1.0.0)
│   ├── ccagi-verify-uc-coverage.sh        # mermaid arrow ↔ assertion 1:1 check (v1.0.0)
│   ├── ccagi-arrow-verify.sh              # arrow 1 本ごとに marker 生成 (v1.1.0)
│   └── ccagi-zero-bug-loop.sh             # test 失敗数=0 実測ループ (v1.1.0)
├── hooks/                                 # 2 hook (v1.1.0 新規)
│   ├── perfect-tdd-detector.sh            # UserPromptSubmit hook (トリガー検出)
│   └── perfect-tdd-stop-gate.sh           # Stop hook (per-arrow + zero-bug 強制)
└── helpers/
    └── browser-test-plus/                 # TypeScript library scaffold
        ├── package.json
        ├── tsconfig.json
        ├── README.md
        └── src/
            ├── index.ts
            ├── dbProbe.ts                 # Tier 2: DB delta
            ├── auditProbe.ts              # Tier 4: audit_logs delta
            ├── mailProbe.ts               # Tier 3: 実 mail 到達
            ├── smsProbe.ts                # Tier 3: 実 SMS 到達
            ├── larkChatProbe.ts           # Tier 3: Lark chat delta
            ├── externalApiLogProbe.ts     # Tier 3-4: meiyasu_api_logs 等
            └── sequenceVerify.ts          # UC md ↔ test coverage
```

## インストール

```bash
# このプロジェクト内
bash install_packages/tdd-perfection-gate/install.sh

# 別プロジェクトへ
bash install_packages/tdd-perfection-gate/install.sh /path/to/other/project
```

インストーラが行うこと:

- `.claude/rules/` に 6 rule 配備 (idempotent)
- `scripts/` に 4 CLI 配備
- `.claude/hooks/` に 2 hook 配備 (v1.1.0)
- `.claude/settings.json` に UserPromptSubmit + Stop hook 登録 (idempotent, backup 生成)
- `tools/browser-test-plus/` に helper scaffold コピー
- `.gitignore` に `.claude/state/tdd-*.turn` + `perfect-tdd-*.turn` + `zero-bug-logs/` 追加
- `CLAUDE.md` に `@import .claude/rules/<rule>.md` を 6 個追記 (idempotent)

## v1.1.0 — 完璧 TDD トリガー + Per-Arrow + Zero-Bug ゲート

### 1. ユーザーがトリガー句を発話すると自動 activate

Claude Code の UserPromptSubmit event で以下を検出:

- 「完璧なテスト駆動開発」「完璧TDD」「完璧テスト」
- 「perfect TDD」「perfect-tdd」「perfect test-driven」
- 「ゼロバグ」「zero-bug」「bug-zero」
- 「矢印1本1本」「矢印一本一本」「arrow-by-arrow」「per-arrow」

検出すると `.claude/state/perfect-tdd-mode.turn` フラグが生成され、Stop hook が
以下 5 marker の存在を **応答終了条件** として要求します:

| Marker | 生成コマンド | 意味 |
|---|---|---|
| `tdd-arrow-summary.turn` | `ccagi-arrow-verify.sh --summary --uc-dir <path>` | 全 UC md arrow verify 完了 |
| `tdd-zero-bug-verified.turn` | `ccagi-zero-bug-loop.sh --cmd "..." --min-streak 3` | test 失敗数=0 連続 N 回 |
| `tdd-db-probe-verified.turn` | `ccagi-pre-verdict-audit.sh --db-probe ...` | DB delta 実測 |
| `tdd-audit-trail-verified.turn` | `ccagi-pre-verdict-audit.sh --audit-trail ...` | audit_logs delta 実測 |
| `tdd-external-effect-verified.turn` | `ccagi-pre-verdict-audit.sh --external-effect ...` | 外部到達実測 |

1 つでも欠けたら Stop hook が exit 2 で応答終了を拒否します。

### 2. Per-Arrow Verify の使い方

UC md 内 mermaid `sequenceDiagram` の各 arrow を 6 分類し、1 本ずつ verify:

| 分類 | arrow 例 | 要求 assertion |
|---|---|---|
| **A1: Actor Input** | `User->>Page: click submit` | Playwright / RTL action + DOM 応答 |
| **A2: Route/Controller** | `Page->>API: POST /login` | HTTP status + response schema |
| **A3: Service Logic** | `API->>Service: authenticate(dto)` | Service unit test |
| **A4: DB Access** | `Service->>DB: INSERT audit_logs` | `prisma.<table>.count` の delta |
| **A5: External Call** | `Service->>ExternalAPI: send mail` | 実 mail 到達 or MSW recording |
| **A6: Response Rendering** | `Page-->>User: navigate /dashboard` | URL/DOM/toast 検証 |

上の 6 分類は **横軸** (どの矢印か)。これに **縦軸** として 5 フェーズが掛かる:

| # | フェーズ | flag |
|---|---|---|
| 1 | バグの根本原因の確認 | `--root-cause` |
| 2 | バグ改修 | `--fix` |
| 3 | 単体テスト | `--unit-test` |
| 4 | デプロイ | `--deploy` |
| 5 | ブラウザ操作でバグが根治していることの確認 | `--browser-verify` |

```bash
# arrow 1 本ずつ、5 フェーズ全部を揃えて verify (各値 8+ chars 必須)
bash scripts/ccagi-arrow-verify.sh UC02-01 1 --kind A1 \
  --root-cause     ".test-logs/repro-uc02-01-1.log" \
  --fix            "src/pages/login.tsx" \
  --unit-test      "src/pages/login.test.tsx" \
  --deploy         ".deploy-logs/dev-2026-07-27.log" \
  --browser-verify "off:user-not-requested-video"

bash scripts/ccagi-arrow-verify.sh UC02-01 2 --kind A2 \
  --root-cause     ".test-logs/repro-uc02-01-2.log" \
  --fix            "src/api/login.ts" \
  --unit-test      "src/api/login.test.ts" \
  --deploy         ".deploy-logs/dev-2026-07-27.log" \
  --browser-verify "off:user-not-requested-video"
# ... 全 arrow 分繰り返す (必要証跡数 = 矢印の本数 × 5) ...

# 完了後 summary marker 生成 (coverage < 100% なら exit 1)
bash scripts/ccagi-arrow-verify.sh --summary --uc-dir docs/use_case
```

- 5 フェーズのうち 1 つでも欠けると marker は生成されません (exit 1)。
- 各値に `n/a` / `N/A` / `該当なし` / `TODO` 等の逃げ表現は禁止です。
- `--browser-verify` の `off:` は「**動画を撮らなかった**」の意味であって、
  「ブラウザ検証をしなかった」ではありません (動画既定 OFF は protocol-gate v0.5.0 と同一規約)。
- `--evidence` は任意の補足メモで、5 フェーズの代わりにはなりません。
- `touch` で作った空 marker は `--summary` が中身を読んで弾きます。
- verify skip したい場合は UC md から該当 arrow を削除 (spec 修正) してください。

### 3. Zero-Bug Loop の使い方

指定コマンドを foreground で実行し、`--min-streak` 回連続 pass するまでループ:

```bash
# npm test を 3 回連続 pass するまで
bash scripts/ccagi-zero-bug-loop.sh --cmd "npm test" --min-streak 3

# pytest を 5 回連続 pass するまで (各回 timeout 600s)
bash scripts/ccagi-zero-bug-loop.sh --cmd "pytest -x tests/" --min-streak 5 --timeout-sec 600

# Playwright E2E を 2 回連続 pass するまで
bash scripts/ccagi-zero-bug-loop.sh --cmd "npx playwright test" --min-streak 2 --label e2e
```

各 run の stdout/stderr は `.claude/state/zero-bug-logs/<label>-<seq>.log` に記録され、
marker (`tdd-zero-bug-verified.turn`) に history と rc が JSON で残ります。
flaky (連続でない pass) は streak 0 にリセットされます。

### 4. 解除方法

ユーザーが明示的に「完璧TDDモード解除」「perfect-tdd off」等を発話すると
detector が自動で flag を削除します。

または、全 marker が揃った状態で Stop hook を通過した瞬間、自動で consume されます。

## 使い方 (Claude 側の canonical flow)

### 通常フロー (v1.0.0)

`ccagi-protocol-gate` v0.5.0 の STEP 6 (browser-test / tdd モード) と組み合わせて使う:

1. STEP 1-6 完了 (ccagi-protocol-ack.sh)
2. tests / browser-test を実行し、Tier 1-4 assertion を収集
3. verdict 宣言前に self-audit を実施:

   ```bash
   bash scripts/ccagi-pre-verdict-audit.sh \
     --db-probe "prisma.audit_logs.count invoked=Y (before=100, after=101)" \
     --audit-trail "audit_logs.LOGIN_SUCCESS delta=1" \
     --external-effect "welcome mail 到達確認 (msgId=abc123)" \
     --uc-coverage "arrows=8 assertions=8 ratio=100%" \
     --verdict "SPEC-PASS"
   ```

4. 応答内で verdict を宣言 (`[UC02-01] verdict: SPEC-PASS`)
5. Stop hook が 3 marker の存在を確認して通過

### 完璧TDD フロー (v1.1.0)

ユーザー「完璧なテスト駆動開発でこの機能を実装してください」

1. UserPromptSubmit hook が自動で `perfect-tdd-mode.turn` を生成
2. STEP 1-6 宣言 (ccagi-protocol-ack.sh, `--step6 tdd:...`)
3. UC md 内 mermaid 全 arrow を per-arrow verify:
   ```bash
   for uc in docs/use_case/*.md; do
     # 各 UC の arrow index 1..N まで ccagi-arrow-verify.sh 実行
   done
   bash scripts/ccagi-arrow-verify.sh --summary --uc-dir docs/use_case
   ```
4. Zero-bug loop 実行:
   ```bash
   bash scripts/ccagi-zero-bug-loop.sh --cmd "npm test && npm run test:e2e" --min-streak 3
   ```
5. 既存 3 mandatory (v1.0.0):
   ```bash
   bash scripts/ccagi-pre-verdict-audit.sh --db-probe ... --audit-trail ... --external-effect ... --uc-coverage ... --verdict SPEC-PASS
   ```
6. 応答で SPEC-PASS 宣言 → Stop hook が全 marker 揃っていることを確認して通過

### UC md 網羅チェック (総論、v1.0.0)

```bash
bash scripts/ccagi-verify-uc-coverage.sh docs/use_case/UC02-01.md tests/uc02-01.spec.ts
# → arrows / assertions / ratio / verdict + 発明 symbol warn を出力
# → exit 0 (>= 100%) or exit 1 (< 100%)
```

### browser-test-plus helper

TypeScript project で:

```bash
cd /path/to/project
npm install --save-dev ./tools/browser-test-plus
```

```typescript
import { dbProbe, auditProbe, sequenceVerify } from '@ccagi/browser-test-plus';

test('login (SPEC-PASS)', async ({ page, prisma }) => {
  const audit = await auditProbe(prisma, 'LOGIN_SUCCESS', async () => {
    await page.goto('/login');
    // ...
  });
  expect(audit.delta).toBeGreaterThanOrEqual(1);
});
```

## verdict tier 対応表

| verdict | 通過 Tier | ccagi-pre-verdict-audit 引数例 |
|---|---|---|
| `UI-PASS` | Tier 1 | `--db-probe "n/a: UI only"` |
| `CONTRACT-PASS` | Tier 1+2 | `--db-probe "prisma.foo delta=1"` |
| `SEQUENCE-PASS` | Tier 1+2+3 | `+ --external-effect "実到達確認"` |
| `SPEC-PASS` | Tier 1+2+3+4 | `+ --audit-trail "audit_logs delta=1"` |
| `PARTIAL-COVERAGE` | UC md arrow 網羅 < 100% | ccagi-verify-uc-coverage exit 1 |
| `AUDIT-MISSING` | audit assertion skip | audit_logs writer 未実装 |
| `EXTERNAL-UNVERIFIED` | external side-effect skip | 実到達 probe 未実行 |

## ccagi-protocol-gate v0.5.0 との連携

既存の Stop hook (`protocol-stop-gate.sh`) と本 package の `perfect-tdd-stop-gate.sh` は
共存可能で、独立に marker を要求します:

- `protocol-stop-gate.sh` → 常時: 3 marker (db-probe / audit-trail / external-effect)
  (verdict 系キーワード検出時)
- `perfect-tdd-stop-gate.sh` → `perfect-tdd-mode.turn` 存在時のみ:
  5 marker (上記 3 + arrow-summary + zero-bug-verified) を要求

## アンインストール

```bash
bash install_packages/tdd-perfection-gate/uninstall.sh
# または:
bash install_packages/tdd-perfection-gate/uninstall.sh /path/to/other/project
```

## 依存

- `bash` (>= 4)
- `python3` (>= 3.7)
- `grep`, `awk`, `timeout` (coreutils, macOS では `brew install coreutils` で `gtimeout` を `timeout` として提供 or 標準 `timeout` を使用)
- TypeScript helper 使用時: Node.js >= 18, `@prisma/client` >= 5

## ライセンス

MIT

## Version

1.1.0

### Changelog

- **1.1.0** (2026-07-26) — Perfect TDD Trigger + Per-Arrow + Zero-Bug loop
  - 新 rule: perfect-tdd-trigger.md
  - 新 hook: perfect-tdd-detector.sh (UserPromptSubmit) + perfect-tdd-stop-gate.sh (Stop)
  - 新 CLI: ccagi-arrow-verify.sh (per-arrow marker) + ccagi-zero-bug-loop.sh (実測 loop)
  - install.sh が `.claude/settings.json` に hook 2 個を idempotent 登録
  - marker 要件を 3 → 5 に拡張 (perfect-tdd-mode 活性時のみ)
  - 「サボり」の余地を script-level で構造的に閉塞

- **1.0.0** (2026-07-24) — 初版
  - 5 rule: sequence-complete-verify / no-invented-symbols / audit-trail-mandatory / verdict-vocabulary / pre-verdict-self-audit
  - 2 CLI: ccagi-pre-verdict-audit.sh / ccagi-verify-uc-coverage.sh
  - browser-test-plus helper (7 module: dbProbe / auditProbe / mailProbe / smsProbe / larkChatProbe / externalApiLogProbe / sequenceVerify)
  - ccagi-protocol-gate v0.5.0 Stop hook との連携

## 参照

- 失敗レポート (v1.0.0): `request copy/20260724/2026-07-24_CC-AGI-TDD-Shallow-Verify-Systematic-Failure-Report.md`
- ユーザー訴え (v1.1.0): 2026-07-26 完璧TDD 指示に対する矢印 1 本 1 本 verify サボり検出
- ccagi-protocol-gate: `install_packages/ccagi-protocol-gate/README.md` (v0.5.0+)
- plain-japanese-guard: `install_packages/plain-japanese-guard/README.md`

---

## v1.4.0 — 無駄な繰返しを断ち、本物のときは止まらない

### 解決した問題

v1.3.1 までは応答完了門が `MAX_RETRY=20` の**固定回数**で脱出していたため、
相反する 2 つの要求を同時に満たせませんでした。

| 場面 | v1.3.1 の挙動 | 問題 |
|---|---|---|
| 本物の完璧テスト駆動 (矢印を 1 本ずつ確認中) | 20 回で強制通過 | やり切る前に抜けてしまう |
| 証跡を作る手段が無いリポジトリ | 20 回粘る | 応答の書き直しを 20 回繰り返すだけ |

### v1.4.0 の判定 — 固定回数から「進捗基準」へ

証跡 (`tdd-*.turn` の総数) が前回より 1 つでも増えていれば **進捗あり**。

- **進捗あり** → 無進捗カウンタを 0 に戻す。**回数上限なしで粘る**
- **進捗なし** → カウンタ +1。`PERFECT_TDD_NO_PROGRESS_LIMIT` (既定 3) 超で態勢を自動解除

矢印 1 本ごとの証跡 (`tdd-arrow-<UC>-<N>-verified.turn`) も総数に入るため、
矢印を 1 本確認するたびに進捗と判定されます。つまり
**手を動かしている限り永久に止めず、手が止まったら 3 回で抜ける**。

### 実行可能性の事前判定 (feasibility preflight)

検出器が起動時に、証跡を作る前提がリポジトリに存在するかを調べます。

| 前提 | 判定材料 |
|---|---|
| 全体走行できるテスト指示 | `package.json` の `scripts.test` / `pytest.ini` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml` / `build.gradle` / `Makefile` / `vitest.config.*` / `jest.config.*` / `playwright.config.*` |
| 使用場面書フォルダ | `docs/use_case` (別名 `docs/usecase` / `docs/uc` / `docs/use-cases`) |

不足があれば態勢目印に `feasible: false` と `missing_capabilities` を記録し、
応答完了門は**阻止せず助言のみで通過**します。
「証明手段が無いのに証明を要求し続ける」設計の穴を構造的に塞ぎます。

### 問い合わせでは起動しない

「完璧なテスト駆動開発は有効ですか？」のような**態勢そのものへの問い合わせ**
(疑問形の合図があり、作業依頼の動詞が 1 つも無い) では態勢を張りません。
実際にやり切らせたい場合は「完璧なテスト駆動開発で修正してください」のように
作業依頼の形で指示してください。

### 途中打切り検出係の誤検出を解消

判定前に、以下を検査対象から除去します。

- 囲み記号つきコード塊 / 行内のコード引用
- 引用行 (行頭 `>`)
- 拡張子つきのファイル名・パス

これにより、門の出力を利用者に引用して見せたり、スクリプト名を報告に書いた
だけで阻止される誤検出がなくなります。

### 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `PERFECT_TDD_NO_PROGRESS_LIMIT` | 3 | 無進捗の連続許容回数 |
| `PERFECT_TDD_STOP_MAX_RETRY` | 0 (無制限) | 絶対上限。進捗があっても必ず抜けたい場合のみ設定 |
| `PERFECT_TDD_UC_DIR` | `docs/use_case` | 使用場面書フォルダ |
| `CCAGI_PERFECT_TDD_NO_ESCAPE` | 0 | 1 にすると無進捗脱出も実行不能通過も封じる |

### 試験

`test/test-perfect-tdd.sh` に T1-T15 (合計 17 件の検証) を収録。
