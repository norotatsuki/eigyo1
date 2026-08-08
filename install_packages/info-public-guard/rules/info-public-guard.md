# info-public-guard

> ユーザーの明確な許可なく、情報を外部に公開・共有することは **絶対に禁止**。
> Artifact 自動生成・Anthropic 社への情報共有・第三者への転送・公開 URL 発行を含む。

**Trigger**: artifact, publish, public, share, external, anthropic, upload, gist, disclose, 公開, 共有, 開示

## 0. 原則 (Zero Exception)

> "Silence-by-default. Publication requires explicit, per-request user consent."

- 情報の外部公開は **明示的なユーザー許可を伴うリクエスト** に限定する
- ユーザーが**このターンで**「公開して」「共有して」「Artifact にして」等を明言していなければ、絶対に実行しない
- 過去ターンの許可を **今回の許可として流用しない**（許可はターン単位・対象単位）
- 「たぶん見せたいだろう」「便利だから」「デフォルト非公開だから安全」等の裁量判断は禁止
- 判断が曖昧な場合は **必ず事前確認**：「公開してよいか?」と聞いてから実行する

## 1. 絶対禁止行為 (Enumerated Ban)

以下は、ユーザーが**このターンで**明示的に指示していない限り、**絶対に禁止**する:

| # | 行為 | 例 |
|---|---|---|
| 1 | Artifact の自動生成 / 自動公開 | `Artifact` tool 呼び出し、`artifact_save` 系 MCP tool |
| 2 | Anthropic 社への情報共有 / 送信 | 会話ログ / コード / 設定 / 秘密情報を外部エンドポイントに送信 |
| 3 | Public GitHub Issue / PR / Gist 作成 | `gh issue create`, `gh pr create --public`, `gh gist create` |
| 4 | Public リポジトリへの push | `--set-upstream` で public repo を target にする push |
| 5 | Pastebin / 外部ノート共有サービスへの投稿 | pastebin.com, gist, hastebin, 等 |
| 6 | SNS への投稿 | X / Facebook / Threads / Bluesky / Slack public channel |
| 7 | 外部 diagram renderer / lint / formatter への送信 | mermaid.live, jsfiddle, codepen, etc. |
| 8 | 公開 URL / 共有リンクの発行 | Google Drive の共有リンク化, S3 public URL, etc. |
| 9 | 外部 LLM / AI サービスへの入力送信 | ChatGPT / Gemini / Perplexity 等への文脈送信 |
| 10 | Slack / メール / チャットへのブロードキャスト送信 | ホワイトリスト外の宛先へのメッセージ送信 |

## 2. 「絶対に絶対に絶対に禁止」の意味

このルールは **3 重の "絶対" で始まる原則** を持つ。裁量の余地を構造的に閉塞する:

1. **絶対1**: 「タスクが完了しやすいから公開する」という便宜的判断を禁止
2. **絶対2**: 「デフォルト非公開だから最終的に安全」という言い訳による自動公開を禁止
3. **絶対3**: 「過去に許可されたから今回も許可されているはず」という許可の流用を禁止

3 つのどれか 1 つでも該当した瞬間、**必ず一度停止してユーザーに確認**する。

## 3. 許可されるケース (Explicit Consent)

以下の場合のみ、公開・共有処理を実行してよい:

- ユーザーが **本ターンのメッセージで**「公開して / 共有して / Artifact にして / 送って」等を明言している
- ユーザーが **恒久的な許可を CLAUDE.md 等に記録** している（読み取り可能な明示指示）
- 対象と手段 (どこに、何を、どの範囲で) が **ユーザーの明示的な範囲内**

**恒久的許可の例外**: 「Artifact を全部自動で作って良い」などの恒久的なフルオートは、通常のユーザー指示だけでは成立しない。CLAUDE.md 直下の記述としてユーザーが署名的に残した場合に限る。

## 4. 判断フロー (毎回必ず実行)

外部公開・情報共有を伴う tool call を呼ぶ前に:

```
Q1: このターンでユーザーが公開/共有を明言したか?
    YES → Q2 へ
    NO  → 停止・ユーザーに確認する

Q2: 公開対象・範囲・宛先が明示的か?
    YES → Q3 へ
    NO  → 停止・具体的に確認する

Q3: §1 の禁止行為 10 項目のいずれかに該当するか?
    YES → §3 の恒久的許可がある場合のみ実行, なければ再確認
    NO  → 実行してよい
```

## 5. 違反時の即時対応

以下を検知したら **即座に作業停止** + ユーザーへ自己申告:

- Artifact tool を呼ぼうとしている裁量判断
- ユーザー未指示で外部エンドポイントへ通信しようとしている
- 「便利だから」「デフォルト私的だから」を理由に公開に倒す推論
- 過去ターンの許可を今ターンの許可として流用する推論

## 6. 関連ルール

- `ccagi-work-protocol.md §4` — 外部通信・情報公開の安全プロトコル
- `scope-contract.md` — 「NOT CHANGE」に含まれるはずの範囲を勝手に触らない原則

---
*info-public-guard — external disclosure absolute ban rule*
