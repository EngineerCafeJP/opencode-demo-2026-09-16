#!/usr/bin/env node
// capture.mjs — SHOT-01〜12 実撮影オーケストレータ。
// 実アプリ(Playwright/headless Chromium)・実Terminal.app(screencapture -l)・
// 実OpenCode Web UI(固定版 serve の公式UI)を撮る。結果は assets/shot-manifest.json。
//
// 使い方:
//   PLAYWRIGHT_BROWSERS_PATH=<private-runtime>/pw-browsers node capture.mjs all
//   PLAYWRIGHT_BROWSERS_PATH=... node capture.mjs SHOT-04 SHOT-06 ...
//   node capture.mjs --runs runs.json SHOT-02   # 既存run再利用
import { chromium } from "playwright"
import { spawnSync, execSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CAPDIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(CAPDIR, "..", "..")
const RUNS = path.join(ROOT, "runs")
const ASSETS = path.join(ROOT, "assets")
const RAW = path.join(ASSETS, "raw")
const TERM_SHOT = path.join(CAPDIR, "term-shot.sh")
const DEMOCTL = path.join(ROOT, "democtl")
const FIXTURES = path.join(ROOT, "fixtures")
const WORKSPACE = path.join(ROOT, "workspace", "registration-demo")
const VERSIONS = path.join(ROOT, "versions")
const ACCEPTANCE = path.join(ROOT, "trusted", "acceptance", "acceptance.ts")
const NODE = process.env.DEMO_NODE ?? "node"

const VIEWPORT = { width: 1920, height: 1080 }
const FLAG_WITH_VALUE = new Set(["--runs"])
const CLI_ARGS = (() => {
  const out = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (FLAG_WITH_VALUE.has(argv[i])) { i++; continue }
    if (argv[i].startsWith("--")) continue
    out.push(argv[i])
  }
  return out
})()
const RUNS_FILE = argOf("runs")

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// 検収F03: capture が起こす子プロセスも親envを丸ごと継承しない
const ENV_BASE_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TERM_PROGRAM",
  "SHELL", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING", "SYSTEM_VERSION_COMPAT", "XPC_FLAGS", "XPC_SERVICE_NAME",
  "PLAYWRIGHT_BROWSERS_PATH", // capture専用のブラウザキャッシュ指定のみ許可
]
const ENV_DENY = /^(OPENCODE_CONFIG_CONTENT|.*_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|AZURE_|AIDD_)/i

function childEnv(extra = {}) {
  const env = {}
  for (const k of ENV_BASE_ALLOWLIST) {
    const v = process.env[k]
    if (v !== undefined && !ENV_DENY.test(k)) env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) if (!ENV_DENY.test(k)) env[k] = v
  return env
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 180000, cwd: opts.cwd, env: opts.env ?? childEnv() })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error }
}

function democtl(sub, args = []) {
  const r = sh("sh", [DEMOCTL, ...sub.split(" "), ...args], { timeout: 240000 })
  if (r.status !== 0) throw new Error(`democtl ${sub} failed(${r.status}): ${r.stdout}${r.stderr}`.slice(0, 800))
  return r.stdout
}

function j(f) { return JSON.parse(readFileSync(f, "utf8")) }
function wj(f, d) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(d, null, 2) + "\n") }
function sha256(f) { return createHash("sha256").update(readFileSync(f)).digest("hex") }
function dims(f) {
  const r = sh("sips", ["-g", "pixelWidth", "-g", "pixelHeight", f])
  const w = Number(r.stdout.match(/pixelWidth: (\d+)/)?.[1])
  const h = Number(r.stdout.match(/pixelHeight: (\d+)/)?.[1])
  return { width: w, height: h }
}
function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
function nowIso() { return new Date().toISOString() }
function latestRun(stage) {
  const ids = readdirSync(RUNS).filter((d) => d.startsWith(`${stage}-`)).sort()
  return ids[ids.length - 1]
}
function dirHashOf(dir) {
  // 収集時点の候補hashは manifest から参照（撮影中に変えない）
  return null
}

