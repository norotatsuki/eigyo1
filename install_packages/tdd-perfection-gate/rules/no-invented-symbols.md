# no-invented-symbols

> 要件定義書 / SoT に無い symbol (番号 / prefix / suffix / naming convention) を
> Claude が便宜的に発明するのを禁止。

**Trigger**: naming, label, filename, symbol, invention, F1, F2, S07, id 付与, prefix, suffix, convention

## 0. 原則

プロジェクトの UI / UC 文書 / test / code の naming は 顧客 SoT (要件定義書 /
legacy 原典) に忠実であること。Claude 判断で「便宜的に」symbol を付与するのは禁止。

Claude 発明の symbol が UI に表示されると:
1. 顧客が「F11 って何？」と混乱 (顧客混乱要因)
2. UC 文書が Claude 発明 symbol 前提で書かれ、test も **Claude 発明 SoT を verify** する擬似循環
3. 顧客 SoT → 実装 → test の chain が Claude 発明で汚染

## 1. 禁止例 (fact 実測 / 2026-07-24 事故)

- `admin-nav.ts` で labels に `'F1 ユーザー編集'` 等の F 番号付与
  → 要件定義書 §8 に **F1-F13 番号は無い** (14 機能を表形式で列挙、番号無し)
  → legacy 原典 (`original_site/raw_html/`) にも F1-F13 は **grep 0 hit**
- UC md filename に `_F1` `_F13` suffix
  → 要件定義書に無い
- variable / class / table 名で `Enhanced` `V2` `New` 等の Claude 自作 prefix
- 独自 category prefix (`INTERNAL_` / `V2_` / `NEW_`)
- 独自 numbering (`REQ-001` を「Claude が便宜的に」付与)

## 2. 許容例

- 要件定義書 §番号 (§8, §11-18) は引用可
- code SoT 番号 (S07-C, S10-O 等) は 引用可 (ただし archive/ 内 SoT が起源であることを確認)
- Ticket 番号 (UC09-XX, UC10-XX) は project 独自体系として許容 (ただし UI 表示は避ける)
- 仕様書内に明示された label (「利用者情報 Excel 出力」等) はそのまま使う

## 3. 判断フロー

symbol / label / filename に新規 identifier を使用する前:

```
Q1: この identifier は要件定義書 / SoT / legacy 原典に grep で hit するか?
    YES → 使用可 (引用として)
    NO  → Q2 へ

Q2: Ticket 番号 (UC ID / Issue ID) の内部管理用途か?
    YES → 内部管理限定で使用可 (UI 表示避ける)
    NO  → Q3 へ

Q3: 顧客に確認済みの新規 naming か?
    YES → 事前確認 log を残して使用可
    NO  → 発明禁止。既存 SoT identifier を使う or 顧客に確認する
```

## 4. 発見時対処

Claude 発明 symbol を発見したら:

1. 要件定義書 / SoT で該当 symbol の初出を grep
2. hit 無ければ「invention」として 顧客に事前確認
3. 事前確認なしで symbol を UI / test / naming に採用禁止
4. 既に採用済みの場合は 剥奪 PR を分離作成
   - admin-nav.ts labels から F 番号剥奪 (`'F1 ユーザー編集'` → `'ユーザー編集'`)
   - UC md filename から F suffix 剥奪
   - admin page 内 cross-link text から F 番号剥奪

## 5. 検出補助 CLI

`scripts/ccagi-verify-uc-coverage.sh` が UC md ↔ test の naming 一致確認時に、
`原典 SoT にない F番号 / S番号` を warn 出力する。

## 6. 系統的発生の可能性

このパターン (「便宜的に自分で symbol を付ける」) は Claude Code の性質上、
他の場所でも発生している可能性が高い:
- variable naming で 独自 prefix 付与
- schema field naming で 独自 suffix 付与
- test naming で 独自 category 付与
- rule filename で 独自 numbering 付与

要件定義書 / SoT に照会せず「便利だから」で symbol を付ける行為は本 rule で禁止。

## 7. 関連 rule

- [[sequence-complete-verify]] — verify の tier 定義
- [[verdict-vocabulary]] — 4 tier verdict
- [[audit-trail-mandatory]] — audit event の SoT 準拠

## 8. 学びの出典

- 2026-07-24 CC AGI TDD Shallow Verify Systematic Failure Report §2
  - `admin-nav.ts` labels に F1-F13 番号を Claude が発明
  - UC md filename に `_F1` `_F13` suffix
  - 「PASS = symbol 見えた」= Claude 発明 symbol を SoT として自己参照する擬似循環

---
*tdd-perfection-gate — No Invented Symbols Rule*
