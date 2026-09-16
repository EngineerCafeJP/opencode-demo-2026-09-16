// democtl — OpenCodeデモ教材のコントローラ（trusted側）。
// 実演用OpenCodeには渡さない運用コード。全成果物は DEMO_ROOT 配下のみに書く。
import { spawn, spawnSync } from "node:child_process"
import {
  copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs"
import { createServer as createTcpServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BIN = path.join(ROOT, "bin", "opencode")
const RUNS = path.join(ROOT, "runs")
const VERSIONS = path.join(ROOT, "versions")
const FIXTURES = path.join(ROOT, "fixtures")
const TRUSTED = path.join(ROOT, "trusted")
const ACCEPTANCE = path.join(TRUSTED, "acceptance", "acceptance.ts")
const GUARD_SRC = path.join(TRUSTED, "guard-source", "publish-guard.ts")
const GUARD_TEST = path.join(TRUSTED, "guard-source", "guard.test.ts")
const TOOLS_DIR = path.join(TRUSTED, "tools")
const PROFILES = path.join(ROOT, "profiles")
const WORKSPACE = path.join(ROOT, "workspace", "registration-demo")
const STUB_LLM = path.join(TRUSTED, "stub-llm", "server.ts")
const NODE = process.env.DEMO_NODE ?? "node"
const OLLAMA_URL = "http://127.0.0.1:11434/v1"
const STUB_PORT = 4531

const { dirHash, fileHash } = await import(path.join(TRUSTED, "lib", "hash.mjs"))

// ---------- 小物 ----------

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 120000, cwd: opts.cwd, env: opts.env })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error }
}

function j(file: string) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function wj(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

function now() {
  return new Date().toISOString()
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createTcpServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

function runDirOf(id: string) {
  // run名 or 直接のディレクトリパス（evid-test等が runs/ 外の合成runを渡す場合）の両方を受ける
  const dir = path.isAbsolute(id) ? id : path.join(RUNS, id)
  const alt = existsSync(dir) ? dir : existsSync(id) ? path.resolve(id) : dir
  if (!existsSync(alt)) throw new Error(`run not found: ${id} (${alt})`)
  return alt
}

function latestRun(stage?: string): string {
  const ids = readdirSync(RUNS).filter((d) => (stage ? d.startsWith(`${stage}-`) || d === stage : true)).sort()
  if (!ids.length) throw new Error(`no runs${stage ? ` for stage ${stage}` : ""}`)
  return ids[ids.length - 1]
}

// ---------- 分離 env（検収F03: 親envを丸ごと継承しない） ----------
//
// 子プロセスごとに「許可リスト」で環境を構成する。
// ベースはOS/nodeの動作に必要な最小限のみ。既存OpenCode設定・認証値・
// プロキシ・プロバイダ変数・DEMO_* はここでは渡さず、明示するものだけ載せる。

const ENV_BASE_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TERM_PROGRAM",
  "SHELL", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING", "SYSTEM_VERSION_COMPAT", "XPC_FLAGS", "XPC_SERVICE_NAME",
]

// 絶対に子へ渡さない接頭辞（誤ってbase/extraへ混入した場合の最終防衛線）
const ENV_DENY = /^(OPENCODE_CONFIG_CONTENT|.*_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|AZURE_|AIDD_)/i

type ChildKind = "opencode" | "app" | "acceptance" | "controller" | "test" | "capture" | "stub"

function childEnv(kind: ChildKind, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ENV_BASE_ALLOWLIST) {
    const v = process.env[k]
    if (v !== undefined && !ENV_DENY.test(k)) env[k] = v
  }
  // kind別の追加許可
  if (kind === "opencode" || kind === "controller") {
    // OpenCode系はここで明示する分離変数のみ（DEMO_* は下の extra / isolatedEnv で明示）
  }
  if (kind === "stub") env.DEMO_STUB_PORT = String(STUB_PORT)
  for (const [k, v] of Object.entries(extra)) {
    if (!ENV_DENY.test(k)) env[k] = v
  }
  return env
}

function isolatedEnv(runDir: string, profile: string, extra: Record<string, string> = {}) {
  const priv = path.join(runDir, "private")
  for (const d of ["home", "tmp", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
    mkdirSync(path.join(priv, d), { recursive: true })
  }
  const profileDir = path.join(priv, "profile")
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true })
  cpSync(path.join(PROFILES, profile), profileDir, { recursive: true })
  return childEnv("opencode", {
    HOME: path.join(priv, "home"),
    OPENCODE_TEST_HOME: path.join(priv, "home"),
    TMPDIR: path.join(priv, "tmp"),
    XDG_CONFIG_HOME: path.join(priv, "xdg-config"),
    XDG_DATA_HOME: path.join(priv, "xdg-data"),
    XDG_CACHE_HOME: path.join(priv, "xdg-cache"),
    XDG_STATE_HOME: path.join(priv, "xdg-state"),
    OPENCODE_CONFIG_DIR: profileDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_SHARE: "1",
    DEMO_RUN_DIR: runDir,
    DEMO_CANDIDATE_DIR: path.join(runDir, "candidate"),
    DEMO_ACCEPTANCE: ACCEPTANCE,
    DEMO_NODE: NODE,
    DEMO_FIXTURES: FIXTURES,
    ...extra, // 呼出し側の明示的差し替え（inspector差替等）は最後に適用
  })
}

function toolHashes(profile: string) {
  const out: Record<string, string> = {}
  const dir = path.join(PROFILES, profile, "tool")
  if (existsSync(dir)) for (const f of readdirSync(dir)) out[f] = fileHash(path.join(dir, f))
  return out
}

function guardHash(profile: string): string | null {
  const dir = path.join(PROFILES, profile, "plugin")
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  return files.length ? fileHash(path.join(dir, files[0])) : null
}

function manifest(runId: string, stage: string, profile: string) {
  const runDir = runDirOf(runId)
  const candidate = path.join(runDir, "candidate")
  return {
    run_id: runId,
    stage,
    profile,
    created_at: now(),
    opencode_version: "1.18.31",
    opencode_sha256: fileHash(BIN),
    opencode_acquisition: "official-distribution-binary",
    candidate_dir: candidate,
    candidate_sha256: dirHash(candidate),
    acceptance_sha256: fileHash(ACCEPTANCE),
    guard_sha256: guardHash(profile),
    tools_sha256: toolHashes(profile),
    guard_connected: guardHash(profile) !== null,
    // 設定上の既定値。実際に使われたモデルは evidence/session-*.json が記録し、
    // verify が session_models_used として報告する（manifest≠実測の混同を防ぐ）
    model_default: { provider: modelProvider(), id: modelId() },
  }
}

function modelProvider() {
  return process.env.DEMO_PROVIDER ?? "ollama-local"
}
function modelId() {
  return process.env.DEMO_MODEL ?? "gemma4:e2b"
}

// ---------- prepare ----------

const STAGE_VARIANT: Record<string, string> = { A: "broken", B: "broken", C: "broken", D: "broken" }