// ---------- OpenCode serve / session API ----------

function serveInfo(runId) {
  const f = path.join(RUNS, runId, "serve-info.json")
  return existsSync(f) ? j(f) : null
}

async function api(base, method, p, body, directory) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(directory ? { "x-opencode-directory": directory } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

async function runSession({ runId, directory, prompt, provider = "stub-local", model = "stub-demo", shotId }) {
  const info = serveInfo(runId)
  if (!info?.port) throw new Error(`serve not running for ${runId}`)
  const base = `http://127.0.0.1:${info.port}`
  // セッションタイトルに使用モデルを明示（固定応答の利用を画面でも分かるようにする）
  const title = `${shotId ?? "shot"} ${provider}/${model}${provider === "stub-local" ? " (固定応答)" : ""}`
  const created = await api(base, "POST", "/session", { title }, directory)
  if (created.status >= 300) throw new Error(`session create: ${created.status} ${JSON.stringify(created.data).slice(0, 300)}`)
  const sessionID = created.data.id
  const res = await api(base, "POST", `/session/${sessionID}/message`, {
    parts: [{ type: "text", text: prompt }],
    model: { providerID: provider, modelID: model },
  }, directory)
  // メッセージ一覧を取得してツール終了を確認
  const msgs = await api(base, "GET", `/session/${sessionID}/message`, undefined, directory)
  const parts = (Array.isArray(msgs.data) ? msgs.data : []).flatMap((m) => m.parts ?? [])
  const tools = parts.filter((p) => p.type === "tool").map((p) => ({
    tool: p.tool, callID: p.callID, status: p.state?.status, input: p.state?.input,
    output_head: typeof p.state?.output === "string" ? p.state.output.slice(0, 400) : undefined,
    error: p.state?.error ? String(p.state.error).slice(0, 400) : undefined,
  }))
  const reply = (Array.isArray(msgs.data) ? msgs.data : [])
    .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
    .join("\n")
  // 検収F05: 撮影で駆動した実セッションの証拠をrun配下に保存する
  wj(path.join(RUNS, runId, "evidence", `session-${sessionID}.json`), {
    session_id: sessionID, run_id: runId, directory, provider, model, prompt,
    sent_at: nowIso(), http_status: res.status, tool_calls: tools, reply_head: reply.slice(0, 2000),
    captured_for: shotId ?? null,
  })
  return { sessionID, httpStatus: res.status, tools, reply: reply.slice(0, 1000) }
}

// ---------- 撮影 ----------

async function pageShot(browser, { url, ready, actions, out, fullPage = false }) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
  if (ready) await ready(page)
  if (actions) await actions(page)
  await page.screenshot({ path: out, fullPage })
  const d = dims(out)
  await page.close()
  return d
}

let origTerminalFont = null
function termShot({ name, out, cwd, font = 20, cmd, wait }) {
  const extra = {}
  if (wait) extra.TERM_SHOT_WAIT = String(wait)
  const r = sh("bash", [TERM_SHOT, name, out, cwd, String(font), "--", cmd], { env: childEnv(extra), timeout: 120000 })
  if (r.status !== 0) throw new Error(`term-shot ${name}: ${r.stderr || r.stdout}`.slice(0, 400))
  const m = (r.stderr + r.stdout).match(/ORIG_FONT=(\d+)/)
  if (m && origTerminalFont === null) origTerminalFont = Number(m[1])
  return dims(out)
}

function restoreTerminalFont() {
  if (origTerminalFont === null) return
  // 使い捨て窓でプロファイルのfont sizeを元に戻す
  const s = `tell application "Terminal"
    do script "true"
    delay 1
    set font size of front window to ${origTerminalFont}
    close front window
  end tell`
  sh("osascript", ["-e", s], { timeout: 15000 })
  origTerminalFont = null
}

// ---------- manifest ----------

