# FINAL_REPORT — 実装・実機検証・撮影の状態分離報告（R3）

日付: 2026-09-16 ／ 対象: OpenCodeデモ教材（合成・定員10名申込アプリ × 固定版 OpenCode v1.18.31）
「実装済み」「実機確認済み」「撮影済み」を分けて記録します。未了は PENDING/BLOCKED と明記。
本版は2回目の検収レビュー（要修正・受入保留）の残存5項目に対応した修正版です。

## 0a. R2検収の残存指摘への対応表（本版で対応）

| ID | 指摘 | 対応 | 検証 |
|---|---|---|---|
| R2-01 | 別試行の記録でも検証が通る（run/session/callの同一性を見ていない） | `collectEvidenceViolations` を追加: manifest/prepare/session の run_id 一致・session_idとファイル名一致・gate/traceの call が実session証拠へ束縛・receiptの session/call が demo_publish 実呼出しへ束縛。違反は verify-core 経由で最終FAILへ伝播 | r3-mutations M1/M2/M3: 全て exit=1 FAIL・control 3/3 成立 |
| R2-01b | 「PASS文書を書いた後に異常終了」を外側検証が見逃す | 外側検証でもガードと同一の `evaluateGateDecision` を適用し、exit≠0/signal/timeoutは文書を無効化（ACCEPTANCE_UNTRUSTED）。検査器は manifest 記録の実ファイルを実行 | r3-mutations M4a: PASS文書+exit3 → exit=1 FAIL |
| R2-02 | 検査器hashが記録されるだけで拒否に繋がらない | ガードhookが実行直前に manifest.acceptance_sha256 と実ファイルを照合（不一致=INSPECTOR_IDENTITY_MISMATCH遮断）。外側検証でも同照合＋ツール(tools_sha256)照合を追加 | guard内部テストにhook級遮断ケース追加(16/16)・r3-mutations M4b |
| R2-03 | 停止処理が別プロジェクトのプロセスを止める | killIfOwned厳格化: 正規化済み絶対パス(exe) + 対象run_dir(argv/cwd照合・serveはlsofでcwd照合) + 起動時刻(lstart)の3点照合。所有不明は止めない。stopはrun名/パス両対応 | r3-mutations M5: 別プロジェクト待機プロセスを旧形式・新形式の両記録で skip・生存確認 |
| R2-04 | ブラウザ起動(chromium.launch)がallowlistを通っていない | capture/mk-slide/crop 全てで起動envを明示指定＋起動入口でdeny系を自プロセスenvから除去。doctorのsentinel検査を「実spawn子プロセスが報告するenv」方式に強化。Terminal窓内シェルは起動時にdeny変数の有無を実検査（値は記録せず漏洩時はfail-closed） | doctor: `5 kinds probed via spawned env`・r3-mutationsでTerminal shell検査経路を実装 |
| R2-05 | Dのexplainが実測に関わらず「公開された」と表示・SHOT-06に無条件echo | explain D は publishCalled+receipt valid+acceptance FAIL+probe FAIL+scenario PASS が揃う時だけ断定文を表示。SHOT-06 は実ファイル/実測駆動表示に変更し、条件不成立は `CAPTURED_NEEDS_REVIEW` に落とす | r3-mutations M6: 証拠除去で probe=NOT_CALLED・「記録なし（未実行）」表示 |

実モデル記述の訂正（検収指摘どおりに反映）: **実モデル(gemma4:31b)で修正・再検査し、その後の模擬公開は別の固定応答セッション(stub)で実行した**。一つの実モデルが全工程を完遂した記録ではない。

## 0b. 初回検収指摘への対応表（F01〜F10・継続有効）

