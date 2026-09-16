# FINAL_REPORT — 実装・実機検証・撮影の状態分離報告（R2）

日付: 2026-09-16 ／ 対象: OpenCodeデモ教材（合成・定員10名申込アプリ × 固定版 OpenCode v1.18.31）
「実装済み」「実機確認済み」「撮影済み」を分けて記録します。未了は PENDING/BLOCKED と明記。
本版は検収レビュー（CHANGES_REQUESTED）の指摘 F01〜F10 に対応した修正版です。

## 0. 検収指摘への対応表

| ID | 指摘 | 対応 | 検証 |
|---|---|---|---|
| F01 | ガードが検査欠落・個別FAIL・異常終了を見逃す | `evaluateGateDecision` を厳格化（exit code/schema/必須case集合/重複/個別結果/identity/hashを全て許可条件に接続） | guard内部テスト15/15・fault注入10件全てblocked・陽性対照のみallowed |
| F02 | 外側検証がFAILを見つけても最終成功になる | 判定を `verify-core.mjs` に一本化。実CLI `democtl verify` が exit≠0 を返す。receipt混入・hash不一致・証拠欠落を全てFAILに | `democtl evid-test` 全件PASS（実CLI子プロセスで終了コード検査） |
| F03 | 子プロセスへ親環境の丸ごと継承 | `childEnv` allowlist化（serve/app/acceptance/capture全て）。合成マーカー4個で漏洩なしをdoctorが注入実測 | doctor: `12 vars allowlisted, 4 sentinels blocked` |
| F04 | 実モデル実行証拠の不足 | 実モデル修復run `C-2026-09-16_02-02-27` を納品（gemma4:31bのcheck→read→edit→再check・e2b試行も記録）。manifestで `model_default` と session実使用モデルを分離。stub使用を画面明記 | trials-indexの `models_used`・`real_model_sessions` 欄 |
| F05 | 撮影セッションの記録不足 | capture.mjs が session-*.json を保存（run/session/tool呼出/応答）。SHOT-05/06/09/11の証拠を納品 | 各run `evidence/session-*.json`・trials-indexで追跡 |
| F06 | doctorが比較検証になっていない | バイナリhash期待値照合・既存設定baseline manifest比較（1138ファイル）・baseline欠落時はUNKNOWN明示 | doctor: `all checks ok`・baseline比較実測 |
| F07 | 起動手順の抜け・run-ID再利用 | stub管理コマンド（start/status/stop・所有権記録）・run-stageで自動起動。run-IDは時刻+接尾辞で一意・既存ID拒否。stopは身元照合で所有プロセスのみ。D後recovery自動検証 | 同秒prepare×2で別ID・既存ID拒否・recovery OK |
| F08 | 投影素材の調整 | SHOT-01/05/06/09/10/12を作り替え（大きな件数表示・実測の分節表示・receipt非存在/hash一致の明示・FAIL/PASS2段表示）。stub使用を画面明記 | 全12枚再撮影・目視点検 |
| F09 | 証拠リンクが文字列 | index.htmlの全参照を実リンク化（`../evidence/runs/...`）。リンク解決の自動検査 | 全href/src解決OK |
| F10 | テストID・記録の整合 | TEST_REPORTのIDをP0/APP/GATE/FAULT/EV/D系に統一。demo-lock・LIMITATIONS・本書を更新 | 本表・demo-lock.json |

修正前の誤合格再現は `evidence/fault-injection/r1-prefix/` に保存（修正前コードで再現した記録）。

## 1. 実装状態（implemented）