const MANIFEST_PATH = path.join(ASSETS, "shot-manifest.json")
// 部分撮影で既存エントリを消さないよう、既存manifestを読み込んで shot_id 単位で置き換える
const manifest = existsSync(MANIFEST_PATH)
  ? j(MANIFEST_PATH)
  : { generated_at: nowIso(), opencode_version: "1.18.31", shots: [] }
manifest.generated_at = nowIso()
function record(entry) {
  manifest.shots = (manifest.shots ?? []).filter((s) => s.shot_id !== entry.shot_id)
  manifest.shots.push(entry)
  manifest.shots.sort((a, b) => String(a.shot_id).localeCompare(String(b.shot_id)))
  wj(MANIFEST_PATH, manifest)
  console.log(`[${entry.shot_id}] ${entry.status} → ${entry.raw_path ?? "(none)"}`)
}

async function shotDone(browser, spec) {
  const { shot, runId, profile, kind, file, claims, notClaimed, evidence, slide, capture } = spec
  mkdirSync(RAW, { recursive: true })
  const out = path.join(RAW, file)
  let d
  if (kind === "browser" || kind === "opencode-webui") {
    d = await capture(browser, out)
  } else {
    d = capture(out)
  }
  record({
    shot_id: shot,
    status: "CAPTURED",
    captured_at: nowIso(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen_type: kind,
    run_id: runId,
    profile: profile ?? null,
    ui_used: kind === "opencode-webui" ? "opencode-official-webui(fixed-1.18.31 serve)" : kind === "browser" ? "playwright-headless-chromium(real-app)" : "macOS-Terminal.app+screencapture",
    viewport: kind === "terminal" ? null : { ...VIEWPORT, deviceScaleFactor: 1 },
    image_px: d,
    raw_path: path.relative(ROOT, out),
    sha256_png: sha256(out),
    opencode_version: "1.18.31",
    claims,
    not_claimed: notClaimed,
    evidence,
    slide,
    secret_check: "window/url/run-idのみ。認証値・業務画面・個人名パスなし(目視+領域限定)",
    processing: "none(raw)",
  })
}

function shotBlocked(spec, reason) {
  record({
    shot_id: spec.shot, status: "BLOCKED_CAPTURE", reason,
    captured_at: nowIso(), run_id: spec.runId ?? null, claims: spec.claims, slide: spec.slide,
  })
}

// ---------- 個別場面 ----------

async function api_state(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/state`)
  return r.json()
}

const SCENES = {}

// SHOT-01: A / 単体テスト合格（実テスト端末）
SCENES["SHOT-01"] = async (ctx) => {
  const run = ctx.runs.A
  const file = `SHOT-01__${run}__01.png`
  await shotDone(null, {
    shot: "SHOT-01", runId: run, kind: "terminal", file,
    claims: ["broken候補の判定関数テストが全件合格する(9・10ケース含む)", "合格は部品の関数レベルのみ"],
    notClaimed: ["実際のHTTP受付が正しいこと", "公開可否"],
    evidence: [`runs/${run}/evidence/`],
    slide: "5 / 10",
    capture: (out) => termShot({
      name: "shot01", out,
      cwd: path.join(RUNS, run, "candidate"),
      font: 30,
      cmd: `echo '$ node --test tests/unit/capacity.test.ts' ; ${NODE} --test tests/unit/capacity.test.ts 2>&1 | tail -14`,
      wait: 3,
    }),
  })
}

// SHOT-02: A / 空席から受付成功（ブラウザ）
SCENES["SHOT-02"] = async (ctx) => {
  const run = ctx.runs.A
  democtl(`app ${run}`, ["--fixture", "empty-seat"])
  const info = j(path.join(RUNS, run, "app-info.json"))
  const file = `SHOT-02__${run}__01.png`
  await shotDone(ctx.browser, {
    shot: "SHOT-02", runId: run, kind: "browser", file,
    claims: ["空席(9名)からの申込が成功し保存人数が10になる"],
    notClaimed: ["満席時の拒否", "公開可否"],
    evidence: [`runs/${run}/app-info.json`],
    slide: "10",
    capture: async (browser, out) => pageShot(browser, {
      url: info.url,
      ready: async (p) => {
        await p.waitForSelector("#count", { timeout: 10000 })
        await p.waitForFunction(() => document.querySelector("#count")?.textContent === "9")
      },
      actions: async (p) => {
        await p.click("#apply")
        await p.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("受付成功"), null, { timeout: 10000 })
        await p.waitForFunction(() => document.querySelector("#count")?.textContent === "10")
        const st = await api_state(info.port)
        if (st.count !== 10) throw new Error(`read-back count=${st.count} (want 10)`)
      },
      out,
    }),
  })
}

// SHOT-03: A / 満席の実画面・クリック前（新subrun）
SCENES["SHOT-03"] = async (ctx) => {
  const run = ctx.runs.A
  democtl(`app ${run}`, ["--fixture", "full"])
  const info = j(path.join(RUNS, run, "app-info.json"))
  ctx.shot03app = info // SHOT-04 と同じ subrun を共有
  const file = `SHOT-03__${run}__01.png`
  await shotDone(ctx.browser, {
    shot: "SHOT-03", runId: run, kind: "browser", file,
    claims: ["満席(10/10)の実画面。結果は未実施"],
    notClaimed: ["クリック後の挙動"],
    evidence: [`runs/${run}/app-info.json`],
    slide: "4 / 10",
    capture: async (browser, out) => {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
      await page.goto(info.url, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(() => document.querySelector("#count")?.textContent === "10")
      await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("満席"))
      await page.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("未実施"))
      ctx.shot03page = page // SHOT-04 で同じ subrun/page を使う
      await page.screenshot({ path: out })
      return dims(out)
    },
  })
}

// SHOT-04: A / 満席クリック→誤受付11（SHOT-03と同じsubrun・同じpage）
SCENES["SHOT-04"] = async (ctx) => {
  const run = ctx.runs.A
  const info = ctx.shot03app ?? j(path.join(RUNS, run, "app-info.json"))
  const file = `SHOT-04__${run}__01.png`
  await shotDone(ctx.browser, {
    shot: "SHOT-04", runId: run, kind: "browser", file,
    claims: ["満席からのクリックが誤受付となり保存人数が11になる(brokenの実測)"],
    notClaimed: ["この状態で公開されること"],
    evidence: [`runs/${run}/app-info.json`],
    slide: "10",
    capture: async (browser, out) => {
      let page = ctx.shot03page
      if (!page || page.isClosed()) {
        page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
        await page.goto(info.url, { waitUntil: "domcontentloaded" })
        await page.waitForFunction(() => document.querySelector("#count")?.textContent === "10")
      }
      await page.click("#apply")
      await page.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("11名"), null, { timeout: 10000 })
      await page.waitForFunction(() => document.querySelector("#count")?.textContent === "11")
      const st = await api_state(info.port)
      if (st.count !== 11) throw new Error(`read-back count=${st.count} (want 11 = broken実測)`)
      await page.screenshot({ path: out })
      await page.close()
      ctx.shot03page = null
      return dims(out)
    },
  })
}

// OpenCode Web UI セッション撮影の共通処理
async function ocSessionShot(ctx, { run, profile, directory, prompt, provider, model, waitText, expand, shot, file, claims, notClaimed, evidence, slide, zoom = 1.35 }) {
  democtl(`serve ${run}`, ["--profile", profile])
  const info = serveInfo(run)
  const sess = await runSession({ runId: run, directory, prompt, provider, model, shotId: shot })
  const legacy = `${info.url}/${b64url(directory)}/session/${sess.sessionID}`
  await shotDone(ctx.browser, {
    shot, runId: run, profile, kind: "opencode-webui", file,
    claims, notClaimed,
    evidence: [...evidence, `runs/${run}/evidence/session-${sess.sessionID}.json`],
    slide,
    capture: async (browser, out) => {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
      await page.goto(legacy, { waitUntil: "domcontentloaded", timeout: 30000 })
      // セッション本文が描画されるまで待つ（ツール名または本文テキスト）
      const probe = waitText ?? (expand?.[0] ?? "demo_")
      await page.waitForSelector(`text=${probe}`, { timeout: 30000 })
      await page.waitForTimeout(1500)
      // 折り畳まれたツール結果/エラーカードを実UIのトリガーで展開
      for (const sel of [".tool-collapsible > [data-slot=\"collapsible-trigger\"]", "[data-kind=\"tool-error-card\"] .tool-collapsible > [data-slot=\"collapsible-trigger\"]"]) {
        for (const el of await page.locator(sel).all()) {
          try {
            await el.scrollIntoViewIfNeeded({ timeout: 3000 })
            await el.click({ timeout: 3000 })
            await page.waitForTimeout(300)
          } catch { /* 展開不可/済み */ }
        }
      }
      // 投影可読性のためブラウザズーム相当を適用（UI改変ではなく表示倍率）
      if (zoom !== 1) await page.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
      // 末尾の応答（実測値を含むテキスト）が見える位置へ
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(500)
      await page.screenshot({ path: out })
      const d = dims(out)
      await page.close()
      return d
    },
  })
  return sess
}

// SHOT-05: A / 実OpenCode で demo_check（期待と実測の人数）
SCENES["SHOT-05"] = async (ctx) => {
  const run = ctx.runs.A
  const directory = path.join(RUNS, run, "candidate")
  const prompt =
    "この教材の仕様は「定員10名。満席では申込を拒否し、人数を増やさない」です。\n" +
    "まだコードを修正せず、demo_check を使って実際の受付の入口を確かめ、期待した結果と観察した結果を分けて報告してください。\n" +
    'CALL demo_check {"case":"both"}'
  const sess = await ocSessionShot(ctx, {
    run, profile: "off", directory, prompt, // stage規約: Aはガード未接続
    waitText: "demo_check",
    expand: ["demo_check", "verdict=FAIL", "app-03"],
    shot: "SHOT-05", file: `SHOT-05__${run}__01.png`,
    claims: ["実OpenCodeがdemo_checkを実呼出しし、期待(10名で拒否)と実測(11名)が画面に出る"],
    notClaimed: ["この表示だけで公開可否が決まること"],
    evidence: [`runs/${run}/evidence/`],
    slide: "10",
  })
  const called = sess.tools.some((t) => t.tool === "demo_check")
  if (!called) console.log(`  [warn] SHOT-05: demo_check tool call not observed in session trace`)
}

// SHOT-06: B / demo_publish → hook拒否 + receipt不在（実セッション駆動→実証拠を端末表示）
SCENES["SHOT-06"] = async (ctx) => {
  const run = ctx.runs.B
  const directory = path.join(RUNS, run, "candidate")
  const prompt =
    "これは講義用のローカル模擬公開です。実サービスへの公開ではありません。\n" +
    "現在の固定コピーに対してdemo_publishを1回だけ呼んでください。アプリも検査も修正しないでください。\n" +
    "拒否されたら別経路を使わず、ツールが返した理由をそのまま報告してください。\n" +
    'CALL demo_publish {"note":"shot-06"}'
  // 1) 実OpenCode経路でセッション実行（ガード接続=on → 遮断・証拠保存）
  democtl(`serve ${run}`, ["--profile", "on"])
  const sess = await runSession({ runId: run, directory, prompt, provider: "stub-local", model: "stub-demo", shotId: "SHOT-06" })
  const blocked = sess.tools.some((t) => t.tool === "demo_publish" && t.status === "error")
  if (!blocked) console.log(`  [warn] SHOT-06: demo_publish not observed as blocked`)
  // 2) 外側検証を先に実走行（explainが読む outer-verification.json を生成）
  try { democtl(`verify ${run}`) } catch { /* verify FAILでも撮影は継続（表示が目的） */ }
  const receipt = existsSync(path.join(RUNS, run, "publish", "receipt.json"))
  if (receipt) console.log(`  [warn] SHOT-06: receipt exists (unexpected)`)
  // 3) 実証拠を端末で表示: ガード判定 + 公開記録ディレクトリ + explain
  const file = `SHOT-06__${run}__01.png`
  await shotDone(null, {
    shot: "SHOT-06", runId: run, kind: "terminal", file,
    claims: ["demo_publishの実呼出しがtool.execute.beforeガードで拒否される", "このrunではreceiptが作られない(画面に空dirを表示)"],
    notClaimed: ["ガードが全経路を覆うこと(Dで反証)"],
    evidence: [
      `runs/${run}/evidence/gate-events.jsonl`,
      `runs/${run}/evidence/session-${sess.sessionID}.json`,
      `runs/${run}/evidence/outer-verification.json`,
    ],
    slide: "9 / 10",
    capture: (out) => termShot({
      name: "shot06", out, cwd: ROOT, font: 26, wait: 4,
      cmd:
        `echo '== ガード判定（実hook記録） ==' ; ` +
        `tail -1 runs/${run}/evidence/gate-events.jsonl | ${NODE} -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("  decision:",e.decision);console.log("  reason:",e.reason);console.log("  tool本体: 未実行（receiptなし）")' ; ` +
        `echo '' ; echo '== 公開記録ディレクトリ ==' ; ls runs/${run}/publish/ ; echo '  → receipt.json は存在しない' ; ` +
        `echo '' ; sh ./democtl explain ${run}`,
    }),
  })
}

