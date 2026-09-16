// 固定受入検査: 対象候補の申込アプリを新規プロセスで起動し、実HTTPで検査する。
// このファイルは教材の「確かめる側」。対象アプリから独立して固定される。
//
// usage: node acceptance.ts --target <dir> --case app-01|app-02|app-03|app-04|both
//        [--run-dir <dir>] [--out <result.json>] [--node <nodePath>]
// exit: 0=PASS 3=FAIL 4=ERROR
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEMO_HASH_VERSION = "dirhash-1"
const EXCLUDE = new Set([".git", "node_modules", "runtime", "publish", "evidence", "private", ".env", ".DS_Store"])
const EXCLUDE_FILE = (name: string) =>
  name.endsWith(".log") || name.endsWith(".env") || name === "credentials.json" || name === "auth.json"

// dirhash-1: trusted/lib/hash.mjs と同一実装（この検査器は単独配備されるため複写）
function dirHash(root: string): string {
  const real = realpathSync(root)
  const entries: string[] = []
  walk(real, "")
  const h = createHash("sha256")
  h.update(DEMO_HASH_VERSION + "\n")
  for (const rel of entries.sort()) {
    const abs = path.join(real, rel)
    const lst = lstatSync(abs)
    if (lst.isSymbolicLink()) {
      const resolved = realpathSync(abs)
      if (resolved !== real && !resolved.startsWith(real + path.sep)) {
        throw new Error(`SYMLINK_ESCAPE: ${rel} -> ${resolved}`)
      }
    }
    h.update(rel + "\n")
    h.update(readFileSync(abs))
    h.update("\n")
  }
  return h.digest("hex")

  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      if (EXCLUDE.has(name)) continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const lst = lstatSync(abs)
      if (lst.isSymbolicLink()) {
        const resolved = realpathSync(abs)
        if (resolved !== real && !resolved.startsWith(real + path.sep)) {
          throw new Error(`SYMLINK_ESCAPE: ${rel} -> ${resolved}`)
        }
        if (statSync(abs).isDirectory()) walk(resolved, rel)
        else if (!EXCLUDE_FILE(name)) entries.push(rel)
      } else if (lst.isDirectory()) {
        walk(abs, rel)
      } else if (lst.isFile() && !EXCLUDE_FILE(name)) {
        entries.push(rel)
      }
    }
  }
}

type CaseId = "app-01" | "app-02" | "app-03" | "app-04"
type Verdict = "PASS" | "FAIL" | "ERROR"
type CaseResult = { case_id: string; expected: string; actual: string; verdict: Verdict; detail?: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const target = arg("target")
const caseSel = arg("case") ?? "both"
const runDir = arg("run-dir")
const outPath = arg("out")
const nodeBin = arg("node") ?? process.env.DEMO_NODE ?? "node"
const fixturesDir = arg("fixtures") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures")

if (!target) {
  console.error("missing --target")
  process.exit(4)
}

const base = runDir
  ? path.join(runDir, "runtime", `acc-${caseSel}-${Date.now()}`)
  : mkdtempSync(path.join(tmpdir(), "demo-acc-"))
mkdirSync(base, { recursive: true })

const stateFile = path.join(base, "state.json")
const startedAt = new Date().toISOString()
const results: CaseResult[] = []
let serverLog = ""

function seed(fixture: string) {
  copyFileSync(path.join(fixturesDir, fixture), stateFile)
}

function readCount(): number {
  return JSON.parse(readFileSync(stateFile, "utf8")).registrations.length
}

async function http(url: string, method = "GET") {
  const res = await fetch(url, { method })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" }
}

async function startServer(): Promise<{ port: number; stop: () => void }> {
  const child = spawn(nodeBin, [path.join(target, "app", "server.ts")], {
    env: {
      ...process.env,
      DEMO_STATE_FILE: stateFile,
      DEMO_PORT: "0",
      DEMO_SUBRUN_ID: `acc-${caseSel}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 15000)
    let buf = ""
    child.stdout.on("data", (d) => {
      buf += d
      serverLog += d
      const m = buf.match(/READY http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.stderr.on("data", (d) => (serverLog += d))
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early code=${code} log=${serverLog.slice(-400)}`))
    })
  })
  return { port, stop: () => child.kill("SIGTERM") }
}