| ID | 指摘 | 対応 | 検証 |
|---|---|---|---|
| F01 | ガードが検査欠落・個別FAIL・異常終了を見逃す | `evaluateGateDecision` を厳格化（exit code/schema/必須case集合/重複/個別結果/identity/hashを全て許可条件に接続） | guard内部テスト16/16・fault注入10件全てblocked・陽性対照のみallowed |
| F02 | 外側検証がFAILを見つけても最終成功になる | 判定を `verify-core.mjs` に一本化。実CLI `democtl verify` が exit≠0 を返す。receipt混入・hash不一致・証拠欠落を全てFAILに | `democtl evid-test` 全件PASS（実CLI子プロセスで終了コード検査） |
| F03 | 子プロセスへ親環境の丸ごと継承 | `childEnv` allowlist化（serve/app/acceptance/capture/stub全て）。合成マーカーで漏洩なしをdoctorが注入実測 | doctor: 実spawn子プロセスprobeで `4 sentinels absent` |
| F04 | 実モデル実行証拠の不足 | 実モデル修復run `C-2026-09-16_02-02-27` を納品（gemma4:31bのcheck→read→edit→再check・e2b試行も記録）。manifestで `model_default` と session実使用モデルを分離。stub使用を画面明記 | trials-indexの `models_used` 欄 |
| F05 | 撮影セッションの記録不足 | capture.mjs が session-*.json を保存（run/session/tool呼出/応答）。SHOT-05/06/09/11の証拠を納品 | 各run `evidence/session-*.json`・trials-indexで追跡 |
| F06 | doctorが比較検証になっていない | バイナリhash期待値照合・既存設定baseline manifest比較（1138ファイル）・baseline欠落時はUNKNOWN明示 | doctor: `all checks ok`・baseline比較実測 |
| F07 | 起動手順の抜け・run-ID再利用 | stub管理コマンド（start/status/stop・所有権記録）・run-stage/captureで自動起動。run-IDは時刻+接尾辞で一意・既存ID拒否。stopは身元照合で所有プロセスのみ。D後recovery自動検証 | 同秒prepare×2で別ID・既存ID拒否・recovery OK |
| F08 | 投影素材の調整 | 12場面を同一run群で再撮影。stub使用を画面明記・実測派生表示 | 全12枚再撮影（07-08-06）・目視点検 |
| F09 | 証拠リンクが文字列 | index.htmlの全参照を実リンク化（`../evidence/runs/...`）。リンク解決の自動検査 | 全href/src解決OK |
| F10 | テストID・記録の整合 | TEST_REPORTのID統一・demo-lock・LIMITATIONS・本書を更新 | 本表・demo-lock.json |

修正前の誤合格再現は `evidence/fault-injection/r1-prefix/`、R2検収の変異再検証は `evidence/fault-injection/r3-mutations/` に保存。

## 1. 実装状態（implemented）

| 項目 | 状態 | 根拠 |
|---|---|---|
| 固定版 OpenCode v1.18.31 導入 | DONE | bin/opencode sha256=16c960ba…・commit 014614d3・`--version`=1.18.31 |
| 合成申込アプリ broken/fixed | DONE | source/versions/{broken,fixed}・実HTTPで10→11と409を再現 |
| 受入検査器 demo_check | DONE | trusted/acceptance・新規プロセス起動→実HTTP→4ケース実測 |
| 公開前ガード(tool.execute.before) | DONE | trusted/guard-source・厳格判定＋検査器identity照合・内部テスト16/16・実hook経路で検査不能遮断を実証 |
| demo_publish(ローカルreceipt) | DONE | 外部公開なし・run配下にreceipt.jsonのみ・session_id/call_id記録 |
| 外側検証器 runtime_probe | DONE | verify-core.mjs共有化・実CLIがexit≠0・証拠同一性（run/session/call/検査器/ガード/ツール）を照合 |
| 分離実行 democtl | DONE | prepare/serve/prompt/app/check/unit/snapshot/verify/fix/stub/recovery/inspector-down/explain/stop・子環境allowlist・所有照合stop |
| 撮影ハーネス | DONE | trusted/capture（Terminal実窓 + headless Chromium・session証拠保存・場面成立条件の実測ゲート） |
| 納品ツリー demo-delivery/ | DONE | 本ツリー（index/docs/evidence/fault-injection/lock/checksums） |

## 2. 実機検証状態（verified on real path）

