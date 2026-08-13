# Mac から降ろす — PostgreSQL への移行手順

いま営業リストは Mac 1 台の上にある。この端末が落ちれば全部止まり、壊れれば
数週間の収集が消える。ここでは、それをクラウドの PostgreSQL に移し、
毎日 Cloudflare R2 へ控えを置くところまでの手順を書く。

## 先に、私 (Claude) には出来ないこと

**Oracle Cloud のアカウント作成と、Cloudflare の API トークン発行は代行しない。**
どちらも本人確認・パスワード入力・支払い手段の登録を伴う。これは規則として
代行しない。ここだけはあなたの手が要る。

それ以外 — スキーマ設計・移行・検証・サーバー構築・控え・復旧 — は
すべて用意してあり、実データで動かして確かめてある。

## 置き場所の選定 (2026-08-13 時点の実情)

| | Oracle Cloud Always Free | Google Cloud 無料枠 | Fly.io / Neon 等 |
|---|---|---|---|
| CPU / RAM | **2 OCPU (ARM) / 12GB** | e2-micro 0.25-2 vCPU / 1GB | 共有 / 256MB〜 |
| ディスク | **200GB** | 30GB | 3GB〜 |
| 費用 | 0 円 | 0 円 (us リージョンのみ) | 無料枠は小さい |
| 5.8GB DB | **余裕** | 1GB RAM では厳しい | 容量が足りない |

**Oracle Cloud を採る。** 12GB RAM は 581 万行の PostgreSQL に十分で、
200GB あれば DB 本体 (約 5GB) と控えを置いても余る。

ただし 2 点、承知しておくこと:

1. **2026-06-15 に無料枠が半減した** (4 OCPU/24GB → 2 OCPU/12GB)。
   8/18 以降、超過しているインスタンスは停止される。新規に作る分には
   2 OCPU/12GB で作れば問題ない。
2. **遊んでいると回収される**。Always Free は CPU も通信も低いまま放置すると
   停止されることがある。この用途は収集が常に動くので該当しにくいが、
   収集を止める期間があるなら注意する。

## 手順

### 1. VM を作る (あなたの操作)

Oracle Cloud にサインイン →
Compute → Instances → Create instance

| 項目 | 選ぶもの |
|---|---|
| Image | Canonical Ubuntu 24.04 |
| Shape | **VM.Standard.A1.Flex** (Ampere ARM) |
| OCPU / Memory | **2 OCPU / 12GB** (Always Free の上限) |
| Boot volume | 100〜200GB |
| SSH key | 手元の公開鍵を貼る |

**同じ画面で、Show advanced options → Management → Initialization script に
`scripts/cloud/cloud-init.yaml` の中身をそのまま貼る。** これで最初の起動時に
PostgreSQL の導入から表と索引の作成まで済んだ状態で立ち上がる。

作った後、Networking → Security List で **22/80/443 だけ**開ける。
**5432 は開けない** (PostgreSQL は VM の中からしか触らせない)。

### 2. サーバーを仕立てる

cloud-init を貼っていれば **何もしなくてよい**。進み具合は:

```bash
ssh ubuntu@<VMのIP>
sudo tail -f /var/log/eigyo1-setup.log     # 終わると /opt/eigyo1/.provisioned ができる
```

貼り忘れた / 後から作り直すときは、同じ内容を手で流せる:

```bash
git clone https://github.com/norotatsuki/eigyo1.git /opt/eigyo1
cd /opt/eigyo1 && bash scripts/cloud/provision.sh
```

PostgreSQL の導入・設定・DB とユーザー作成・自動起動・ファイアウォール・
スワップ・タイムゾーンまで通る。DB のパスワードは自動生成して
`/opt/eigyo1/.env` にだけ書く (画面にも git にも出さない)。

### 3. データを運ぶ

**手元で dump を作る:**

```bash
# Mac 側。SQLite → PostgreSQL に一度移してから dump を取る
createdb eigyo_pg
DATABASE_URL=postgres://$USER@localhost:5432/eigyo_pg node scripts/migrate-to-postgres.mjs
pg_dump -Fc --no-owner --no-privileges eigyo_pg | zstd -T0 -9 -o /tmp/eigyo.dump.zst
```

**VM へ送って戻す:**

```bash
scp /tmp/eigyo.dump.zst ubuntu@<VMのIP>:/tmp/
ssh ubuntu@<VMのIP> "cd /opt/eigyo1 && bash scripts/cloud/restore.sh --file /tmp/eigyo.dump.zst --into eigyo"
```

回線が細いなら、先に R2 へ上げて VM から落とす方が速いことがある。

### 4. 欠けていないか確かめる

```bash
DATABASE_URL=postgres://... node scripts/verify-migration.mjs 1000
```

総数・項目別・都道府県別・業種別に加え、無作為 1,000 社を 1 項目ずつ突き合わせる。
**ここが「欠損なし」になるまで、Mac の SQLite は消さない。**

### 5. 毎日の控えを仕込む

```bash
# .env に R2 の鍵を書いてから
sudo bash scripts/cloud/install-backup-timer.sh
sudo systemctl start eigyo1-backup.service    # 一度手で試す
journalctl -u eigyo1-backup -n 40 --no-pager
```

### 6. 復元を必ず一度試す

```bash
bash scripts/cloud/restore.sh      # R2 の最新を別 DB へ戻して件数を出す
```

**戻せて初めて控えが出来たと言える。** 上げただけでは確かめたことにならない。

## 障害からの復旧

VM ごと消えたときは、素の Ubuntu から:

```bash
git clone https://github.com/norotatsuki/eigyo1.git /opt/eigyo1
cd /opt/eigyo1
bash scripts/cloud/provision.sh
# .env に R2 の鍵を書く
bash scripts/cloud/restore.sh --into eigyo
```

## 残っている作業

**アプリ本体はまだ SQLite を見ている。** 現状は 15 ファイル・87 か所で
better-sqlite3 を **同期**で呼んでいる。PostgreSQL の呼び出しは非同期なので、
これを差し替えるには呼び出し側を全部 async にする改修が要る。

移行の土台 (DB・データ・控え・復旧) が先に出来ていれば、この改修は
落ち着いて進められる。逆順にすると、動かないアプリと移っていないデータの
両方を同時に相手にすることになる。
