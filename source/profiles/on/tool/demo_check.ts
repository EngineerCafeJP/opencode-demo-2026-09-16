// demo_check — 合成教材用の実受付検査ツール。
// このファイルは OpenCode の tool/ 自動発見で読み込まれる単独モジュール。
// 判定ロジックは持たず、固定の受入検査器(trusted/acceptance)を子プロセス実行する。
import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

function trace(runDir: string, entry: Record<string, unknown>) {
  const file = path.join(runDir, "evidence", "tool-trace.jsonl")
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + "\n")
}

export default {
  description:
    "合成申込アプリの実受付検査を実行する。アプリを別プロセスで起動し、合成のテスト状態で実際にHTTP受付して保存人数を確認する。単体テスト(unit)も実行できる。",
  args: {
    case: {
      type: "string",
      enum: ["app-01", "app-02", "app-03", "app-04", "both", "unit"],
      description: "検査ケース。both は app-01〜04 全件。unit は候補の単体テスト。",
    },
  },
  async execute(args: { case: string }, ctx: { directory: string; sessionID: string; callID: string }) {
    const runDir = process.env.DEMO_RUN_DIR
    const acceptance = process.env.DEMO_ACCEPTANCE
    const nodeBin = process.env.DEMO_NODE ?? "node"
    const fixtures = process.env.DEMO_FIXTURES
    if (!runDir || !acceptance) throw new Error("demo_check: DEMO_RUN_DIR/DEMO_ACCEPTANCE が未設定")

    const target = ctx.directory
    trace(runDir, {
      tool: "demo_check",
      case: args.case,
      session_id: ctx.sessionID,
      call_id: ctx.callID,
      at: new Date().toISOString(),
      target,
    })

    if (args.case === "unit") {
      const testDir = path.join(target, "tests", "unit")
      const files = readdirSync(testDir)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => path.join(testDir, f))
      if (!files.length) throw new Error(`demo_check unit: ${testDir} にテストファイルなし`)
      const run = spawnSync(nodeBin, ["--test", ...files], { encoding: "utf8", timeout: 60000 })
      const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim()
      const pass = run.status === 0
      return {
        title: `unit tests ${pass ? "PASS" : "FAIL"}`,
        output: `[demo_check unit] exit=${run.status}\n${out.split("\n").slice(-25).join("\n")}`,
        metadata: { verdict: pass ? "PASS" : "FAIL" },
      }
    }

    const outFile = path.join(runDir, "evidence", `acceptance-${args.case}-${ctx.callID}.json`)
    const run = spawnSync(
      nodeBin,
      [
        acceptance,
        "--target", target,
        "--case", args.case,
        "--run-dir", runDir,
        "--out", outFile,
        "--node", nodeBin,
        ...(fixtures ? ["--fixtures", fixtures] : []),
      ],
      { encoding: "utf8", timeout: 120000 },
    )

    let verdict = "ERROR"
    let summary = ""
    try {
      const report = JSON.parse(readFileSync(outFile, "utf8"))
      verdict = report.verdict
      summary = report.cases
        .map((c: { case_id: string; verdict: string; actual: string }) => `${c.case_id}: ${c.verdict} (${c.actual})`)
        .join("\n")
    } catch {
      summary = `受入検査の結果ファイルを読めませんでした: ${outFile}`
    }

    return {
      title: `demo_check ${args.case} → ${verdict}`,
      output: `[demo_check ${args.case}] verdict=${verdict}\n対象: ${target}\n${summary}\n証拠: ${path.basename(outFile)}`,
      metadata: { verdict, evidence: outFile },
    }
  },
}