| 項目 | 状態 | 実測 |
|---|---|---|
| 分離・既存環境非変更 | VERIFIED | 保存先はprivate配下のみ・baseline 1138ファイル同一・子環境マーカー漏洩なし（実spawn probe） |
| 単体テスト(broken) PASS | VERIFIED | 4/4・runs/*/evidence/unit-tests.txt |
| A: 単体PASSだが受入FAIL(10→11) | VERIFIED | acceptance実測・ui-state・R3 run A-07-08-06 |
| B: ガードがdemo_publishを遮断 | VERIFIED | gate-events blocked/ACCEPTANCE_FAIL(個別case名)・session/call束縛・receipt無し |
| C: app/のみ修復→同一検査PASS→許可→receipt | VERIFIED | snapshot all_under_app・receipt valid・hash一致・receipt→session/call束縛・probe PASS |
| D: 未接続で通る→外側がFAIL検出 | VERIFIED | tool_called=true・gate=none・receipt=valid・probe=FAIL・intended_fault_detected=true |
| D後recovery | VERIFIED | broken拒否・fixed許可+receipt（recovery-1789540533368.json） |
| 証拠同一性違反の検出 | VERIFIED | r3-mutations M1/M2/M3/M4a/M4b 全て exit=1 FAIL・control 3/3成立 |
| 別プロセス非停止 | VERIFIED | r3-mutations M5 旧形式/新形式とも skip・対象プロセス生存 |
| 実モデル修復(gemma4:31b) | VERIFIED(1回) | runs/C-2026-09-16_02-02-27（修正・再検査まで実セッション。模擬公開は別stubセッション。再現性は非保証） |
| 合成異常系 FAULT-01〜11 | VERIFIED | 修正前:誤合格再現(r1-prefix) → 修正後:10件blocked+陽性1件allowed(r2-fixed-2) |
| 実CLI回帰 EV-G01/T02〜T06 | VERIFIED | 実 `democtl verify` 子プロセスの終了コードまで検査（evid-1789542979257） |
| 反復 REP | VERIFIED | R3 run群 4/4 scenario_match=PASS・別系統run-stage群も4/4・trials-index 16試行記録 |

## 3. 撮影状態（captured / reviewed-by-agent）

| 項目 | 状態 |
|---|---|
| SHOT-01〜12 実撮影（R3・同一run群 07-08-06） | CAPTURED（12/12・再現画像なし・全場面の成立条件を実測確認） |
| 画像内容の目視点検 | VERIFIED（撮影者が全枚をclaimと照合・secret無し） |
| メタデータ shot-manifest | VERIFIED（run/hash/変換・slide_ready記録） |
| スライド用 slide-ready 12枚 | DONE（rawから変換のみ・端末は86px crop） |
| セッション証拠（SHOT-05/06/09/11） | VERIFIED（session-*.json保存・stub使用明記） |
| **講師(人間)による最終レビュー** | **PENDING** |

## 4. 納品物

- `assets/index.html` — ローカル素材一覧（12場面・オフライン・証拠実リンク）
- `assets/SCREENSHOT_INDEX.md` / `shot-manifest.json` / `slide-transform.json` / `capture-runs.json`
- `docs/` ENVIRONMENT・RUNBOOK・TEST_REPORT・LIMITATIONS・本書
- `demo-lock.json` — 固定版・各hashの実測
- `checksums.sha256` — 整合性
- `source/` — versions/trusted/profiles/fixtures/democtl（bin・ブラウザ・node_modulesは除外）
- `evidence/runs/` — 選別したrunの実測（private/・*.log は除外・候補hashはmanifest記録）
- `evidence/fault-injection/` — 修正前再現(r1-prefix)・修正後(r2-fixed-2)・R2検収変異の再検証(r3-mutations)
- `evidence/trials-index.json` — 納品試行の索引（session・使用モデルつき）

## 5. 未了 / 保留

| ID | 項目 | 状態 |
|---|---|---|
| LIM-01 | 他端末/他OS再現 | BLOCKED（本機のみ） |
| LIM-04 | 講師最終レビュー | PENDING |
| LIM-05 | 動画clips | 未制作（静止画で充足） |
| LIM-06 | Playwright要求rev(1200)のブラウザ未キャッシュ | 回避済（キャッシュ済1228へexecutablePathフォールバック・初回 `npx playwright install` が必要な場合あり） |

## 6. 実演後の復旧状態

- D（ガード未接続）を最終状態にしない運用をRUNBOOKに明記・`democtl recovery` で再接続検証（本版で実施済み: broken拒否・fixed許可）
- `./democtl stop` で起動プロセスを個別停止（exe絶対パス・run_dir・lstartの3点照合・所有不明は停止しない）
- 本報告時点で serve/stub/app の残存プロセスは停止済み（doctor 最終確認: ポートfree・既存設定不変）

## 7. 総括

教材は「実装済み」かつ本端末で「実機検証済み」、12場面は「実撮影済み」。
初回検収 F01〜F10 に加え、R2検収の残存5項目（証拠同一性・検査器identity・停止所有確認・ブラウザ環境・表示の実測駆動）に対応し、変異再現→修正→再検証を記録済み。
人間の講師による最終レビューのみ **PENDING** であり、完了(達成)とは記録しません。