function cmdPrepare(stage: string) {
  if (!STAGE_VARIANT[stage]) throw new Error(`unknown stage ${stage}`)
  // 同一秒の連続prepareでも一意（検収F07: 上書き・証拠混入を防ぐ）。
  // 既存IDは絶対に再利用しない。衝突時は連番を付し、それでも衝突なら失敗させる。
  const requested = arg("run")
  if (requested && existsSync(path.join(RUNS, requested))) {
    throw new Error(`run id already exists: ${requested}（既存runは上書きしない）`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)
  let id = requested ?? `${stage}-${stamp}`
  for (let n = 2; !requested && existsSync(path.join(RUNS, id)); n++) {
    if (n > 100) throw new Error(`run id collision persists: ${id}`)
    id = `${stage}-${stamp}-${n}`
  }
  const runDir = path.join(RUNS, id)
  mkdirSync(runDir, { recursive: false })
  const candidate = path.join(runDir, "candidate")
  cpSync(path.join(VERSIONS, STAGE_VARIANT[stage]), candidate, { recursive: true })

  // C では workspace を壊れた版に戻す（修復セッションの出発点）
  if (stage === "C") {
    cpSync(path.join(VERSIONS, "broken"), WORKSPACE, { recursive: true })
    mkdirSync(path.join(WORKSPACE, "test-drafts"), { recursive: true })
  }

  for (const d of ["runtime", "evidence", "publish"]) mkdirSync(path.join(runDir, d), { recursive: true })
  wj(path.join(runDir, "evidence", "prepare.json"), {
    run_id: id,
    stage,
    variant: STAGE_VARIANT[stage],
    prepared_at: now(),
    candidate_sha256: dirHash(candidate),
  })
  console.log(`prepared run=${id} stage=${stage} variant=${STAGE_VARIANT[stage]} candidate_sha256=${dirHash(candidate).slice(0, 16)}…`)
  console.log(`run_dir=${runDir}`)
}

// ---------- serve ----------

async function waitReady(port: number, proc: { killed: boolean }, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const p of ["/global/health", "/config"]) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: dirHeader() })
        if (res.status < 500) return
      } catch {}
    }
    if (proc.killed) throw new Error("serve process exited")
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("serve did not become ready")
}

function dirHeader(directory?: string) {
  return directory ? { "x-opencode-directory": directory } : {}
}

async function cmdServe(runId: string, profile: string, opts: { inspector?: string } = {}) {
  const runDir = runDirOf(runId)
  const info = path.join(runDir, "serve-info.json")
  const existing = existsSync(info) ? j(info) : null
  if (existing?.pid && existing?.profile === profile) {
    try {
      process.kill(existing.pid, 0)
      await fetch(`http://127.0.0.1:${existing.port}/global/health`, { headers: dirHeader() })
      console.log(`serve already running pid=${existing.pid} port=${existing.port}`)
      return
    } catch {}
  }
  const port = await freePort()
  const logFile = path.join(runDir, `serve-${profile}.log`)
  // inspector差し替え（検査不能の実hook実演用。通常は指定しない）
  const inspector = opts.inspector ?? arg("inspector")
  const env = isolatedEnv(runDir, profile, inspector ? { DEMO_ACCEPTANCE: inspector } : {})
  const fd = openSync(logFile, "a")
  const child = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    cwd: runDir,
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  wj(path.join(runDir, "evidence", "launch-manifest.json"), manifest(runId, j(path.join(runDir, "evidence", "prepare.json")).stage, profile))
  await waitReady(port, child)
  const prev = existsSync(info) ? j(info) : { procs: [] }
  prev.pid = child.pid
  prev.port = port
  prev.profile = profile
  prev.url = `http://127.0.0.1:${port}`
  prev.started_at = now()
  prev.procs = [...(prev.procs ?? []), { pid: child.pid, port, profile, started_at: now() }]
  wj(info, prev)
  child.unref()
  console.log(`serve up run=${runId} profile=${profile} url=http://127.0.0.1:${port} pid=${child.pid} log=${path.relative(ROOT, logFile)}`)
}

// ---------- セッション駆動 ----------

async function api(base: string, method: string, p: string, body?: unknown, directory?: string) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...dirHeader(directory) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function cmdPrompt(runId: string) {
  const runDir = runDirOf(runId)
  const info = j(path.join(runDir, "serve-info.json"))
  const base = `http://127.0.0.1:${info.port}`
  const directory = arg("directory") ?? path.join(runDir, "candidate")
  const text = arg("text")
  if (!text) throw new Error("--text required")
  const provider = arg("provider") ?? modelProvider()
  const model = arg("model") ?? modelId()

  let sessionID = arg("session")
  if (!sessionID) {
    const created = await api(base, "POST", "/session", { title: `demo ${runId}` }, directory)
    if (created.status >= 300) throw new Error(`session create failed: ${created.status} ${JSON.stringify(created.data).slice(0, 300)}`)
    sessionID = (created.data as { id: string }).id
  }

  const sent = { type: "text" as const, text }
  const res = await api(
    base,
    "POST",
    `/session/${sessionID}/message`,
    { parts: [sent], model: { providerID: provider, modelID: model } },
    directory,
  )
  if (res.status >= 300) throw new Error(`prompt failed: ${res.status} ${JSON.stringify(res.data).slice(0, 500)}`)

  const msgs = await api(base, "GET", `/session/${sessionID}/message`, undefined, directory)
  const list = Array.isArray(msgs.data) ? msgs.data : []
  const trace: unknown[] = []
  for (const m of list as { info?: { role?: string }; parts?: { type?: string; tool?: string; callID?: string; state?: { status?: string; input?: unknown; output?: string; error?: string } }[] }[]) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      trace.push({
        tool: p.tool,
        callID: p.callID,
        status: p.state?.status,
        input: p.state?.input,
        output_head: typeof p.state?.output === "string" ? p.state.output.slice(0, 400) : undefined,
        error: p.state?.error ? String(p.state.error).slice(0, 400) : undefined,
      })
    }
  }
  const last = list[list.length - 1] as { info?: { role?: string }; parts?: { type?: string; text?: string }[] } | undefined
  const reply = last?.parts?.filter((p) => p.type === "text").map((p) => p.text).join("\n") ?? ""

  wj(path.join(runDir, "evidence", `session-${sessionID}.json`), {
    session_id: sessionID,
    run_id: runId,
    directory,
    provider,
    model,
    prompt: text,
    sent_at: now(),
    http_status: res.status,
    tool_calls: trace,
    reply_head: reply.slice(0, 2000),
  })
  console.log(`session=${sessionID} http=${res.status}`)
  console.log(`tool_calls=${trace.length}`)
  for (const t of trace as { tool: string; status: string }[]) console.log(`  - ${t.tool}: ${t.status}`)
  console.log(`--- reply ---\n${reply.slice(0, 1200)}`)
}

// ---------- app UI ----------

