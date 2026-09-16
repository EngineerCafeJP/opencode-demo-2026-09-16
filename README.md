# OpenCodeデモ教材 — 「大丈夫なはず」を、仕組みで確かめる

講座用の**合成教材**です。実サービス・実データ・本番操作は一切使いません。
固定版 OpenCode v1.18.31（upstream由来・公式配布バイナリ）と、定員10名の合成申込アプリで
「確かめる → 止める → 確かめ直す」の A〜D 状態を実機で再現します。

## 起動（このリポジトリルートで）

```bash
cd <DEMO_ROOT>                # このリポジトリを clone / 展開したディレクトリ
# 公式配布バイナリ opencode v1.18.31 (darwin-arm64) を source/bin/opencode に配置
# （配布URL・SHA-256は docs/ENVIRONMENT.md と demo-lock.json を参照）
./source/democtl doctor       # 固定版・分離・ポート・既存環境非変更を確認
./source/democtl run-stage A  # 状態Aを新規runで一通り実行（B/C/D も同様）
```

`democtl` は DEMO_ROOT 配下のみを操作します。実演用OpenCodeは run ごとの分離HOME/XDGで起動し、既存の `~/.config/opencode` 等には触れません。

## A〜D 切替

| 状態 | コマンド | 内容 |
|---|---|---|
| A | `./source/democtl run-stage A` | 単体合格・実受付は10→11（欠陥を実測） |
| B | `./source/democtl run-stage B` | ガード接続・demo_publish が hook で遮断 |
| C | `./source/democtl run-stage C` | app/のみ修復→同一検査で許可・receipt作成 |
| D | `./source/democtl run-stage D` | ガード未接続→未修正でも通る→外側検証がFAIL検出 |

個別操作: `prepare / serve / prompt / app / check / unit / guard-test / snapshot / verify / fix / stop`（`./democtl` 無引数でusage）。詳細は [docs/RUNBOOK.md](docs/RUNBOOK.md)。

## 素材一覧

- **[assets/index.html](assets/index.html)** — ブラウザで開く実撮影12場面の一覧（オフライン可）
- [assets/SCREENSHOT_INDEX.md](assets/SCREENSHOT_INDEX.md) — 場面↔証拠の対応表
- [assets/slide-ready/](assets/slide-ready/) — スライド用PNG 12枚（原画像は assets/raw/）
- [assets/shot-manifest.json](assets/shot-manifest.json) — 画像ごとの実測メタデータ
- [evidence/runs/](evidence/runs/) — runごとの実測（gate-events, receipt, outer-verification 等）
- [evidence/trials-index.json](evidence/trials-index.json) — 成功・失敗・NOT_CALLED 全試行
- [demo-lock.json](demo-lock.json) — 固定版・環境・各hashの実測記録

## 復旧

```bash
./source/democtl stop            # 起動したserve/appを全run分停止（PID記録から個別停止）
./source/democtl doctor          # 環境健全性の再確認
```

- 状態のやり直しは `./source/democtl prepare <A-D>` で**新規run**を作る（上書きしない）
- Dの後は `./source/democtl run-stage B` でガード接続状態へ戻す
- 詳細手順は [docs/RUNBOOK.md](docs/RUNBOOK.md) §復旧

## 実演用OpenCodeへのプロンプト

`docs/RUNBOOK.md` の場面別プロンプトのみを渡してください。制作指示書・撮影台本は渡しません。

## 構成

```
demo-delivery/
  README.md            このファイル
  docs/                ENVIRONMENT / RUNBOOK / TEST_REPORT / LIMITATIONS / FINAL_REPORT
  source/              合成アプリ(versions)・guard・tools・controller・capture・profiles・fixtures
  assets/              raw/ slide-ready/ SCREENSHOT_INDEX.md shot-manifest.json index.html trials-index.json
  evidence/runs/       runごとの実測（private/とsession DBは除外）
  demo-lock.json       固定版と各hashの実測
  checksums.sha256     納品ファイルの整合性
```

## 注意

- 実演で使うモデルはローカルOllama(`gemma4:*`)または決定的スタブ(`stub-demo`)のみ。外部APIキー不要・認証値は使いません
- `source/` にはバイナリ・ブラウザ・node_modules・private-runtime を意図的に含めていません。実行には `source/bin/opencode` への公式配布バイナリ配置が必要です
- **公開版について**: 証拠ファイル内の絶対パスは `<DEMO_ROOT>` にマスク済みです（判定値・hash・結果は無変更。マスク後の `checksums.sha256` で整合性を検証できます）
