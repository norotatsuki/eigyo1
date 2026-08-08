# info-public-guard

> プロジェクト `CLAUDE.md` に「情報の外部公開・共有はユーザー明示許可なしに **絶対禁止**」ルールを
> 冪等な `@import` として組み込むインストーラパッケージ。

## 何を防ぐか

Claude Code は便宜的判断で以下を「気を利かせて」実行しがちである。本ルールは構造的にそれを禁止する:

- Artifact の自動生成・自動公開（デフォルト非公開だから安全という誤認）
- Anthropic 社へのコード・秘密情報の送信
- Public GitHub Issue / PR / Gist の自動起票
- 外部サービス (pastebin, diagram renderer, 他 LLM) への文脈送信
- SNS / Slack public channel への転記
- 公開 URL / 共有リンクの発行

**3 重の "絶対"** で裁量の余地を構造的に閉塞する。

## インストール

### このプロジェクト内へ

```bash
bash install_packages/info-public-guard/install.sh
```

### 別プロジェクトへ

```bash
# 方法 A: パッケージディレクトリごとコピー
cp -r install_packages/info-public-guard /path/to/other/project/install_packages/
bash /path/to/other/project/install_packages/info-public-guard/install.sh

# 方法 B: 直接ターゲット指定
bash install_packages/info-public-guard/install.sh /path/to/other/project
```

インストーラが行うこと:

1. `.claude/rules/info-public-guard.md` を配備（内容が同じならスキップ）
2. `CLAUDE.md` の「Rule imports (Internal tier)」セクション末尾に
   `@import .claude/rules/info-public-guard.md` を **冪等に** 追加
3. セクションが無い場合はセクションごと新設
4. `CLAUDE.md` は編集前に `CLAUDE.md.bak.<timestamp>` にバックアップ

### 冪等性

- ルール本文が同一なら再配備をスキップ
- `@import` 行が既にあれば追加をスキップ
- 何度実行しても副作用は 1 回分

## 検証

```bash
bash install_packages/info-public-guard/test/test-install.sh
```

## アンインストール

```bash
bash install_packages/info-public-guard/uninstall.sh
# or:
bash install_packages/info-public-guard/uninstall.sh /path/to/other/project
```

- `CLAUDE.md` から `@import` 行を削除
- `.claude/rules/info-public-guard.md` を削除
- タイムスタンプ付きバックアップは保持（手動削除）

## Version

0.1.0

## 関連

- ルール本文: `rules/info-public-guard.md`
- 姉妹パッケージ: `install_packages/ccagi-protocol-gate` (STEP 1-5 プロトコル強制)