async function main() {
  const hash = dirHash(target)
  let server: { port: number; stop: () => void } | undefined
  const cases: CaseId[] =
    caseSel === "both" ? ["app-01", "app-02", "app-03", "app-04"] : ([caseSel] as CaseId[])

  try {
    server = await startServer()
    const url = `http://127.0.0.1:${server.port}`

    for (const c of cases) {
      try {
        if (c === "app-01") {
          const page = await fetch(`${url}/`)
          const css = await fetch(`${url}/app.css`)
          const js = await fetch(`${url}/client.js`)
          const ok =
            page.status === 200 &&
            (page.headers.get("content-type") ?? "").includes("text/html") &&
            css.status === 200 &&
            js.status === 200
          results.push({
            case_id: "app-01",
            expected: "UIが200+text/htmlで提供される",
            actual: `GET / → ${page.status}, /app.css → ${css.status}, /client.js → ${js.status}`,
            verdict: ok ? "PASS" : "FAIL",
          })
        }

        if (c === "app-02") {
          seed("empty-seat.json")
          const res = await http(`${url}/api/registrations`, "POST")
          const count = readCount()
          const ok = res.status === 201 && res.body?.count === 10 && count === 10
          results.push({
            case_id: "app-02",
            expected: "9名から1名申込 → HTTP201 → 保存10名",
            actual: `HTTP ${res.status}, body.count=${res.body?.count}, file.count=${count}`,
            verdict: ok ? "PASS" : "FAIL",
          })
        }

        if (c === "app-03") {
          seed("full.json")
          const before = readCount()
          const res = await http(`${url}/api/registrations`, "POST")
          const after = readCount()
          const ok = res.status === 409 && after === 10 && before === 10
          results.push({
            case_id: "app-03",
            expected: "満席10名で申込 → HTTP409 → 保存10名のまま",
            actual: `HTTP ${res.status}, file.count ${before}→${after}`,
            verdict: ok ? "PASS" : "FAIL",
            detail: res.status === 201 ? "満席でも受付された（known defect）" : undefined,
          })
        }

        if (c === "app-04") {
          // app-03 終了時の state をそのまま使い、サーバーを再起動して読み戻す
          server.stop()
          await new Promise((r) => setTimeout(r, 400))
          server = await startServer()
          const res = await fetch(`http://127.0.0.1:${server.port}/api/state`).then((r) => r.json())
          const fileCount = readCount()
          const ok = res.count === 10 && res.count === fileCount
          results.push({
            case_id: "app-04",
            expected: "再起動後の読み戻しで保存人数10名（永続状態と一致）",
            actual: `api.count=${res.count}, file.count=${fileCount}`,
            verdict: ok ? "PASS" : "FAIL",
          })
        }
      } catch (e) {
        results.push({
          case_id: c,
          expected: "検査が実行できる",
          actual: String(e),
          verdict: "ERROR",
        })
      }
    }
  } catch (e) {
    results.push({ case_id: "app-00", expected: "対象サーバーが起動する", actual: String(e), verdict: "ERROR" })
  } finally {
    server?.stop()
  }

  const verdict: Verdict = results.some((r) => r.verdict === "ERROR")
    ? "ERROR"
    : results.every((r) => r.verdict === "PASS") && results.length > 0
      ? "PASS"
      : "FAIL"

  const report = {
    tool: "acceptance",
    case: caseSel,
    verdict,
    target: path.resolve(target),
    target_sha256: hash,
    state_dir: base,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    cases: results,
  }
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n")
  }
  console.log(JSON.stringify(report, null, 2))
  if (!runDir) rmSync(base, { recursive: true, force: true })
  process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 3 : 4)
}

main().catch((e) => {
  console.error("ACCEPTANCE_ERROR", e)
  process.exit(4)
})