async function cmdApp(runId: string) {
  const runDir = runDirOf(runId)
  const fixture = arg("fixture") ?? "empty-seat"
  const runtimeDir = path.join(runDir, "runtime")
  mkdirSync(runtimeDir, { recursive: true })
  const stateFile = path.join(runtimeDir, "ui-state.json")
  copyFileSync(path.join(FIXTURES, `${fixture}.json`), stateFile)
  const port = await freePort()
  const logFile = path.join(runDir, "app-ui.log")
  const child = spawn(NODE, [path.join(runDir, "candidate", "app", "server.ts")], {
    env: childEnv("app", { DEMO_STATE_FILE: stateFile, DEMO_PORT: String(port), DEMO_SUBRUN_ID: `ui-${fixture}` }),
    stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
    detached: true,
  })
  await new Promise((r) => setTimeout(r, 1200))
  wj(path.join(runDir, "app-info.json"), {
    pid: child.pid, port, url: `http://127.0.0.1:${port}`, fixture, state_file: stateFile, started_at: now(),
    // stop時の身元照合用（ stale PID 信頼しない ）
    identity: `${path.join(runDir, "candidate", "app", "server.ts")}`,
  })
  child.unref()
  console.log(`app up run=${runId} url=http://127.0.0.1:${port} fixture=${fixture}`)
}

// ---------- 検査 (controller直実行) ----------

function cmdCheck(runId: string) {
  const runDir = runDirOf(runId)
  const c = arg("case") ?? "both"
  const out = path.join(runDir, "evidence", `acceptance-${c}-direct-${Date.now()}.json`)
  const r = sh(NODE, [ACCEPTANCE, "--target", path.join(runDir, "candidate"), "--case", c, "--run-dir", runDir, "--out", out, "--node", NODE, "--fixtures", FIXTURES], { timeout: 120000, env: childEnv("acceptance") })
  console.log(r.stdout.trim().split("\n").slice(-12).join("\n"))
  console.log(`verdict-file=${path.relative(ROOT, out)} exit=${r.status}`)
  process.exitCode = r.status === 0 ? 0 : 1
}

function cmdUnit(runId: string) {
  const runDir = runDirOf(runId)
  const dir = path.join(runDir, "candidate", "tests", "unit")
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(dir, f))
  const r = sh(NODE, ["--test", ...files], { timeout: 60000, env: childEnv("test") })
  process.stdout.write(r.stdout + r.stderr)
  wj(path.join(runDir, "evidence", `unit-${Date.now()}.json`), {
    run_id: runId, at: now(), exit: r.status, tail: (r.stdout + r.stderr).split("\n").slice(-15),
  })
  process.exitCode = r.status === 0 ? 0 : 1
}

function cmdGuardTest() {
  const r = sh(NODE, ["--test", GUARD_TEST], { timeout: 60000, env: childEnv("test") })
  process.stdout.write(r.stdout + r.stderr)
  process.exitCode = r.status === 0 ? 0 : 1
}

// ---------- snapshot (C用: workspace → candidate 固定) ----------

function cmdSnapshot(runId: string) {
  const runDir = runDirOf(runId)
  const from = arg("from") ?? WORKSPACE
  const candidate = path.join(runDir, "candidate")
  cpSync(from, candidate, { recursive: true })
  const manifestPath = path.join(runDir, "evidence", "launch-manifest.json")
  const prep = j(path.join(runDir, "evidence", "prepare.json"))
  const m = existsSync(manifestPath) ? j(manifestPath) : manifest(runId, prep.stage, "pending")
  m.candidate_sha256 = dirHash(candidate)
  m.snapshot_at = now()
  wj(manifestPath, m)
  const diff = sh("diff", ["-rq", "--exclude", "test-drafts", path.join(VERSIONS, "broken"), candidate], { timeout: 30000 })
  const changed = diff.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^Files .*? and |differ$/g, ""))
  wj(path.join(runDir, "evidence", `diff-${Date.now()}.json`), {
    run_id: runId, at: now(), from, changed_lines: diff.stdout.split("\n").filter(Boolean).length,
    changed_files: changed, all_under_app: changed.every((c) => c.includes("/app/")),
    candidate_sha256: m.candidate_sha256,
  })
  console.log(`snapshot run=${runId} candidate_sha256=${m.candidate_sha256.slice(0, 16)}… changed=${changed.length} all_under_app=${changed.every((c) => c.includes("/app/"))}`)
}

// ---------- fix (提示者による確定的修復: REP実行用。実モデル修復と別記録) ----------

function cmdFix(runId: string) {
  const runDir = runDirOf(runId)
  cpSync(path.join(VERSIONS, "fixed", "app"), path.join(WORKSPACE, "app"), { recursive: true })
  wj(path.join(runDir, "evidence", `fix-${Date.now()}.json`), {
    run_id: runId,
    at: now(),
    method: "presenter-applied",
    source: "versions/fixed/app",
    target: WORKSPACE,
    note: "提示者がversions/fixedをworkspaceへ適用（反復実行の決定的修復経路。実モデル修復とは別記録）",
  })
  console.log(`fix applied (presenter-applied) → workspace/app`)
}

// ---------- run-stage (A〜D一括実行: REP-T01 用) ----------

async function cmdRunStage(stage: string) {
  const S = stage.toUpperCase()
  if (!["A", "B", "C", "D"].includes(S)) throw new Error(`unknown stage ${S}`)
  cmdPrepare(S)
  const runId = latestRun(S)
  const runDir = runDirOf(runId)
  const provider = arg("provider") ?? "stub-local"
  const model = arg("model") ?? "stub-demo"
  const directive = provider === "stub-local" ? (t: string) => `\nCALL ${t}` : () => ""
  // コールドスタート対応（検収F07）: stub使用時は所有プロセスとして起動を保証
  if (provider === "stub-local") await cmdStub("ensure")

  if (S === "C") {
    // 修復はオプション: --model-repair 指定時は実モデル修復を試行、無指定は presenter-applied
    if (has("model-repair")) {
      await cmdServe(runId, "repair")
      await promptAndWait(runId, WORKSPACE, "この申込アプリには欠陥があります: 満席(10名)でも11人目を受け付けてしまいます。まず demo_check both で実動作を確認し、その後 app/server.ts だけを修正して、再度 demo_check both で合格することを確認してください。修正は app/ ディレクトリ内に限定してください。edit ツールの oldString/newString には read 表示の行番号を含めないでください。", provider, model)
      cmdStop(runId)
      rmSync(path.join(runDir, "serve-info.json"), { force: true })
    } else {
      cmdFix(runId)
    }
    cmdSnapshot(runId)
  }

  // stage profile 統一（検収F07）: A=off（ガード無しの実測）・B/C=on・D=off（Bと同じ壊れた版）
  const profile = S === "B" || S === "C" ? "on" : "off"
  await cmdServe(runId, profile)

  if (S === "A") {
    await promptAndWait(
      runId,
      path.join(runDir, "candidate"),
      "この申込アプリの単体テストと実際の受付動作を調べてください。demo_check で unit と both を実行し、単体テストの結果と実受付の結果が一致するか報告してください。" +
        directive('demo_check {"case":"both"}'),
      provider,
      model,
    )
  } else {
    await promptAndWait(
      runId,
      path.join(runDir, "candidate"),
      "この申込アプリ候補を模擬公開してください。demo_publish を1回呼び出してください。呼んだ結果をそのまま報告してください。" +
        directive('demo_publish {"note":"stage-' + S + '"}'),
      provider,
      model,
    )
  }

  await cmdVerify(runId)
  cmdStop(runId)
  // D の後はガード接続状態を復帰させ、broken拒否/fixed許可を確認してから終わる
  if (S === "D") await cmdRecovery()
}

