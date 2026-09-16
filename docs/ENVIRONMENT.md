# ENVIRONMENT — 分離方式・固定版・実測した制約

## 固定版 OpenCode

| 項目 | 値 | 実測 |
|---|---|---|
| upstream | https://github.com/anomalyco/opencode | 公式repo（default branch `dev`）|
| tag | v1.18.31 | `git describe` で確認 |
| commit | `014614d35b397775e5d397a490fc72368c894ec2` | detached clone |
| バイナリ | `bin/opencode` (darwin-arm64) | `--version` → `1.18.31` |
| sha256 | `16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198` | 実測・doctor が期待値と**照合** |
| 取得経路 | 公式GitHub Releases `opencode-darwin-arm64.zip` | monorepo全体のビルド（bun install+WebUI埋込）は重量級のため、仕様が認める同一タグの公式配布物を採用。`acquisition` を正直に記録 |
| ソース改変 | なし | `bin/` は配布物そのまま |

## 分離（既存AIDD版・業務環境に触れない）

runごとに `runs/<id>/private/` 配下へ専用領域を作り、次を設定して `bin/opencode serve` を起動:

- `HOME` / `OPENCODE_TEST_HOME` / `TMPDIR` → `private/home`, `private/tmp`
- `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` → `private/xdg-*`
- `OPENCODE_CONFIG_DIR` → `private/profile`（`profiles/{on,off,repair}` をコピー）
- `OPENCODE_DISABLE_DEFAULT_PLUGINS` / `OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE` / `OPENCODE_DISABLE_MODELS_FETCH` / `OPENCODE_DISABLE_LSP_DOWNLOAD` / `OPENCODE_DISABLE_SHARE` = `1`
- プロファイルの `opencode.json`: `share:"disabled"`, `autoupdate:false`, `enabled_providers` allowlist（ollama-local / stub-local のみ）

### 子プロセス環境は allowlist（F03対応）

serve/app/acceptance/capture の全子プロセスは `childEnv()` が作る**許可リストのみ**の環境で起動。
親の `process.env` を丸ごと継承しないため、`OPENCODE_CONFIG_CONTENT`・`ANTHROPIC_API_KEY` 等の
既存設定・認証系変数は子へ届きません。`democtl doctor` が合成マーカーを注入して漏洩がないことを
**実測**します（`12 vars allowlisted, 4 sentinels blocked`）。

実測: 起動で生成された保存先はすべて `private-runtime/` or `runs/<id>/private/` 配下。既存
`~/.config/opencode` は `trusted/baseline/existing-config.json`（1138ファイルのhash台帳）と
**毎回doctorが比較**（mtime表示ではなく実比較。baseline欠落時はUNKNOWN）。

**`OPENCODE_PURE` は使わない** — config由来プラグインも全無効化されるため、ガード（plugin）が載らないことが実ソースで確認済み。個別disableフラグで構成した。

## ガード判定の許可条件（F01対応・厳格化後）

`evaluateGateDecision` は次を**全て**満たすときのみ許可:

- 検査プロセス `exit=0`（exit≠0・timeout・signal・起動失敗は拒否。有効FAIL文書は理由をACCEPTANCE_FAILで報告）
- 文書schema妥当・`tool="acceptance"`・`case="both"` のidentity一致
- 必須case集合 app-01〜04 が**完全かつ重複なく**存在（欠落・重複・null/malformed項目は拒否）
- **全caseが個別にPASS**（aggregate PASSと個別FAILの混在は拒否）
- report-level verdict=PASS
- target hash = manifest hash一致・launch-manifest存在・candidate snapshot不変

`source/trusted/guard-source/publish-guard.ts`（本体）と `profiles/on/plugin/publish-guard.ts`（配備）は同一物。
外側検証は `source/trusted/controller/verify-core.mjs` — **実CLI `democtl verify` と試験が同一実装**を使い、
FAIL時はexit≠0。

## 実測した制約・仕様照合（v1.18.31実ソース）

- `tool.execute.before` フックはツール本体の前に発火し、throw が拒否として伝播（`packages/opencode` tools.ts:106-111）
- file plugin は `export default { id, server }` 必須（`plugin` ローダー）
- custom tool は `<config>/tool(s)/*.{ts,js}` 自動発見。`args`/`description`/`execute` のダックタイプ判定で `@opencode-ai/plugin` import不要
- `serve` は公式Web UIを `/` で提供。セッション `POST /session`, `POST /session/:id/message`、インスタンス解決は `x-opencode-directory` ヘッダ
- Web UIセッションURL: `/server/<base64url(server-url)>/session/<id>`（`/<b64(directory)>/session/<id>` はlegacy redirect）
- 公式Web UIの汎用ツール表示は `Called <tool>` 行のみ（出力は描画されない）→ モデル応答テキストに実測を出す方針で対応
- エラー時は ToolErrorCard が理由を展開表示（ガード遮断メッセージが出る）

## モデル

- **Ollama** `127.0.0.1:11434`（ローカル・外部送信なし）: `gemma4:e2b`（既定）、`gemma4:31b`（修復収束の実演記録: runs/C-2026-09-16_02-02-27）
- **stub-local** `127.0.0.1:4531`（`trusted/stub-llm/server.ts`、決定的フォールバック）: `CALL <tool> <json>` 指示でツール呼出しを1回発行、ツール実行後は実測出力をそのまま報告。`./democtl stub start|status|stop` で所有権付き管理・run-stageが自動起動
- 認証値・APIキーは一切使わない（stubのapiKey値は`"stub"`固定ダミー）
- manifest の `model_default`（既定メタ）と session 証拠の `model`（実使用）は分離して記録

## 撮影環境

- Playwright 1.57.x + Chromium 143.0.7499.4（build 1200）を `private-runtime/pw-browsers` に専用設置（既存 `~/Library/Caches/ms-playwright` は読み取りのみ・非適合revのため不使用）
- 端末: Terminal.app実窓 + `screencapture -l<CGWindowID>`（画面収録権限付与済み・Swift CGWindowList optionAll で窓ID特定）
- ブラウザshotsはheadless Chromium・viewport 1920×1080・deviceScaleFactor 1
- OpenCode画面の session は `evidence/session-*.json` に記録（run・session・tool呼出・応答）

## 残る制約

- 画面収録・Terminal自動化は本端末のTCC権限に依存（他端末へ持ち出す場合は要再付与）
- Ollamaモデルは本端末のローカル環境依存（無い場合は stub-local で動作）
