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

// 受入結果とマニフェストから放行/遮断を決める純粋関数（guard.test.ts が直接検査する）
export function evaluateGateDecision(report: unknown, expectedHash: string): { allow: boolean; reason: string } {
  if (!report || typeof report !== "object") return { allow: false, reason: "CHECK_UNAVAILABLE: 検査結果なし" }
  const r = report as { verdict?: string; cases?: unknown[]; target_sha256?: string }
  if (!Array.isArray(r.cases) || r.cases.length === 0) {
    return { allow: false, reason: "CHECK_UNAVAILABLE: 検査ケース0件" }
  }
  if (r.target_sha256 !== expectedHash) {
    return { allow: false, reason: `SNAPSHOT_MISMATCH: 検査対象 ${r.target_sha256} ≠ 起動時 ${expectedHash}` }
  }
  if (r.verdict !== "PASS") return { allow: false, reason: `ACCEPTANCE_${r.verdict}: 受入検査が合格でない` }
  return { allow: true, reason: "acceptance PASS" }
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
      const decision = evaluateGateDecision(report, manifest.candidate_sha256)
      gateEvent(runDir, {
        phase: "decision",
        attempt,
        decision: decision.allow ? "allowed" : "blocked",
        reason: decision.reason,
        acceptance_path: outFile,
        acceptance_exit: run.status,
        candidate_sha256: actual,
      })
      if (!decision.allow) {
        throw new Error(`${GATE}: ${decision.reason} — demo_publish は本体未実行で遮断されました`)
      }
    },
  }),
}