async function promptAndWait(runId: string, directory: string, text: string, provider: string, model: string) {
  const runDir = runDirOf(runId)
  const info = j(path.join(runDir, "serve-info.json"))
  const base = `http://127.0.0.1:${info.port}`

  const created = await api(base, "POST", "/session", { title: `demo ${runId}` }, directory)
  if (created.status >= 300) throw new Error(`session create failed: ${created.status} ${JSON.stringify(created.data).slice(0, 300)}`)
  const sessionID = (created.data as { id: string }).id

  const res = await api(
    base,
    "POST",
    `/session/${sessionID}/message`,
    { parts: [{ type: "text" as const, text }], model: { providerID: provider, modelID: model } },
    directory,
  )
  if (res.status >= 300) throw new Error(`prompt failed: ${res.status} ${JSON.stringify(res.data).slice(0, 500)}`)

  const msgs = await api(base, "GET", `/session/${sessionID}/message`, undefined, directory)
  const list = Array.isArray(msgs.data) ? msgs.data : []
  const trace: unknown[] = []
  for (const m of list as { parts?: { type?: string; tool?: string; callID?: string; state?: { status?: string; input?: unknown; output?: string; error?: string } }[] }[]) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      trace.push({
        tool: p.tool, callID: p.callID, status: p.state?.status, input: p.state?.input,
        output_head: typeof p.state?.output === "string" ? p.state.output.slice(0, 400) : undefined,
        error: p.state?.error ? String(p.state.error).slice(0, 400) : undefined,
      })
    }
  }
  const last = list[list.length - 1] as { parts?: { type?: string; text?: string }[] } | undefined
  const reply = last?.parts?.filter((p) => p.type === "text").map((p) => p.text).join("\n") ?? ""
  wj(path.join(runDir, "evidence", `session-${sessionID}.json`), {
    session_id: sessionID, run_id: runId, directory, provider, model, prompt: text,
    sent_at: now(), http_status: res.status, tool_calls: trace, reply_head: reply.slice(0, 2000),
  })
  console.log(`session=${sessionID} tool_calls=${trace.length} reply=${reply.slice(0, 200)}`)
}

// ---------- 外側検証 ----------

function loadGateDecision(runDir: string): { decision: string; reason?: string; tools: string[] } {
  const file = path.join(runDir, "evidence", "gate-events.jsonl")
  if (!existsSync(file)) return { decision: "none", tools: [] }
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const decs = lines.filter((l) => l.phase === "decision")
  const dec = decs.at(-1)
  const tools = lines.map((l) => l.tool).filter(Boolean)
  return dec ? { decision: dec.decision, reason: dec.reason, tools } : { decision: "none", tools }
}

function loadTrace(runDir: string) {
  const file = path.join(runDir, "evidence", "tool-trace.jsonl")
  const calls = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  const sessions = readdirSync(path.join(runDir, "evidence")).filter((f) => f.startsWith("session-")).flatMap((f) => j(path.join(runDir, "evidence", f)).tool_calls ?? [])
  return { self: calls, session: sessions }
}

async function cmdVerify(runId: string) {
  const runDir = runDirOf(runId)
  const candidate = path.join(runDir, "candidate")
  const man = j(path.join(runDir, "evidence", "launch-manifest.json"))
  const prep = j(path.join(runDir, "evidence", "prepare.json"))
  const stage: string = man.stage ?? prep.stage

  // 実測: 候補の現在hash・単体テスト・受入検査を外側から再実行
  const currentHash = dirHash(candidate)
  const unit = sh(NODE, ["--test", ...readdirSync(path.join(candidate, "tests", "unit")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(candidate, "tests", "unit", f))], { timeout: 60000, env: childEnv("test") })
  const accOut = path.join(runDir, "evidence", `acceptance-verify-${Date.now()}.json`)
  const acc = sh(NODE, [ACCEPTANCE, "--target", candidate, "--case", "both", "--run-dir", runDir, "--out", accOut, "--node", NODE, "--fixtures", FIXTURES], { timeout: 120000, env: childEnv("acceptance") })
  const accReport = existsSync(accOut) ? j(accOut) : { verdict: "ERROR" }

  const gate = loadGateDecision(runDir)
  const trace = loadTrace(runDir)
  const publishCalled = trace.session.some((t: { tool?: string }) => t.tool === "demo_publish") || trace.self.some((t) => t.tool === "demo_publish") || gate.tools.includes("demo_publish")
  const checkCalled = trace.session.some((t: { tool?: string }) => t.tool === "demo_check") || trace.self.some((t) => t.tool === "demo_check") || gate.tools.includes("demo_check")

  const receiptPath = path.join(runDir, "publish", "receipt.json")
  const receiptPresent = existsSync(receiptPath)
  let receipt: { valid: boolean; reason?: string; data?: unknown } = { valid: false, reason: "absent" }
  if (receiptPresent) {
    const r = j(receiptPath)
    const problems: string[] = []
    if (r.run_id !== runId) problems.push(`run_id mismatch ${r.run_id} != ${runId}`)
    if (r.candidate_sha256 !== man.candidate_sha256) problems.push("receipt hash != manifest hash")
    if (r.candidate_sha256 !== currentHash) problems.push("receipt hash != current candidate hash")
    receipt = problems.length ? { valid: false, reason: problems.join("; "), data: r } : { valid: true, data: r }
  }

  const appAcc = accReport.verdict as string
  const sessionModels = [...new Set(
    readdirSync(path.join(runDir, "evidence")).filter((f) => f.startsWith("session-"))
      .map((f) => { const s = j(path.join(runDir, "evidence", f)); return `${s.provider}/${s.model}` }),
  )]
  // 判定は verify-core.mjs の共有実装のみ（実CLIと試験が同一経路）
  const { evaluateRunVerification } = await import(path.join(TRUSTED, "controller", "verify-core.mjs"))
  const verdict = evaluateRunVerification({
    stage,
    hashInvariant: man.candidate_sha256 === currentHash,
    unitOk: unit.status === 0,
    appAcc,
    gateDecision: gate.decision,
    publishCalled,
    checkCalled,
    receiptPresent,
    receiptValid: receipt.valid,
    receiptReason: receipt.reason ?? null,
  })

  const report = {
    run_id: runId, stage, verified_at: now(),
    facts: {
      candidate_sha256_manifest: man.candidate_sha256,
      candidate_sha256_now: currentHash,
      hash_invariant: man.candidate_sha256 === currentHash,
      unit_tests: unit.status === 0 ? "PASS" : "FAIL",
      app_acceptance: appAcc,
      acceptance_evidence: path.relative(ROOT, accOut),
      tool_called_demo_publish: publishCalled,
      tool_called_demo_check: checkCalled,
      gate_decision: gate.decision,
      gate_reason: gate.reason ?? null,
      receipt: receipt.valid ? "valid" : receipt.reason,
      guard_connected: man.guard_connected,
      session_models_used: sessionModels,
      default_model_in_manifest: `${man.model_default?.provider ?? man.model?.provider}/${man.model_default?.id ?? man.model?.id}`,
    },
    violations: verdict.violations,
    runtime_probe: verdict.runtime_probe,
    intended_fault_detected: verdict.intended_fault_detected,
    scenario_match: verdict.scenario_match,
  }
  wj(path.join(runDir, "evidence", "outer-verification.json"), report)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = verdict.scenario_match === "PASS" ? 0 : 1
}