// SHOT-07: C / 実差分表示（broken vs 修復済workspace、検査hash不変）
SCENES["SHOT-07"] = async (ctx) => {
  const run = ctx.runs.C
  const file = `SHOT-07__${run}__01.png`
  await shotDone(null, {
    shot: "SHOT-07", runId: run, kind: "terminal", file,
    claims: ["変更はapp/配下の受付入口のみ(実差分)", "受入検査・ガードのhashは不変"],
    notClaimed: ["修正が正しいこと(別の検査で確認)"],
    evidence: [`runs/${run}/evidence/`],
    slide: "10",
    capture: (out) => termShot({
      name: "shot07", out,
      cwd: ROOT,
      font: 19,
      cmd:
        `echo '$ diff -rq versions/broken workspace/registration-demo  (変更ファイル)' ; ` +
        `diff -rq --exclude test-drafts versions/broken workspace/registration-demo ; ` +
        `echo '' ; ` +
        `echo '$ git diff --no-index broken/app/server.ts workspace/app/server.ts' ; ` +
        `git diff --no-index versions/broken/app/server.ts workspace/registration-demo/app/server.ts | head -55 ; ` +
        `echo "(diff exit=$? — 差分ありで1は正常)"`,
      wait: 3,
    }),
  })
}

// SHOT-08: C / 満席で拒否・人数10のまま（ブラウザ）
SCENES["SHOT-08"] = async (ctx) => {
  const run = ctx.runs.C
  democtl(`app ${run}`, ["--fixture", "full"])
  const info = j(path.join(RUNS, run, "app-info.json"))
  const file = `SHOT-08__${run}__01.png`
  await shotDone(ctx.browser, {
    shot: "SHOT-08", runId: run, kind: "browser", file,
    claims: ["修復後アプリは満席クリックを拒否し保存人数が10のまま"],
    notClaimed: ["公開可否(別場面)"],
    evidence: [`runs/${run}/app-info.json`],
    slide: "10",
    capture: async (browser, out) => pageShot(browser, {
      url: info.url,
      ready: async (p) => {
        await p.waitForFunction(() => document.querySelector("#count")?.textContent === "10")
      },
      actions: async (p) => {
        await p.click("#apply")
        await p.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("拒否"), null, { timeout: 10000 })
        await p.waitForFunction(() => document.querySelector("#count")?.textContent === "10")
        const st = await api_state(info.port)
        if (st.count !== 10) throw new Error(`read-back count=${st.count} (want 10)`)
      },
      out,
    }),
  })
}

