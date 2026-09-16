// demo-publish-guard — tool.execute.before フックで demo_publish を公開前検査する。
// OpenCode の plugin/ 自動発見で読み込まれる単独モジュール。
// 受入検査は trusted/acceptance の固定検査器を子プロセスで実実行し、
// 不合格・検査不能・0件・改ざんのいずれでも例外を投げてツール本体を止める。
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

const GATE = "demo-gate"
const DEMO_HASH_VERSION = "dirhash-1"
const EXCLUDE = new Set([".git", "node_modules", "runtime", "publish", "evidence", "private", ".env", ".DS_Store"])
const EXCLUDE_FILE = (name: string) =>
  name.endsWith(".log") || name.endsWith(".env") || name === "credentials.json" || name === "auth.json"

// dirhash-1: trusted/lib/hash.mjs と同一実装（このガードは単独配備されるため複写）
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

function gateEvent(runDir: string, entry: Record<string, unknown>) {
  const file = path.join(runDir, "evidence", "gate-events.jsonl")
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({ gate: GATE, at: new Date().toISOString(), ...entry }) + "\n")
}

// 必須ケース集合（受入検査器 acceptance.ts --case both と1対1対応）
const REQUIRED_CASES = ["app-01", "app-02", "app-03", "app-04"]

// 受入結果・検査プロセス終了状態・マニフェストから放行/遮断を決める純粋関数（guard.test.ts が直接検査する）
// 許可には以下を全て要求する:
//   - 検査プロセスが正常終了(exit=0, signal/timeout/起動失敗なし)
//   - 結果が正しいschema(tool=acceptance, case=both, cases[]が全て有効なオブジェクト)
//   - 必須ケース集合が一意に全件存在し、各ケースが PASS・集計 verdict=PASS
//   - 検査対象hash(target_sha256)が起動時マニフェストの候補hashと一致
// 遮断理由の優先度: 検査が完走し有効なFAIL文書を出した → ACCEPTANCE_FAIL（欠陥の実測）。
//   文書がPASSなのにプロセスが異常終了 → 矛盾なので CHECK_UNAVAILABLE（文書を信用しない）。
export function evaluateGateDecision(
  report: unknown,
  expectedHash: string,
  run: { status?: number | null; signal?: string | null; error?: unknown; timedOut?: boolean } = {},
): { allow: boolean; reason: string } {
  const runFailed = run.timedOut || run.signal || run.error || run.status !== 0
  const runWhy = run.timedOut
    ? "検査がタイムアウト"
    : run.signal
      ? `検査がシグナル終了(${run.signal})`
      : run.error
        ? `検査の起動失敗 ${String(run.error).slice(0, 120)}`
        : `検査が異常終了(exit=${run.status})`

  // --- 文書側の検証（schema・必須集合・hash・個別結果） ---
  let docFail: string | null = null
  let docReject: string | null = null
  if (!report || typeof report !== "object") {
    docReject = "CHECK_UNAVAILABLE: 検査結果なし/不正JSON"
  } else {
    const r = report as { tool?: string; case?: string; verdict?: string; cases?: unknown; target_sha256?: string }
    if (r.tool !== "acceptance" || r.case !== "both") {
      docReject = `CHECK_SCHEMA: 検査identity不一致 tool=${r.tool} case=${r.case}`
    } else if (!Array.isArray(r.cases) || r.cases.length === 0) {
      docReject = "CHECK_UNAVAILABLE: 検査ケース0件"
    } else {
      const seen = new Set<string>()
      for (const c of r.cases) {
        if (!c || typeof c !== "object") { docReject = "CHECK_SCHEMA: case要素がnull/非オブジェクト"; break }
        const cc = c as { case_id?: unknown; verdict?: unknown; expected?: unknown; actual?: unknown }
        if (typeof cc.case_id !== "string" || typeof cc.verdict !== "string" || typeof cc.expected !== "string" || typeof cc.actual !== "string") {
          docReject = `CHECK_SCHEMA: case ${String(cc.case_id)} のschema不正`; break
        }
        if (seen.has(cc.case_id)) { docReject = `CHECK_SCHEMA: case重複 ${cc.case_id}`; break }
        seen.add(cc.case_id)
      }
      if (!docReject) {
        const missing = REQUIRED_CASES.filter((c) => !seen.has(c))
        if (missing.length) docReject = `CHECK_INCOMPLETE: 必須ケース欠落 ${missing.join(",")}`
        else if (seen.size !== REQUIRED_CASES.length) docReject = "CHECK_SCHEMA: 不明なケースを含む"
        else if (r.target_sha256 !== expectedHash) docReject = `SNAPSHOT_MISMATCH: 検査対象 ${r.target_sha256} ≠ 起動時 ${expectedHash}`
        else {
          const failed = (r.cases as { case_id: string; verdict: string }[]).filter((c) => c.verdict !== "PASS")
          if (failed.length) docFail = `ACCEPTANCE_FAIL: 個別検査不合格 ${failed.map((f) => f.case_id).join(",")}`
          else if (r.verdict !== "PASS") docFail = `ACCEPTANCE_${r.verdict}: 受入検査が合格でない`
        }
      }
    }
  }

  // 有効な文書がFAILを示す → 検査は完走し欠陥を実測した（exit=3はこの受入器のFAIL契約）
  if (docFail) return { allow: false, reason: docFail }
  // プロセス異常 → 文書の内容に関わらず検査を信用しない（PASS文書+異常終了も遮断）
  if (runFailed) return { allow: false, reason: `CHECK_UNAVAILABLE: ${runWhy}` }
  if (docReject) return { allow: false, reason: docReject }
  return { allow: true, reason: "acceptance PASS (exit=0・必須4ケース全合格・identity一致)" }
}