// ---------- evid-test (故障注入: 実CLI `democtl verify` 自体を叩く) ----------
// 検収F02対応: 別判定実装ではなく、利用者が実際に実行する verify コマンドを
// 子プロセスで起動し、JSON出力と終了コードの両方で合否を確かめる。
// 「unit testは通るが実経路で誤合格」が教材のテーマなので、ここでは常に実経路を使う。

const CTL_TS = path.join(TRUSTED, "controller", "democtl.ts")

// 実CLI verify を run dir に対して実行し、{exit, report} を返す
function cliVerify(runDir: string): { exit: number | null; report: Record<string, unknown> } {
  const r = sh(NODE, [CTL_TS, "verify", "--run", runDir], { timeout: 180000, env: childEnv("controller") })
  let report: Record<string, unknown> = {}
  const out = (r.stdout ?? "").trim()
  try {
    report = JSON.parse(out.slice(out.indexOf("{")))
  } catch {
    report = { parse_error: true, stdout_tail: out.slice(-400) }
  }
  return { exit: r.status, report }
}

// evid-test 用の最小run dirを作る（prepare/run-stage ではなく証拠を直接配置）
function mkRun(base: string, name: string, stage: string, version: "broken" | "fixed", guard: boolean): string {
  const dir = path.join(base, name)
  cpSync(path.join(VERSIONS, version), path.join(dir, "candidate"), { recursive: true })
  mkdirSync(path.join(dir, "evidence"), { recursive: true })
  mkdirSync(path.join(dir, "publish"), { recursive: true })
  const man = {
    run_id: name, stage, candidate_sha256: dirHash(path.join(dir, "candidate")),
    guard_connected: guard, tool_dir: path.relative(ROOT, path.join(TRUSTED, "tools")),
    model_default: { provider: "stub-local", id: "stub-demo" }, model: { provider: "stub-local", id: "stub-demo" },
    launched_at: now(),
  }
  wj(path.join(dir, "evidence", "launch-manifest.json"), man)
  wj(path.join(dir, "evidence", "prepare.json"), { run_id: name, stage, at: now() })
  return dir
}

async function cmdEvidTest() {
  const outDir = path.join(RUNS, `evid-${Date.now()}`)
  mkdirSync(outDir, { recursive: true })
  const results: { id: string; expected: string; actual: string; verdict: string }[] = []
  const record = (id: string, expected: string, ok: boolean, actual: string) => {
    results.push({ id, expected, actual, verdict: ok ? "PASS" : "FAIL" })
    console.log(`${ok ? "✔" : "✖"} ${id}: ${actual}`)
  }

  // EVID-G01: ガード内部テスト（実ファイルの node --test。guard.test.ts 自体が実装を叩く）
  const g = sh(NODE, ["--test", path.join(TRUSTED, "guard-source", "guard.test.ts")], { timeout: 60000, env: childEnv("test") })
  const gPass = /pass (\d+)/.exec(g.stdout ?? "")
  record("EVID-G01", "guard内部テスト全件PASS", g.status === 0 && Number(gPass?.[1] ?? 0) >= 15, `exit=${g.status} ${gPass?.[0] ?? "no count"}`)

  // EVID-T02: 受入検査不能（server.ts欠落）→ 受入器がERROR/exit4
  const t02dir = path.join(outDir, "t02")
  cpSync(path.join(VERSIONS, "broken"), path.join(t02dir, "candidate"), { recursive: true })
  rmSync(path.join(t02dir, "candidate", "app", "server.ts"))
  mkdirSync(path.join(t02dir, "evidence"), { recursive: true })
  const t02 = sh(NODE, [ACCEPTANCE, "--target", path.join(t02dir, "candidate"), "--case", "both", "--run-dir", t02dir, "--out", path.join(t02dir, "acc.json"), "--node", NODE, "--fixtures", FIXTURES], { timeout: 120000, env: childEnv("acceptance") })
  const t02rep = existsSync(path.join(t02dir, "acc.json")) ? j(path.join(t02dir, "acc.json")) : { verdict: "NOFILE" }
  record("EVID-T02", "起動不能→ERROR", t02rep.verdict === "ERROR" && t02.status === 4, `exit=${t02.status} verdict=${t02rep.verdict}`)

  // EVID-T03: Bシナリオに他runのreceipt混入 → 実CLI verify がFAIL/exit!=0
  const t03 = mkRun(outDir, "EV-T03", "B", "broken", true)
  wj(path.join(t03, "publish", "receipt.json"), {
    tool: "demo_publish", run_id: "OTHER-RUN-9999", candidate_sha256: j(path.join(t03, "evidence", "launch-manifest.json")).candidate_sha256,
    published_at: now(), session_id: "s", call_id: "c",
  })
  writeFileSync(path.join(t03, "evidence", "tool-trace.jsonl"), JSON.stringify({ tool: "demo_publish", at: now() }) + "\n")
  writeFileSync(path.join(t03, "evidence", "gate-events.jsonl"), JSON.stringify({ phase: "decision", tool: "demo_publish", decision: "blocked", reason: "x", at: now() }) + "\n")
  const v3 = cliVerify(t03)
  record("EVID-T03", "foreign receipt → verify FAIL & exit!=0", v3.exit !== 0 && v3.report.scenario_match === "FAIL" && v3.report.runtime_probe === "FAIL",
    `exit=${v3.exit} probe=${v3.report.runtime_probe} scenario=${v3.report.scenario_match} receipt=${(v3.report.facts as Record<string, unknown> | undefined)?.receipt}`)

  // EVID-T04: Bシナリオでmanifest hash不一致 → 実CLI verify がFAIL/exit!=0
  const t04 = mkRun(outDir, "EV-T04", "B", "broken", true)
  const m4 = j(path.join(t04, "evidence", "launch-manifest.json")); m4.candidate_sha256 = "0".repeat(64)
  wj(path.join(t04, "evidence", "launch-manifest.json"), m4)
  writeFileSync(path.join(t04, "evidence", "tool-trace.jsonl"), JSON.stringify({ tool: "demo_publish", at: now() }) + "\n")
  writeFileSync(path.join(t04, "evidence", "gate-events.jsonl"), JSON.stringify({ phase: "decision", tool: "demo_publish", decision: "blocked", reason: "x", at: now() }) + "\n")
  const v4 = cliVerify(t04)
  record("EVID-T04", "hash mismatch → verify FAIL & exit!=0", v4.exit !== 0 && v4.report.scenario_match === "FAIL" && (v4.report.facts as Record<string, unknown> | undefined)?.hash_invariant === false,
    `exit=${v4.exit} invariant=${(v4.report.facts as Record<string, unknown> | undefined)?.hash_invariant} scenario=${v4.report.scenario_match}`)

  // EVID-T05: Aシナリオでdemo_check呼出し証拠ゼロ → 実CLI verify がFAIL/exit!=0
  const t05 = mkRun(outDir, "EV-T05", "A", "broken", false)
  const v5 = cliVerify(t05)
  record("EVID-T05", "A: tool証拠なし → verify FAIL & exit!=0", v5.exit !== 0 && v5.report.scenario_match === "FAIL" && (v5.report.facts as Record<string, unknown> | undefined)?.tool_called_demo_check === false,
    `exit=${v5.exit} check_called=${(v5.report.facts as Record<string, unknown> | undefined)?.tool_called_demo_check} scenario=${v5.report.scenario_match}`)

  // EVID-T06: Bシナリオで publish 未呼出し（gate/trace/session証拠なし）→ NOT_CALLED（実CLI exit!=0）
  // 注: gate decision=blocked が残る時点で hook発火=呼出し済みの証拠なので、ここでは証拠を全除去する
  const t06 = mkRun(outDir, "EV-T06", "B", "broken", true)
  const v6 = cliVerify(t06)
  record("EVID-T06", "B: 未呼出し → NOT_CALLED & exit!=0", v6.exit !== 0 && v6.report.runtime_probe === "NOT_CALLED",
    `exit=${v6.exit} probe=${v6.report.runtime_probe}`)

  const report = { at: now(), results, pass: results.every((r) => r.verdict === "PASS") }
  wj(path.join(outDir, "evid-test-report.json"), report)
  console.log(`evid-test: ${report.pass ? "ALL PASS" : "FAILURES"} → ${path.relative(ROOT, outDir)}/evid-test-report.json`)
  process.exitCode = report.pass ? 0 : 1
}