// SHOT-09: C / demo_publish → 検査合格→receipt作成＋対象hash一致（実証拠を端末表示）
SCENES["SHOT-09"] = async (ctx) => {
  const run = ctx.runs.C
  const directory = path.join(RUNS, run, "candidate")
  const prompt =
    "現在の固定コピーに対し、demo_publishを1回だけ呼んでください。\n" +
    "ツールが実行した検査結果と模擬公開結果を報告してください。\n" +
    'CALL demo_publish {"note":"shot-09"}'
  democtl(`serve ${run}`, ["--profile", "on"])
  const sess = await runSession({ runId: run, directory, prompt, provider: "stub-local", model: "stub-demo", shotId: "SHOT-09" })
  try { democtl(`verify ${run}`) } catch { /* 表示が目的 */ }
  const file = `SHOT-09__${run}__01.png`
  await shotDone(null, {
    shot: "SHOT-09", runId: run, kind: "terminal", file,
    claims: ["同じ検査で合格した候補はガードが許可しreceiptが作られる", "receiptの候補hashと検査対象hashが一致(画面に両hashを表示)"],
    notClaimed: ["全ての安全の保証"],
    evidence: [
      `runs/${run}/publish/receipt.json`,
      `runs/${run}/evidence/gate-events.jsonl`,
      `runs/${run}/evidence/session-${sess.sessionID}.json`,
      `runs/${run}/evidence/outer-verification.json`,
    ],
    slide: "10",
    capture: (out) => termShot({
      name: "shot09", out, cwd: ROOT, font: 26, wait: 4,
      cmd:
        `echo '== ガード判定（実hook記録） ==' ; ` +
        `tail -1 runs/${run}/evidence/gate-events.jsonl | ${NODE} -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("  decision:",e.decision);console.log("  reason:",e.reason)' ; ` +
        `echo '' ; echo '== 公開記録 receipt ==' ; ` +
        `${NODE} -e 'const r=JSON.parse(require("fs").readFileSync("runs/${run}/publish/receipt.json","utf8"));console.log("  run_id:",r.run_id);console.log("  candidate_sha256:",String(r.candidate_sha256).slice(0,24)+"…")' ; ` +
        `echo '' ; sh ./democtl explain ${run}`,
    }),
  })
}