| 項目 | 状態 | 根拠 |
|---|---|---|
| 固定版 OpenCode v1.18.31 導入 | DONE | bin/opencode sha256=16c960ba…・commit 014614d3・`--version`=1.18.31 |
| 合成申込アプリ broken/fixed | DONE | source/versions/{broken,fixed}・実HTTPで10→11と409を再現 |
| 受入検査器 demo_check | DONE | trusted/acceptance・新規プロセス起動→実HTTP→4ケース実測 |
| 公開前ガード(tool.execute.before) | DONE | trusted/guard-source・厳格判定・内部テスト15/15・実hook経路で検査不能遮断を実証 |
| demo_publish(ローカルreceipt) | DONE | 外部公開なし・run配下にreceipt.jsonのみ |
| 外側検証器 runtime_probe | DONE | verify-core.mjs共有化・実CLIがexit≠0・外部receipt/hash不一致/証拠欠落を検出 |
| 分離実行 democtl | DONE | prepare/serve/prompt/app/check/unit/snapshot/verify/fix/stub/recovery/explain/stop・子環境allowlist |
| 撮影ハーネス | DONE | trusted/capture（Terminal実窓 + headless Chromium・session証拠保存） |
| 納品ツリー demo-delivery/ | DONE | 本ツリー（index/docs/evidence/fault-injection/lock/checksums） |

## 2. 実機検証状態（verified on real path）

| 項目 | 状態 | 実測 |
|---|---|---|
| 分離・既存環境非変更 | VERIFIED | 保存先はprivate配下のみ・baseline 1138ファイル同一・子環境マーカー漏洩なし |
| 単体テスト(broken) PASS | VERIFIED | 4/4・runs/*/evidence/unit-tests.txt |
| A: 単体PASSだが受入FAIL(10→11) | VERIFIED | acceptance実測・ui-state・R2 run A-05-10-19 |
| B: ガードがdemo_publishを遮断 | VERIFIED | gate-events blocked/ACCEPTANCE_FAIL(個別case名)・receipt無し |
| C: app/のみ修復→同一検査PASS→許可→receipt | VERIFIED | snapshot all_under_app・receipt valid・hash一致・probe PASS |
| D: 未接続で通る→外側がFAIL検出 | VERIFIED | tool_called=true・gate=none・receipt=valid・probe=FAIL・intended_fault_detected=true |
| D後recovery | VERIFIED | broken拒否・fixed許可+receipt（runs/recovery-*.json） |
| 実モデル修復(gemma4:31b) | VERIFIED(1回) | runs/C-2026-09-16_02-02-27（check→edit→再checkで収束。e2b試行記録あり。再現性は非保証） |
| 合成異常系 FAULT-01〜11 | VERIFIED | 修正前:誤合格再現(r1-prefix) → 修正後:10件blocked+陽性1件allowed(r2-fixed) |
| 実CLI回帰 EV-G01/T02〜T06 | VERIFIED | 実 `democtl verify` 子プロセスの終了コードまで検査 |
| 反復 REP | VERIFIED | R2 run群 4/4 scenario_match=PASS・trials-index 47試行記録 |

## 3. 撮影状態（captured / reviewed-by-agent）

| 項目 | 状態 |
|---|---|
| SHOT-01〜12 実撮影（R2・同一run群） | CAPTURED（12/12・再現画像なし） |
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
- `evidence/runs/` — runごとの実測（private/・candidate/は除外・hashはmanifest記録）
- `evidence/fault-injection/` — 修正前再現(r1-prefix)と修正後(r2-fixed)
- `evidence/trials-index.json` — 全試行索引（分類・使用モデルつき）

## 5. 未了 / 保留

| ID | 項目 | 状態 |
|---|---|---|
| LIM-01 | 他端末/他OS再現 | BLOCKED（本機のみ） |
| LIM-04 | 講師最終レビュー | PENDING |
| LIM-05 | 動画clips | 未制作（静止画で充足） |

## 6. 実演後の復旧状態

- D（ガード未接続）を最終状態にしない運用をRUNBOOKに明記・`democtl recovery` で再接続検証
- `./democtl stop` で起動プロセスを個別停止（所有権照合・PID記録ベース）
- 本報告時点で serve/stub/app の残存プロセスは停止済み（doctor 最終確認: ポートfree・既存設定不変）

## 7. 総括

教材は「実装済み」かつ本端末で「実機検証済み」、12場面は「実撮影済み」。
検収指摘 F01〜F10 に対応し、誤合格の再現→修正→再検証を記録済み。
人間の講師による最終レビューのみ **PENDING** であり、完了(達成)とは記録しません。
