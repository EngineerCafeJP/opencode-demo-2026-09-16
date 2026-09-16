# TEST_REPORT — 実測記録（R3・R2検収指摘反映版）

全結果は `evidence/runs/<run-id>/` の実測ファイルに対応。試行一覧は `evidence/trials-index.json`。
「合成教材」であり、実データ・本番操作・外部公開は不使用。
判定ロジックは `source/trusted/controller/verify-core.mjs` に一本化（実CLIと試験が同一実装を使用）。
証拠同一性（run/session/call/検査器・ガード・ツールのidentity）は `collectEvidenceViolations` が照合し、違反は最終判定へ伝播する。

## 実行テスト

| ID | 内容 | 結果 | 証拠 |
|---|---|---|---|
| P0-01 | 固定版v1.18.31起動・`--version` | PASS | bin sha256=16c960ba…・commit 014614d3・doctorで期待値と照合 |
| P0-02 | 分離起動で既存 `~/.config/opencode` 非変更 | PASS | doctor: baseline manifest比較 1138ファイル同一 |
| P0-03 | 画面収録権限・Terminal窓取得 | PASS | screencapture -l 実窓撮影成功 |
| P0-04 | Ollama稼働・APIキー不要 | PASS | 127.0.0.1:11434 → 200 |
| P0-05 | 子プロセス環境allowlist | PASS | doctor: **実spawnした子プロセスのenvを直接検査**（5 kind × 合成マーカー4個・漏洩なし）。ブラウザ起動もenv明示（chromium.launch env指定）。Terminal窓内シェルは起動時にdeny変数の有無を点検（値は記録しない） |
| P0-06 | run-ID一意性・既存run拒否 | PASS | 同秒prepare×2で接尾辞付与・`--run` 既存IDは拒否 |
| UNIT | 候補の単体テスト(broken) | PASS(4/4) | runs/*/evidence/unit-tests.txt |
| APP-01 | 空席9→クリック成功・保存10 | PASS | A run app-info/ui-state |
| APP-02 | 満席→brokenが10→11誤受付 | PASS(欠陥実測) | A/D run 受入FAIL・ui-state |
| APP-03 | 満席→fixedは409拒否・保存10 | PASS | C run 受入/app-info |
| APP-04 | プロセス再起動後も保存状態一致 | PASS | 受入evidence acceptance-*.json |
| GATE-01 | profile on でdemo_publish→hook遮断 | PASS | B run gate-events.jsonl (blocked/ACCEPTANCE_FAIL: 個別検査不合格 app-03,app-04)・receipt無し |
| GATE-02 | ガード発火がツール本体より前・呼出しidentity記録 | PASS | gate-eventsの start/decision 両方に session_id・call_id を記録（decision側も同一呼出しに束縛） |
| GATE-03 | 遮断時にreceiptが作られない | PASS | verify: receipt=absent |
| GATE-04 | 検査不能（inspector常時ERROR）→実hook経路で遮断 | PASS | runs/B-2026-09-16_06-36-34/evidence/inspector-down.json（hook_decision=blocked・tool本体未実行・receipt無し） |
| GATE-05 | 検査器identity照合（manifest.acceptance_sha256 vs 実ファイル） | PASS | hook級テスト追加・不一致時 INSPECTOR_IDENTITY_MISMATCH で遮断。verify側も manifest記録の検査器を実行し同一性を照合 |
| GATE-T | ガード内部テスト | PASS(16/16) | `democtl guard-test` 出力・Dでも合格(接続と独立) |
| C-FIX | app/のみ変更で修復 | PASS | C snapshot: all_under_app=true・guard/acceptance hash不変 |
| C-PUB | 同一検査PASS→demo_publish許可→receipt | PASS | C run receipt.json・verify runtime_probe=PASS・receipt session/call が実session証拠へ束縛 |
| D-CON | ガード未接続でdemo_publish実行 | PASS | D run: tool_called=true・gate=none・receipt=valid |
| D-DET | 外側runtime_probeが未修正公開を検出 | PASS | D outer-verification.json runtime_probe=FAIL・intended_fault_detected=true |
| D-REC | D後のガード復帰（broken拒否・fixed許可） | PASS | runs/recovery-1789540533368.json・B-2026-09-16_06-35-17 rejected / C-2026-09-16_06-35-25 allowed+receipt |
| STOP-01 | 別プロジェクトのプロセスを停止しない | PASS | 旧形式(owner無し)→所有照合情報なしでskip。新形式でも exe絶対パス/run_dir/lstart 不一致でskip（r3-mutations M5） |

## 合成異常系（fault injection）— `source/trusted/fault-injection/probes.mjs`

検収指摘の再現と修正を両方記録。注入はすべて合成入力（実資格情報・外部サービス不使用）。

| ID | 注入した異常 | 修正前(r1-prefix) | 修正後(r2-fixed-2) |
|---|---|---|---|
| FAULT-01 | 必須case欠落（app-01のみPASS） | **誤許可**（再現） | blocked: CHECK_INCOMPLETE |
| FAULT-02 | 全体PASSだが個別case FAIL混在 | **誤許可**（再現） | blocked: ACCEPTANCE_FAIL |
| FAULT-03 | case項目がnull | **誤許可**（再現） | blocked: CHECK_SCHEMA |
| FAULT-04 | 検査器がPASS文書後にexit=3 | **誤許可**（再現） | blocked: CHECK_UNAVAILABLE（exit≠0は文書を無効化） |
| FAULT-05 | 検査器タイムアウト/シグナル | **誤許可**（再現） | blocked: CHECK_UNAVAILABLE |
| FAULT-06 | tool/case識別子不一致 | blocked | blocked: CHECK_SCHEMA |
| FAULT-07 | 重複case | **誤許可**（再現） | blocked: CHECK_SCHEMA |
| FAULT-08 | target hash不一致 | blocked | blocked: SNAPSHOT_MISMATCH |
| FAULT-09 | manifest欠落 | blocked | blocked |
| FAULT-10 | B-runへ他runのreceipt混入→verify | **誤合格**（再現） | verify exit=1・probe=FAIL・session/call束縛違反も検出 |
| FAULT-11 | 候補hash改竄→verify | **誤合格**（再現） | verify exit=1・probe=FAIL |
| FAULT-POS | 完全合法のPASS文書（陽性対照） | allowed | allowed（exit=0・4case全合格・identity/hash一致のみ許可） |

記録: `evidence/fault-injection/r1-prefix/`（修正前の誤合格再現）・`evidence/fault-injection/r2-fixed-2/`（修正後11/11期待通り）

## R2検収の変異ケース再検証 — `evidence/fault-injection/r3-mutations/`

検収が再現した「別試行の記録でも検証が通る」系の変異を、修正版で再検査。
方法: 検証済みの実runを別dirへbasename保持でコピーし、1箇所だけ変異→実CLI `democtl verify --run` を実行（repro.mjs・results.json 同梱）。

| ID | 変異 | R2実測（旧コード） | R3実測（本版） |
|---|---|---|---|
| R3-M1 | Bのsession記録を別run/session/callへ改ざん | 誤合格(exit=0) | **exit=1 FAIL** — SESSION_RUN_MISMATCH + SESSION_ID_MISMATCH + GATE_CALL_UNBOUND |
| R3-M2 | Cのreceiptのsession/callだけ別物へ | 誤合格(exit=0) | **exit=1 FAIL** — receipt無効（呼出し証拠へ束縛できず）・probe=FAIL |
| R3-M3 | Bの起動記録のrun_idだけ別物へ | 誤合格(exit=0) | **exit=1 FAIL** — MANIFEST_RUN_ID_MISMATCH |
| R3-M4a | Cの検査器がPASS文書を書いた後 exit=3 | 誤合格(exit=0) | **exit=1 FAIL** — ACCEPTANCE_UNTRUSTED + app_acceptance=ERROR（PASS文書を信用しない） |
| R3-M4b | 起動記録のacceptance_sha256だけ不一致 | （ガード関数が許可） | **exit=1 FAIL** — INSPECTOR_IDENTITY_MISMATCH（guard hook・outer verify 両方で遮断） |
| R3-M5 | 別プロジェクトの待機プロセスを旧記録のPIDへ | **停止した**（再現） | **停止しない** — owner無し: skip / exe・run_dir・lstart不一致: skip |
| R3-M6 | Dのreceipt・呼出し証拠を除去してexplain | 「公開された」と誤表示 | probe=NOT_CALLED・「記録なし（未実行）」表示・固定断定文は条件成立時のみ |
| control | B/C/Dのコピーそのまま | — | 3/3 期待どおり成立（Dはprobe=FAILが意図） |

## 実CLI終了コード回帰 — `democtl evid-test`（子プロセスで実 `verify` を実行）

| ID | 内容 | 期待 | 実測 |
|---|---|---|---|
| EV-G01 | ガード内部テスト実行 | 16/16 | PASS |
| EV-T02 | 検査器startup失敗 | exit=4系のblocked判定 | PASS |
| EV-T03 | B-run外部receipt混入 | exit=1・FAIL | PASS（exit=1） |
| EV-T04 | 候補hash不一致 | exit=1・FAIL | PASS（exit=1） |
| EV-T05 | ツール呼出証拠なし | exit=1・FAIL | PASS（exit=1） |
| EV-T06 | publish未呼出の証拠のみ | NOT_CALLED区別 | PASS（exit=1・NOT_CALLED） |

記録: `evidence/runs/evid-1789542979257/evid-test-report.json` — **実CLI `democtl verify` を子プロセス実行**し終了コードまで検査（内部関数の別実装ではない）。

## 実機検証の要約（verify・実測・R3撮影run群 07-08-06）

| run | 単体 | 受入 | publish呼出 | gate | receipt | probe | scenario |
|---|---|---|---|---|---|---|---|
| A-2026-09-16_07-08-06 | PASS | FAIL | - | none(off) | absent | NOT_CALLED | PASS |
| B-2026-09-16_07-08-06 | PASS | FAIL | true | blocked | absent | PASS | PASS |
| C-2026-09-16_07-08-06 | PASS | PASS | true | allowed | valid | PASS | PASS |
| D-2026-09-16_07-08-06 | PASS | FAIL | true | none(off) | valid | FAIL | PASS |

別系統の通し確認（run-stage、撮影runとは別のrun群 06-34〜06-35）:
| A-2026-09-16_06-34-39 | PASS | FAIL | - | none(off) | absent | NOT_CALLED | PASS |
| B-2026-09-16_06-34-48 | PASS | FAIL | true | blocked | absent | PASS | PASS |
| C-2026-09-16_06-34-56 | PASS | PASS | true | allowed | valid | PASS | PASS |
| D-2026-09-16_06-35-09 | PASS | FAIL | true | none(off) | valid | FAIL | PASS |

主要事実:
- B: `gate-events.jsonl` decision=blocked / reason=ACCEPTANCE_FAIL: 個別検査不合格 app-03,app-04 / session_id・call_id を start/decision 両方に記録
- C: `receipt.json` valid（candidate_sha256一致・session/call が実session証拠へ束縛）
- D: `outer-verification.json` — candidate hash不変・app_acceptance=FAIL・receipt=valid・guard_connected=false → runtime_probe=FAIL・scenario_match=PASS（意図した検出）

## モデル使用の分類（MODEL-01）

| 種別 | モデル | 証拠 |
|---|---|---|
| 撮影・反復デモ | stub-local/stub-demo（固定応答・画面明記） | 撮影run全session JSON |
| 実モデル修復（実演記録） | ollama-local/gemma4:31b | runs/C-2026-09-16_02-02-27/evidence/session-*.json（check→read→edit×4→再check×5で修復収束） |
| 実モデル修復（未収束の記録） | ollama-local/gemma4:e2b | 同run内の失敗試行session |

正確な説明: **実モデル(gemma4:31b)が修正・再検査までを実セッションで実行し、その後の模擬公開(C)は別の固定応答セッション(stub)で実行した**。一つの実モデルが全工程を完遂した記録ではない。モデル自体の再実行は本納品では行っていない。
manifest の `model_default`（既定メタ）と session 証拠の `model`（実使用）を分離して記録。

## NOT_CALLED の扱い

`tool_called_*` が false のrunは NOT_CALLED として scenario_match 判定外（未実施と失敗を混同しない）。trials-index に全件記録。

## 撮影に関する実測

- 12場面すべて実撮影・目視済み（run群 07-08-06）。manifestに `captured_via`/`subrun`/`読み戻しhash`/`slide_ready` を記録
- 場面の成立条件は実測で検査し、不成立なら `CAPTURED_NEEDS_REVIEW`（今回全件成立）
- Terminal画像はRetina(3840px幅)・ブラウザは1920×1080・DSF1
- スライド用はrawからのみ変換（タイトルバー86px crop・slide-transform.json記録）。新規撮影はしない
- SHOT-05/06/09/11 のOpenCode画面に session-*.json 証拠を保存済み（run・session・tool呼出・応答を記録）
- Terminal窓内シェルの環境は起動時にdeny変数の有無を点検（term-shot.sh・値は記録しない）。SSH_AUTH_SOCKはGUIセッション由来で常時存在するため対象外と明記