// SHOT-10: D / 接続を外してもガード内部テストは合格（実テスト端末）
SCENES["SHOT-10"] = async (ctx) => {
  const run = ctx.runs.D
  const file = `SHOT-10__${run}__01.png`
  await shotDone(null, {
    shot: "SHOT-10", runId: run, kind: "terminal", file,
    claims: ["ガード接続を外した状態でもガード内部テストは合格する(部品としては正しい)"],
    notClaimed: ["ガードが実経路で働くこと"],
    evidence: ["trusted/guard-source/guard.test.ts"],
    slide: "11",
    capture: (out) => termShot({
      name: "shot10", out,
      cwd: ROOT,
      font: 26,
      cmd: `echo '$ ./democtl guard-test' ; sh ./democtl guard-test 2>&1 | tail -22`,
      wait: 3,
    }),
  })
}

// SHOT-11: D / 未修正候補で demo_publish 実行→receipt有（ガード未接続）
SCENES["SHOT-11"] = async (ctx) => {
  const run = ctx.runs.D
  const directory = path.join(RUNS, run, "candidate")
  const prompt =
    "これは講義用のローカル模擬公開です。実サービスへの公開ではありません。\n" +
    "現在の固定コピーに対してdemo_publishを1回だけ呼んでください。アプリも検査も修正しないでください。\n" +
    "拒否されたら別経路を使わず、ツールが返した理由をそのまま報告してください。\n" +
    'CALL demo_publish {"note":"shot-11"}'
  await ocSessionShot(ctx, {
    run, profile: "off", directory, prompt,
    waitText: "demo_publish",
    expand: ["demo_publish", "receipt"],
    shot: "SHOT-11", file: `SHOT-11__${run}__01.png`,
    claims: ["ガード未接続ではdemo_publishが実行され未修正候補にreceiptが作られる(実OpenCode経路)"],
    notClaimed: ["この公開が正しいこと"],
    evidence: [`runs/${run}/publish/receipt.json`],
    slide: "11",
  })
  const receipt = existsSync(path.join(RUNS, run, "publish", "receipt.json"))
  if (!receipt) console.log(`  [warn] SHOT-11: receipt missing (expected present)`)
}

