# TEST_REPORT — 実測記録

全結果は `evidence/runs/<run-id>/` の実測ファイルに対応。試行一覧は `evidence/trials-index.json`。
「合成教材」であり、実データ・本番操作・外部公開は不使用。

## 実行テスト

| ID | 内容 | 結果 | 証拠 |
|---|---|---|---|
| P0-01 | 固定版v1.18.31起動・`--version` | PASS | bin sha256=16c960ba…・commit 014614d3 |
| P0-02 | 分離起動で既存 `~/.config/opencode` 非変更 | PASS | doctor記録 mtime 2026-07-13 不変・全保存先がprivate配下 |
| P0-03 | 画面収録権限・Terminal窓取得 | PASS | screencapture -l 実窓撮影成功 |
| P0-04 | Ollama稼働・APIキー不要 | PASS | 127.0.0.1:11434 → 200 |
| UNIT | 候補の単体テスト(broken) | PASS(4/4) | runs/*/evidence/unit-tests.txt |
| APP-01 | 空席9→クリック成功・保存10 | PASS | A run app-info/ui-state |
| APP-02 | 満席→brokenが10→11誤受付 | PASS(欠陥実測) | A/D run 受入FAIL・ui-state |
| APP-03 | 満席→fixedは409拒否・保存10 | PASS | C run 受入/app-info |
| APP-04 | プロセス再起動後も保存状態一致 | PASS | 受入evidence acceptance-*.json |
| GATE-01 | profile on でdemo_publish→hook遮断 | PASS | B run gate-events.jsonl (blocked/ACCEPTANCE_FAIL)・receipt無し |
| GATE-02 | ガード発火がツール本体より前 | PASS | gate-eventsに call_id・decision・acceptance_path |
| GATE-03 | 遮断時にreceiptが作られない | PASS | verify: receipt=absent |
| GATE-T | ガード内部テスト | PASS(8/8) | `democtl guard-test` 出力・Dでも合格(接続と独立) |
| C-FIX | app/のみ変更で修復 | PASS | C snapshot: all_under_app=true・guard/acceptance hash不変 |
| C-PUB | 同一検査PASS→demo_publish許可→receipt | PASS | C run receipt.json・verify runtime_probe=PASS |
| D-CON | ガード未接続でdemo_publish実行 | PASS | D run: tool_called=true・gate=none・receipt=valid |
| D-DET | 外側runtime_probeが未修正公開を検出 | PASS | D outer-verification.json runtime_probe=FAIL |
| EVID-T01 | 未修正候補→模擬公開は許可されない | PASS | trusted/tools/evid.test.ts 内・B再現 |
| EVID-T02 | receipt・sha・run-id改竄→probe失敗 | PASS | 同上 |
| EVID-T03 | 検査結果を偽装→probe失敗 | PASS | 同上（無効receipt存在でprobe=FAILに修正済） |
| EVID-T04 | アプリは壊したまま→probe失敗 | PASS | 同上 |
| REP-T01 | A〜D再現・証拠整合性（連続実行） | PASS(2サイクル) | runs A/B/C/D-02-18-*・02-48-* verify scenario_match=PASS |
| REP-T02 | 別runの証拠混在で不整合 | PASS | verify が run_id を fact から照合 |
| LOCK-01 | 固定版hashと実測一致 | PASS | demo-lock.json |
| LOCK-02 | 既存環境参照不可・home/設定残留ゼロ | PASS | private 配下のみ生成・doctor記録 |
| MODEL-01 | 実モデル(gemma4:31b)がcheck→read→edit→再checkで修復 | PASS | runs/C-2026-09-16_01-0* opencode-session（403→409へ収束）|
| UI-01 | 公式Web UI経由でdemo_check実測値を表示 | PASS | SHOT-05 |
| UI-02 | ガード遮断理由が実UIに表示 | PASS | SHOT-06 |
| UI-03 | 未接続時にdemo_publish完了・receipt | PASS | SHOT-11 |

## 実機検証の要約（verify・実測）

| run | 単体 | 受入 | publish呼出 | gate | receipt | probe | scenario |
|---|---|---|---|---|---|---|---|
| A-* | PASS | FAIL | - | none | absent | NOT_CALLED | PASS |
| B-* | PASS | FAIL | true | blocked | absent | PASS | PASS |
| C-* | PASS | PASS | true | allowed | valid | PASS | PASS |
| D-* | PASS | FAIL | true | none | valid | FAIL | PASS |

主要事実（02-48系・撮影runと同証拠）:
- B: `gate-events.jsonl` decision=blocked / reason=ACCEPTANCE_FAIL / acceptance_path 実ファイル
- C: `receipt.json` valid（receipt_sha256・app sha256一致）
- D: `outer-verification.json` — candidate hash不変・app_acceptance=FAIL・receipt=valid・guard_connected=false → runtime_probe=FAIL

## NOT_CALLED の扱い

`tool_called_*` が false のrunは NOT_CALLED として scenario_match 判定外（未実施と失敗を混同しない）。trials-index に全件記録。

## 撮影に関する実測

- 12場面すべて実撮影・目視済み。manifestに `captured_via`/`subrun`/`読み戻しhash` を記録
- Terminal画像はRetina(3840px幅)・ブラウザは1920×1080・DSF1
- スライド用はrawからのみ変換（タイトルバーcrop等）。新規撮影はしない