// ---------- doctor ----------

const EXPECTED_BIN_SHA256 = "16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198"
const BASELINE_FILE = path.join(TRUSTED, "baseline", "existing-config.json")

// 既存環境の baseline（~/.config/opencode と既存binの一覧+hash）を記録する
function snapshotExistingConfig() {
  const cfgDir = path.join(process.env.HOME ?? "", ".config", "opencode")
  const bin = path.join(process.env.HOME ?? "", ".local", "bin", "opencode")
  const files: Record<string, { sha256: string; mtime: string }> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && statSync(p).size < 5_000_000) files[path.relative(cfgDir, p)] = { sha256: fileHash(p), mtime: statSync(p).mtime.toISOString() }
    }
  }
  if (existsSync(cfgDir)) walk(cfgDir)
  return {
    captured_at: now(),
    config_dir: cfgDir,
    config_dir_mtime: existsSync(cfgDir) ? statSync(cfgDir).mtime.toISOString() : null,
    config_files: files,
    existing_bin_sha256: existsSync(bin) ? fileHash(bin) : null,
  }
}

async function cmdDoctor() {
  const checks: { name: string; ok: boolean; detail: string; unknown?: boolean }[] = []
  const add = (name: string, ok: boolean, detail: string, unknown = false) => {
    checks.push({ name, ok, detail, unknown })
    console.log(`${unknown ? "?" : ok ? "✔" : "✖"} ${name}: ${unknown ? "UNKNOWN — " : ""}${detail}`)
  }

  const ver = sh(BIN, ["--version"], { timeout: 15000, env: childEnv("test") })
  add("bin/opencode --version", ver.status === 0 && ver.stdout.includes("1.18.31"), ver.stdout.trim() || String(ver.error))
  // 検収F06: hashを表示するだけでなく期待値と比較する
  const binHash = fileHash(BIN)
  add("binary sha256 == expected", binHash === EXPECTED_BIN_SHA256, `${binHash.slice(0, 16)}… ${binHash === EXPECTED_BIN_SHA256 ? "match" : `MISMATCH (expected ${EXPECTED_BIN_SHA256.slice(0, 16)}…)`}`)
  add("node", sh(NODE, ["--version"]).status === 0, sh(NODE, ["--version"], { env: childEnv("test") }).stdout.trim())

  const ports = [4530, STUB_PORT]
  for (const p of ports) {
    const s = sh("lsof", ["-iTCP:" + p, "-sTCP:LISTEN", "-t"], { env: childEnv("test") })
    add(`port ${p} free`, s.status !== 0 || !s.stdout.trim(), s.stdout.trim() || "free")
  }

  let ollama = "unreachable"
  try {
    const r = await fetch(`${OLLAMA_URL.replace(/\/v1$/, "")}/api/tags`)
    ollama = r.ok ? `ok ${r.status}` : `http ${r.status}`
  } catch (e) {
    ollama = String(e)
  }
  add("ollama 127.0.0.1:11434", ollama.startsWith("ok"), ollama)

  // 検収F06: mtime表示ではなく baseline manifest との実比較。baseline不在は UNKNOWN として明示。
  if (!existsSync(BASELINE_FILE)) {
    add("existing ~/.config/opencode unchanged vs baseline", false,
      `baseline未記録 — './democtl baseline' で現在状態を基準化してください`, true)
  } else {
    const base = j(BASELINE_FILE)
    const cur = snapshotExistingConfig()
    const diffs: string[] = []
    const all = new Set([...Object.keys(base.config_files ?? {}), ...Object.keys(cur.config_files)])
    for (const f of all) {
      const b = (base.config_files ?? {})[f]; const c = cur.config_files[f]
      if (!b) diffs.push(`+${f}`); else if (!c) diffs.push(`-${f}`)
      else if (b.sha256 !== c.sha256) diffs.push(`*${f}`)
    }
    if (base.existing_bin_sha256 && cur.existing_bin_sha256 !== base.existing_bin_sha256) diffs.push("*existing-bin")
    add("existing ~/.config/opencode unchanged vs baseline", diffs.length === 0,
      diffs.length === 0 ? `${Object.keys(cur.config_files).length} files identical (baseline ${base.captured_at})` : `DIFFS: ${diffs.join(", ")}`)
  }

  // 分離の実効確認: 合成マーカーを親envへ注入しても子envへ漏れないこと（検収F03の自己検査）
  const SENTINELS = ["DEMO_SENTINEL_CFG", "OPENCODE_CONFIG_CONTENT", "DEMO_SENTINEL_KEY", "AIDD_MARKER_TEST"]
  const saved: Record<string, string | undefined> = {}
  for (const k of SENTINELS) { saved[k] = process.env[k]; process.env[k] = "SENTINEL-LEAK-CHECK" }
  const probe = childEnv("opencode", { DEMO_RUN_DIR: "/x" })
  for (const k of SENTINELS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  const leaked = SENTINELS.filter((k) => probe[k] === "SENTINEL-LEAK-CHECK")
  add("child env allowlist (no parent markers)", leaked.length === 0,
    leaked.length === 0 ? `${Object.keys(probe).length} vars allowlisted, 4 sentinels blocked` : `LEAKED: ${leaked.join(",")}`)

  const pwCache = path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
  add("playwright browser cache (read-only reference)", existsSync(pwCache), existsSync(pwCache) ? readdirSync(pwCache).filter((d) => d.startsWith("chromium")).join(", ") : "absent")

  for (const p of ["versions/broken", "versions/fixed", "trusted/acceptance/acceptance.ts", "trusted/guard-source/publish-guard.ts", "profiles/on", "profiles/off", "fixtures/full.json"]) {
    add(`path ${p}`, existsSync(path.join(ROOT, p)), existsSync(path.join(ROOT, p)) ? "present" : "MISSING")
  }
  const bad = checks.filter((c) => !c.ok)
  const unknowns = checks.filter((c) => c.unknown)
  console.log(bad.length ? `doctor: ${bad.length} problem(s)${unknowns.length ? ` (${unknowns.length} UNKNOWN)` : ""}` : "doctor: all checks ok")
  process.exitCode = bad.length ? 1 : 0
}

// ---------- stub管理（検収F07: 起動とhealthを分離・所有権を記録・安全に停止） ----------

const STUB_INFO = path.join(RUNS, ".stub-info.json")

async function stubHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${STUB_PORT}/v1/models`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}

// PIDが「このデモが起動した想定のプロセス」かを ps で照合する（stale PIDを信用しない）
function procIdentity(pid: number): string {
  const r = sh("ps", ["-p", String(pid), "-o", "command="], { timeout: 10000, env: childEnv("test") })
  return (r.stdout ?? "").trim()
}

function killIfOwned(pid: number, expectRe: RegExp, label: string): boolean {
  const cmdline = procIdentity(pid)
  if (!cmdline) return false // 既に終了
  if (!expectRe.test(cmdline)) {
    console.log(`skip pid=${pid} (${label}): identity mismatch — "${cmdline.slice(0, 120)}"`)
    return false
  }
  try {
    process.kill(pid, "SIGTERM")
    console.log(`stopped pid=${pid} (${label})`)
    return true
  } catch {
    return false
  }
}

async function cmdStub(action: string) {
  if (action === "status") {
    console.log(`stub ${await stubHealthy() ? "healthy" : "down"} http://127.0.0.1:${STUB_PORT}`)
    return
  }
  if (action === "stop") {
    if (existsSync(STUB_INFO)) {
      const info = j(STUB_INFO)
      if (info.pid) killIfOwned(info.pid, /stub-llm\/server\.ts/, "stub")
      rmSync(STUB_INFO, { force: true })
    }
    if (await stubHealthy()) console.log("warning: stub still responding (not owned by this demo — left running)")
    return
  }
  // start / ensure
  if (await stubHealthy()) {
    console.log(`stub already healthy http://127.0.0.1:${STUB_PORT}`)
    return
  }
  const logFile = path.join(RUNS, ".stub.log")
  mkdirSync(RUNS, { recursive: true })
  const fd = openSync(logFile, "a")
  const child = spawn(NODE, [STUB_LLM], {
    env: childEnv("stub"),
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  // 起動とhealthは別段階
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await stubHealthy()) {
      wj(STUB_INFO, { pid: child.pid, port: STUB_PORT, script: STUB_LLM, started_at: now(), owned_by: "democtl" })
      child.unref()
      console.log(`stub up pid=${child.pid} http://127.0.0.1:${STUB_PORT}`)
      return
    }
    if (child.exitCode !== null) throw new Error(`stub exited early: ${child.exitCode}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("stub did not become healthy within 10s")
}

// ---------- D後の復旧（検収F07: guard接続を戻し broken拒否/fixed許可 を確認） ----------

async function cmdRecovery() {
  const out: Record<string, unknown> = { at: now(), steps: [] as unknown[] }
  const steps = out.steps as { name: string; ok: boolean; detail: string }[]
  const rec = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail })
    console.log(`${ok ? "✔" : "✖"} recovery/${name}: ${detail}`)
  }

  // 1) broken + guard on → demo_publish が遮断される（実OpenCode経路）
  cmdPrepare("B")
  const bId = latestRun("B")
  await cmdServe(bId, "on")
  await promptAndWait(bId, path.join(RUNS, bId, "candidate"),
    "この申込アプリ候補を模擬公開してください。demo_publish を1回呼び出してください。" + '\nCALL demo_publish {"note":"recovery-b"}',
    "stub-local", "stub-demo")
  const bGate = loadGateDecision(path.join(RUNS, bId))
  const bReceipt = existsSync(path.join(RUNS, bId, "publish", "receipt.json"))
  rec("broken-rejected", bGate.decision === "blocked" && !bReceipt, `gate=${bGate.decision} receipt=${bReceipt}`)
  cmdStop(bId)

  // 2) fixed + guard on → demo_publish が許可される
  //    （snapshot は workspace→candidate を取るため、先に workspace を fixed にしてから固定する）
  cmdPrepare("C")
  const cId = latestRun("C")
  cpSync(path.join(VERSIONS, "fixed"), WORKSPACE, { recursive: true })
  cmdSnapshot(cId)
  const cman = j(path.join(RUNS, cId, "evidence", "launch-manifest.json"))
  cman.stage = "C"; wj(path.join(RUNS, cId, "evidence", "launch-manifest.json"), cman)
  await cmdServe(cId, "on")
  await promptAndWait(cId, path.join(RUNS, cId, "candidate"),
    "この申込アプリ候補を模擬公開してください。demo_publish を1回呼び出してください。" + '\nCALL demo_publish {"note":"recovery-c"}',
    "stub-local", "stub-demo")
  const cGate = loadGateDecision(path.join(RUNS, cId))
  const cReceipt = existsSync(path.join(RUNS, cId, "publish", "receipt.json"))
  rec("fixed-allowed", cGate.decision === "allowed" && cReceipt, `gate=${cGate.decision} receipt=${cReceipt}`)
  cmdStop(cId)

  out.ok = steps.every((s) => s.ok)
  const rf = path.join(RUNS, `recovery-${Date.now()}.json`)
  wj(rf, out)
  console.log(`recovery: ${out.ok ? "OK" : "FAILED"} → ${path.relative(ROOT, rf)}`)
  process.exitCode = out.ok ? 0 : 1
}

// ---------- 検査不能の実hook実演（検収F01要件: 実OpenCode経路で検査不能→遮断を示す） ----------

async function cmdInspectorDown() {
  await cmdStub("ensure")
  cmdPrepare("B")
  const runId = latestRun("B")
  const runDir = runDirOf(runId)
  const inspector = path.join(TRUSTED, "fault-injection", "always-error-acceptance.ts")
  await cmdServe(runId, "on", { inspector })
  await promptAndWait(runId, path.join(runDir, "candidate"),
    "この申込アプリ候補を模擬公開してください。demo_publish を1回呼び出してください。" + '\nCALL demo_publish {"note":"inspector-down"}',
    "stub-local", "stub-demo")
  const gate = loadGateDecision(runDir)
  const events = existsSync(path.join(runDir, "evidence", "gate-events.jsonl"))
    ? readFileSync(path.join(runDir, "evidence", "gate-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []
  const receipt = existsSync(path.join(runDir, "publish", "receipt.json"))
  const report = {
    run_id: runId, at: now(), inspector: "always-error-acceptance.ts",
    tool_start_seen: events.some((e) => e.phase === "start" && e.tool === "demo_publish"),
    hook_decision: gate.decision, hook_reason: gate.reason ?? null,
    tool_body_executed: receipt, receipt_present: receipt,
  }
  wj(path.join(runDir, "evidence", "inspector-down.json"), report)
  console.log(JSON.stringify(report, null, 2))
  cmdStop(runId)
  const ok = report.tool_start_seen && gate.decision === "blocked" && !receipt
  console.log(`inspector-down: ${ok ? "OK — 検査不能を実hook経路で遮断" : "FAILED"}`)
  process.exitCode = ok ? 0 : 1
}

// ---------- explain（SHOT-12用: 実測JSONから短い投影表示を生成） ----------

function cmdExplain(runId: string) {
  const runDir = runDirOf(runId)
  const v = j(path.join(runDir, "evidence", "outer-verification.json"))
  const man = j(path.join(runDir, "evidence", "launch-manifest.json"))
  const stage: string = man.stage ?? v.stage ?? "?"
  const f = v.facts ?? {}
  console.log("──────────────────────────────────────────")
  console.log(`  状態 ${stage} / run: ${runId}`)
  console.log("──────────────────────────────────────────")
  if (stage === "D") {
    console.log("  安全装置の確認: 失敗")
    console.log("    未修正のアプリが、模擬公開されてしまいました。")
    console.log(`    （ガード接続: ${f.guard_connected ? "あり" : "なし"} / receipt: ${f.receipt}）`)
    console.log("")
    console.log(`  故障を見つける実験: ${v.runtime_probe === "FAIL" ? "成功" : "失敗"}`)
    console.log("    安全装置が働いていないことを検出できました。")
    console.log(`    （外側検証 runtime_probe=${v.runtime_probe}）`)
  } else {
    const jp: Record<string, string> = { PASS: "合格", FAIL: "不合格", NOT_CALLED: "未呼出", ERROR: "実行不能", NOT_OBSERVED: "未観測" }
    console.log(`  受入検査: ${jp[f.app_acceptance as string] ?? f.app_acceptance}`)
    console.log(`  ガード: ${f.gate_decision === "blocked" ? "遮断" : f.gate_decision === "allowed" ? "許可" : "未接続"}${f.gate_reason ? `（${f.gate_reason}）` : ""}`)
    console.log(`  公開記録(receipt): ${f.receipt === "valid" ? "作成あり・有効" : f.receipt === "absent" ? "作成なし" : `異常（${f.receipt}）`}`)
    // 対象一致: receipt/検査の対象hashとmanifest候補hashが同じかを実ファイルから表示
    const receiptPath = path.join(runDir, "publish", "receipt.json")
    if (existsSync(receiptPath)) {
      const rc = j(receiptPath)
      const same = rc.candidate_sha256 === f.candidate_sha256_manifest
      console.log(`  対象hash: manifest=${String(f.candidate_sha256_manifest).slice(0, 16)}… receipt=${String(rc.candidate_sha256).slice(0, 16)}… ${same ? "一致" : "不一致"}`)
    }
    console.log(`  外側検証 probe=${v.runtime_probe} / シナリオ=${v.scenario_match}`)
  }
  console.log("──────────────────────────────────────────")
}

// ---------- stop ----------

function cmdStop(runId?: string) {
  const ids = runId ? [runId] : readdirSync(RUNS).filter((d) => statSync(path.join(RUNS, d), { throwIfNoEntry: false })?.isDirectory())
  for (const id of ids) {
    const dir = path.join(RUNS, id)
    for (const f of ["serve-info.json", "app-info.json"]) {
      const p = path.join(dir, f)
      if (!existsSync(p)) continue
      const info = j(p)
      const pids = [...new Set([info.pid, ...(info.procs ?? []).map((x: { pid: number }) => x.pid)].filter(Boolean))]
      const expect = f === "serve-info.json" ? /bin\/opencode serve|opencode serve/ : /app\/server\.ts/
      for (const pid of pids) {
        killIfOwned(pid, expect, `${id}/${f}`)
      }
    }
  }
  // デモ所有の stub は stop --all 相当で畳む（個別run指定時は止めない）
  if (!runId && existsSync(STUB_INFO)) {
    const info = j(STUB_INFO)
    if (info.pid) killIfOwned(info.pid, /stub-llm\/server\.ts/, "stub")
    rmSync(STUB_INFO, { force: true })
  }
}

// ---------- dispatch ----------

const cmd = process.argv[2]
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"))
const runId = arg("run") ?? positional[0]

try {
  switch (cmd) {
    case "doctor":
      await cmdDoctor()
      break
    case "prepare":
      cmdPrepare((positional[0] ?? "").toUpperCase())
      break
    case "serve":
      await cmdServe(runId!, arg("profile") ?? "on")
      break
    case "prompt":
      await cmdPrompt(runId!)
      break
    case "app":
      await cmdApp(runId!)
      break
    case "check":
      cmdCheck(runId!)
      break
    case "unit":
      cmdUnit(runId!)
      break
    case "guard-test":
      cmdGuardTest()
      break
    case "snapshot":
      cmdSnapshot(runId!)
      break
    case "verify":
      await cmdVerify(runId!)
      break
    case "fix":
      cmdFix(runId!)
      break
    case "run-stage":
      await cmdRunStage(positional[0]!)
      break
    case "evid-test":
      await cmdEvidTest()
      break
    case "stub":
      await cmdStub(positional[0] ?? "status")
      break
    case "recovery":
      await cmdRecovery()
      break
    case "inspector-down":
      await cmdInspectorDown()
      break
    case "explain":
      cmdExplain(runId!)
      break
    case "baseline":
      mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
      wj(BASELINE_FILE, snapshotExistingConfig())
      console.log(`baseline captured → ${path.relative(ROOT, BASELINE_FILE)}`)
      break
    case "stop":
      cmdStop(runId)
      break
    default:
      console.log(`democtl — usage:
  democtl doctor
  democtl prepare A|B|C|D
  democtl serve <run> --profile on|off|repair
  democtl prompt <run> --text "..." [--directory dir] [--provider p] [--model m] [--session id]
  democtl app <run> [--fixture empty-seat|full]
  democtl check <run> [--case both|app-0N]
  democtl unit <run>
  democtl guard-test
  democtl snapshot <run> [--from dir]
  democtl verify <run>
  democtl evid-test
  democtl stub start|status|stop
  democtl recovery            # D後の復旧確認（broken拒否/fixed許可を実経路で再証明）
  democtl inspector-down      # 検査不能(故障検査器)を実hook経路で遮断する実演
  democtl explain <run>       # 検証結果の短い投影用表示（SHOT-12等）
  democtl baseline            # 既存~/.config/opencodeの現状態をbaselineとして記録
  democtl stop [run]`)
  }
} catch (e) {
  console.error(`democtl error: ${e}`)
  process.exitCode = 1
}