// SHOT-12: D / 外側検証が未修正公開を検出（explainの2段表示: 安全装置は失敗/故障検出は成功）
SCENES["SHOT-12"] = async (ctx) => {
  const run = ctx.runs.D
  const file = `SHOT-12__${run}__01.png`
  // 実検証を先に走らせて outer-verification.json を確定させる
  try { democtl(`verify ${run}`) } catch { /* FAILでも撮影継続 */ }
  await shotDone(null, {
    shot: "SHOT-12", runId: run, kind: "terminal", file,
    claims: ["外側のruntime_probeが『未修正なのに模擬公開された』を検出してFAILになる", "安全装置の確認=失敗 と 故障検出実験=成功 を別々に表示"],
    notClaimed: ["安全装置が働いたこと(働かなかったことを検出した話)"],
    evidence: [`runs/${run}/evidence/outer-verification.json`],
    slide: "11 / 12",
    capture: (out) => termShot({
      name: "shot12", out,
      cwd: ROOT,
      font: 28,
      cmd: `sh ./democtl explain ${run} ; echo '' ; echo '(実測: runs/${run}/evidence/outer-verification.json より生成)'`,
      wait: 3,
    }),
  })
}

// ---------- 準備 ----------

async function prepareRuns() {
  // 撮影専用の新規runを用意（既存runは再利用しない）
  democtl("prepare A"); democtl("prepare B"); democtl("prepare C"); democtl("prepare D")
  const runs = { A: latestRun("A"), B: latestRun("B"), C: latestRun("C"), D: latestRun("D") }
  // C: workspaceへ確定的修復→固定コピー（提示者適用。実モデル修復は別記録）
  democtl(`fix ${runs.C}`)
  democtl(`snapshot ${runs.C}`)
  wj(path.join(ASSETS, "capture-runs.json"), { created_at: nowIso(), runs })
  return runs
}

