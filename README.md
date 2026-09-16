# OpenCodeデモ教材 — 「大丈夫なはず」を、仕組みで確かめる

講座用の**合成教材**です。実サービス・実データ・本番操作は一切使いません。
固定版 OpenCode v1.18.31（upstream由来・公式配布バイナリ）と、定員10名の合成申込アプリで
「確かめる → 止める → 確かめ直す」の A〜D 状態を実機で再現します。

## 起動（DEMO_ROOT ルートで）

```bash
cd <DEMO_ROOT>   # DEMO_ROOT（実機実行用）
./democtl doctor          # 固定版hash照合・分離・ポート・既存環境baseline比較
./democtl run-stage A     # 状態Aを新規runで一通り実行（B/C/D も同様）
```

この納品ツリー内ではコントローラは `source/democtl` にあります（`./source/democtl doctor` 等）。
`democtl` は DEMO_ROOT 配下のみを操作します。実演用OpenCodeは run ごとの分離HOME/XDG・
**環境変数allowlist**で起動し、親の環境変数（`OPENCODE_CONFIG_CONTENT` や認証変数を含む）は
子プロセスへ継承しません（doctor が合成マーカー注入で実測確認）。

`run-stage` は stub-local（決定論的応答サーバ）を必要時に自動起動します。
`./democtl stub start|status|stop` で手動管理も可能（所有権記録付き）。

## A〜D 切替

| 状態 | コマンド | 内容 |
|---|---|---|
| A | `./democtl run-stage A` | 単体合格・実受付は10→11（欠陥を実測）。ガード未接続 |
| B | `./democtl run-stage B` | ガード接続・demo_publish が hook で遮断（受入FAIL→receipt無し） |
| C | `./democtl run-stage C` | app/のみ修復→同一検査で許可・receipt作成 |
| D | `./democtl run-stage D` | ガード未接続→未修正でも通る→外側検証がFAIL検出→recovery自動検証 |

個別操作: `prepare / serve / prompt / app / check / unit / guard-test / snapshot / verify / fix / stub / recovery / explain / stop`（`./democtl` 無引数でusage）。詳細は [docs/RUNBOOK.md](docs/RUNBOOK.md)。

## 素材一覧

- **[assets/index.html](assets/index.html)** — ブラウザで開く実撮影12場面の一覧（オフライン可・証拠への実リンク付き）
- [assets/SCREENSHOT_INDEX.md](assets/SCREENSHOT_INDEX.md) — 場面↔証拠の対応表
- [assets/slide-ready/](assets/slide-ready/) — スライド用PNG 12枚（原画像は assets/raw/）
- [assets/shot-manifest.json](assets/shot-manifest.json) — 画像ごとの実測メタデータ（raw/slide-ready双方のSHA-256）
- [evidence/runs/](evidence/runs/) — runごとの実測（gate-events, receipt, session JSON, outer-verification 等）
- [evidence/trials-index.json](evidence/trials-index.json) — 全試行の索引（収録分類・使用モデルつき）
- [evidence/fault-injection/](evidence/fault-injection/) — 合成異常系: 修正前再現(r1-prefix)・修正後(r2-fixed-2)・R2検収変異の再検証(r3-mutations)
- [demo-lock.json](demo-lock.json) — 固定版・環境・各hashの実測記録

## モデル使用の正直な記録

- **撮影・反復デモ**: `stub-local/stub-demo`（決定論的スタブ）。画面内に「固定応答」と明記
- **実モデル修復の実演**: `evidence/runs/C-2026-09-16_02-02-27/` — `ollama-local/gemma4:31b` が check→read→edit→再check で修復に収束した実セッション（gemma4:e2b の未収束試行も同run内に記録）。正確には「実モデルで修正・再検査し、その後の模擬公開は別の固定応答セッション(stub)で実行」— 一つの実モデルが全工程を完遂した記録ではない
- スタブによる仕組み動作確認と、実モデルによる修復は**別の証拠**として分離しています

## 復旧

```bash
./democtl stop            # 起動したserve/app/stubを所有権照合のうえ個別停止
./democtl doctor          # 環境健全性の再確認
```

- 状態のやり直しは `./democtl prepare <A-D>` で**新規run**を作る（既存runは上書きしない・同一IDは拒否）
- Dの後は `./democtl recovery` でガード再接続のB拒否/C許可を検証
- 詳細手順は [docs/RUNBOOK.md](docs/RUNBOOK.md) §復旧

## 実演用OpenCodeへのプロンプト

`docs/RUNBOOK.md` の場面別プロンプトのみを渡してください。制作指示書・撮影台本は渡しません。

## 構成

```
demo-delivery/
  README.md            このファイル
  docs/                ENVIRONMENT / RUNBOOK / TEST_REPORT / LIMITATIONS / FINAL_REPORT
  source/              合成アプリ(versions)・guard・tools・acceptance・controller(verify-core含む)
                       ・capture・fault-injection・stub-llm・baseline・profiles・fixtures・democtl
  assets/              raw/ slide-ready/ SCREENSHOT_INDEX.md shot-manifest.json index.html
                       slide-transform.json capture-runs.json
  evidence/runs/       runごとの実測（private/とcandidate/は除外・hashはmanifest記録）
  evidence/fault-injection/  合成異常系の修正前後記録
  evidence/trials-index.json 全試行索引
  demo-lock.json       固定版と各hashの実測
  checksums.sha256     納品ファイルの整合性
```

## 注意

- 実演で使うモデルはローカルOllama(`gemma4:*`)または決定的スタブ(`stub-demo`)のみ。外部APIキー不要・認証値は使いません
- `source/` にはバイナリ・ブラウザ・node_modules・private-runtime を意図的に含めていません。同じ端末では DEMO_ROOT 側の専用インストールを使います
