# FINAL_REPORT — 実装・実機検証・撮影の状態分離報告

日付: 2026-09-16 ／ 対象: OpenCodeデモ教材（合成・定員10名申込アプリ × 固定版 OpenCode v1.18.31）
「実装済み」「実機確認済み」「撮影済み」を分けて記録します。未了は PENDING/BLOCKED と明記。

## 1. 実装状態（implemented）

| 項目 | 状態 | 根拠 |
|---|---|---|
| 固定版 OpenCode v1.18.31 導入 | DONE | bin/opencode sha256=16c960ba…・commit 014614d3・`--version`=1.18.31 |
| 合成申込アプリ broken/fixed | DONE | source/versions/{broken,fixed}・実HTTPで10→11と409を再現 |
| 受入検査器 demo_check | DONE | trusted/acceptance・新規プロセス起動→実HTTP→4ケース実測 |
| 公開前ガード(tool.execute.before) | DONE | trusted/guard-source・file plugin形式・内部テスト8/8 |
| demo_publish(ローカルreceipt) | DONE | 外部公開なし・run配下にreceipt.jsonのみ |
| 外側検証器 runtime_probe | DONE | verify がfactから判定・無効receipt存在でFAILに修正済 |
| 分離実行 democtl | DONE | prepare/serve/prompt/app/check/unit/snapshot/verify/stop |
| 撮影ハーネス | DONE | trusted/capture（Terminal実窓 + headless Chromium） |
| 納品ツリー demo-delivery/ | DONE | 本ツリー（index/docs/evidence/lock/checksums） |

## 2. 実機検証状態（verified on real path）

| 項目 | 状態 | 実測 |
|---|---|---|
| 分離・既存環境非変更 | VERIFIED | 保存先はprivate配下のみ・~/.config/opencode mtime不変(doctor記録) |
| 単体テスト(broken) PASS | VERIFIED | 4/4・runs/*/evidence/unit-tests.txt |
| A: 単体PASSだが受入FAIL(10→11) | VERIFIED | acceptance実測・ui-state・2サイクル |
| B: ガードがdemo_publishを遮断 | VERIFIED | gate-events decision=blocked/ACCEPTANCE_FAIL・receipt無し |
| C: app/のみ修復→同一検査PASS→許可→receipt | VERIFIED | snapshot all_under_app・receipt valid・probe PASS |
| D: 未接続で通る→外側がFAIL検出 | VERIFIED | tool_called=true・gate=none・receipt=valid・probe=FAIL |
| 実モデル修復(gemma4:31b) | VERIFIED(1回) | check→read→edit→403→409へ収束。再現性は非保証(LIMITATIONS) |
| 故障注入 EVID-T01〜04 | VERIFIED | 全件PASS |
| 反復 REP-T01 | VERIFIED(2サイクル) | 8run verify scenario_match=PASS |

## 3. 撮影状態（captured / reviewed-by-agent）

| 項目 | 状態 |
|---|---|
| SHOT-01〜12 実撮影 | CAPTURED（12/12・再現画像なし） |
| 画像内容の目視点検 | VERIFIED（撮影者が全枚をclaimと照合・secret無し） |
| メタデータ shot-manifest | VERIFIED（run/subrun/hash/変換記録） |
| スライド用 slide-ready 12枚 | DONE（rawから変換のみ） |
| **講師(人間)による最終レビュー** | **PENDING** |

## 4. 納品物

- `assets/index.html` — ローカル素材一覧（12場面・オフライン）
- `assets/SCREENSHOT_INDEX.md` / `shot-manifest.json` / `trials-index.json`
- `docs/` ENVIRONMENT・RUNBOOK・TEST_REPORT・LIMITATIONS・本書
- `demo-lock.json` — 固定版・各hashの実測
- `checksums.sha256` — 整合性
- `source/` — versions/trusted/profiles/fixtures（bin・ブラウザ・node_modulesは除外）

## 5. 未了 / 保留

| ID | 項目 | 状態 |
|---|---|---|
| LIM-01 | 他端末/他OS再現 | BLOCKED（本機のみ） |
| LIM-04 | 講師最終レビュー | PENDING |
| LIM-05 | 動画clips | 未制作（静止画で充足） |

## 6. 実演後の復旧状態

- D（ガード未接続）を最終状態にしない運用をRUNBOOKに明記
- `./democtl stop` で起動プロセスを個別停止（PID記録ベース）
- 本報告時点で serve/stub/app の残存プロセスは停止済み（`democtl stop` + 個別PID停止。doctor 最終確認: ポート4530/4531 free・既存設定不変）

## 7. 総括

教材は「実装済み」かつ本端末で「実機検証済み」、12場面は「実撮影済み」。
人間の講師による最終レビューのみ **PENDING** であり、完了(達成)とは記録しません。