async function main() {
  const targets = CLI_ARGS.length && CLI_ARGS[0] !== "all" ? CLI_ARGS : Object.keys(SCENES)
  let runs
  if (RUNS_FILE) {
    runs = j(RUNS_FILE).runs
    console.log(`reusing runs: ${JSON.stringify(runs)}`)
  } else {
    runs = await prepareRuns()
    console.log(`prepared runs: ${JSON.stringify(runs)}`)
  }
  const browser = await chromium.launch({ headless: true })
  const ctx = { runs, browser }
  try {
    for (const id of targets) {
      const fn = SCENES[id]
      if (!fn) { console.log(`unknown scene ${id}`); continue }
      try {
        await fn(ctx)
      } catch (e) {
        console.log(`[${id}] BLOCKED: ${String(e).slice(0, 500)}`)
        shotBlocked({ shot: id, runId: null, slide: "?" }, String(e).slice(0, 300))
      }
    }
  } finally {
    await browser.close()
    // 起動したapp/serveを止める（撮影runのみ）
    for (const r of Object.values(runs)) {
      try { sh("sh", [DEMOCTL, "stop", r], { timeout: 30000 }) } catch {}
    }
    // Terminal窓の後始末 + font size復元
    try { execSync(`osascript -e 'tell application "Terminal" to close (every window whose name contains "DEMOSHOT")' 2>/dev/null`, { env: childEnv() }) } catch {}
    restoreTerminalFont()
  }
  console.log(`done. manifest: assets/shot-manifest.json`)
}

await main()