export default {
  id: "demo-publish-guard",
  server: async () => ({
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
      if (input.tool !== "demo_publish") return

      const runDir = process.env.DEMO_RUN_DIR
      const candidate = process.env.DEMO_CANDIDATE_DIR
      const acceptance = process.env.DEMO_ACCEPTANCE
      const nodeBin = process.env.DEMO_NODE ?? "node"
      const fixtures = process.env.DEMO_FIXTURES
      const attempt = `${Date.now()}`

      if (!runDir || !candidate || !acceptance) {
        throw new Error(`${GATE}: 環境変数不足（DEMO_RUN_DIR/DEMO_CANDIDATE_DIR/DEMO_ACCEPTANCE）— 検査不能のため遮断`)
      }
      gateEvent(runDir, { phase: "start", attempt, tool: input.tool, session_id: input.sessionID, call_id: input.callID })

      const manifestPath = path.join(runDir, "evidence", "launch-manifest.json")
      if (!existsSync(manifestPath)) {
        gateEvent(runDir, { phase: "decision", attempt, decision: "blocked", reason: "launch-manifest.json なし" })
        throw new Error(`${GATE}: launch-manifest.json なし — 起動記録がないため遮断`)
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

      let actual: string
      try {
        actual = dirHash(candidate)
      } catch (e) {
        gateEvent(runDir, { phase: "decision", attempt, decision: "blocked", reason: `hash error: ${e}` })
        throw new Error(`${GATE}: 候補ハッシュ計算不能 — ${e}`)
      }
      if (actual !== manifest.candidate_sha256) {
        gateEvent(runDir, { phase: "decision", attempt, decision: "blocked", reason: `SNAPSHOT_MISMATCH manifest=${manifest.candidate_sha256} actual=${actual}` })
        throw new Error(`${GATE}: SNAPSHOT_MISMATCH — 起動時と候補が異なるため遮断`)
      }

      const outFile = path.join(runDir, "evidence", `acceptance-gate-${attempt}.json`)
      const run = spawnSync(
        nodeBin,
        [
          acceptance,
          "--target", candidate,
          "--case", "both",
          "--run-dir", runDir,
          "--out", outFile,
          "--node", nodeBin,
          ...(fixtures ? ["--fixtures", fixtures] : []),
        ],
        { encoding: "utf8", timeout: 120000 },
      )

      let report: unknown = null
      try {
        report = JSON.parse(readFileSync(outFile, "utf8"))
      } catch {
        report = null
      }
      const runResult = {
        status: run.status,
        signal: run.signal,
        error: run.error ? String(run.error) : undefined,
        timedOut: (run.error as { code?: string } | undefined)?.code === "ETIMEDOUT",
      }
      const decision = evaluateGateDecision(report, manifest.candidate_sha256, runResult)
      gateEvent(runDir, {
        phase: "decision",
        attempt,
        decision: decision.allow ? "allowed" : "blocked",
        reason: decision.reason,
        acceptance_path: outFile,
        acceptance_exit: run.status,
        acceptance_signal: run.signal ?? null,
        candidate_sha256: actual,
      })
      if (!decision.allow) {
        throw new Error(`${GATE}: ${decision.reason} — demo_publish は本体未実行で遮断されました（receiptは作成されていません）`)
      }
    },
  }),
}
