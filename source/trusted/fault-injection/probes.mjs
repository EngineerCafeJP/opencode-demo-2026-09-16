// fault-injection probes — 合成入力でガード判定と外側検証CLIの誤合格を検査する。
// 検収 R1 (F01/F02) の異常系をそのまま再現し、修正前は観察値、修正後は必須結果として使う。
//
// usage: node trusted/fault-injection/probes.mjs --out <dir> --expect observe|fixed
//   observe: 実際の結果を記録するだけ（修正前の再現記録用）
//   fixed:   拒否されるべき入力が本当に拒否されることを検査（回帰用）
//
// 入力はすべて合成。実モデル・外部サービス・認証値は使わない。
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const RUNS = path.join(ROOT, "runs")
const VERSIONS = path.join(ROOT, "versions")
const FIXTURES = path.join(ROOT, "fixtures")
const GUARD = path.join(ROOT, "trusted", "guard-source", "publish-guard.ts")
const DEMOCTL_TS = path.join(ROOT, "trusted", "controller", "democtl.ts")
const NODE = process.env.DEMO_NODE ?? "node"

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const OUT = arg("out") ?? path.join(ROOT, "verification", `fault-${Date.now()}`)
const EXPECT = arg("expect") ?? "observe"
mkdirSync(OUT, { recursive: true })

const { dirHash } = await import(path.join(ROOT, "trusted", "lib", "hash.mjs"))
const guard = await import(GUARD)
const { evaluateGateDecision } = guard
const hooks = await guard.default.server({})
const before = hooks["tool.execute.before"]

const results = []
const record = (id, wantBlocked, got, detail) => {
  const match = got === wantBlocked
  const ok = EXPECT === "observe" ? true : match
  results.push({ id, want: wantBlocked ? "BLOCK" : "ALLOW", got: got ? "BLOCK" : "ALLOW", pass: ok, match, detail })
  const mark = EXPECT === "observe" ? (match ? "•" : "!REPRODUCED") : ok ? "✔" : "✖"
  console.log(`${mark} ${id}: want=${wantBlocked ? "BLOCK" : "ALLOW"} got=${got ? "BLOCK" : "ALLOW"} ${detail ?? ""}`)
}

// ---------- Phase A: 判定関数への合成入力 ----------
const H = "a".repeat(64)
const fullPass = (cases) => ({
  tool: "acceptance", case: "both", verdict: "PASS", target_sha256: H,
  cases,
})
const okCase = (id) => ({ case_id: id, expected: "x", actual: "measured", verdict: "PASS" })
const ALL = ["app-01", "app-02", "app-03", "app-04"]

// A1: 必須ケース欠落（app-01のみPASS）
{
  const r = evaluateGateDecision(fullPass([okCase("app-01")]), H, { status: 0 })
  record("gate/missing-required-cases", true, !r.allow, `reason=${r.reason}`)
}
// A2: 全体PASSだが個別app-03がFAIL
{
  const rep = fullPass(ALL.map((c) => (c === "app-03" ? { ...okCase(c), verdict: "FAIL" } : okCase(c))))
  const r = evaluateGateDecision(rep, H, { status: 0 })
  record("gate/aggregate-pass-with-failing-case", true, !r.allow, `reason=${r.reason}`)
}
// A3: cases=[null]（不正schema）
{
  const r = evaluateGateDecision({ verdict: "PASS", cases: [null], target_sha256: H }, H, { status: 0 })
  record("gate/case-element-null", true, !r.allow, `reason=${r.reason}`)
}
// A4: 重複case
{
  const r = evaluateGateDecision(fullPass(["app-01", "app-01", "app-02", "app-03", "app-04"].map(okCase)), H, { status: 0 })
  record("gate/duplicate-case", true, !r.allow, `reason=${r.reason}`)
}
// A5: 子プロセス異常終了（PASS文書を出して exit=3）
{
  const r = evaluateGateDecision(fullPass(ALL.map(okCase)), H, { status: 3 })
  record("gate/exit-nonzero-after-pass-doc", true, !r.allow, `reason=${r.reason}`)
}
// A6: タイムアウト
{
  const r = evaluateGateDecision(fullPass(ALL.map(okCase)), H, { status: null, signal: "SIGTERM", timedOut: true })
  record("gate/inspector-timeout", true, !r.allow, `reason=${r.reason}`)
}
// A7: 正当な全合格（陽性対照）
{
  const r = evaluateGateDecision(fullPass(ALL.map(okCase)), H, { status: 0 })
  record("gate/valid-full-pass", false, !r.allow, `reason=${r.reason}`)
}

// ---------- Phase B: 実hook関数へ故障検査器を注入 ----------
{
  const probeDir = path.join(OUT, "hook-exit3")
  const candDir = path.join(probeDir, "candidate")
  cpSync(path.join(VERSIONS, "broken"), candDir, { recursive: true })
  mkdirSync(path.join(probeDir, "evidence"), { recursive: true })
  const candHash = dirHash(candDir)
  writeFileSync(path.join(probeDir, "evidence", "launch-manifest.json"),
    JSON.stringify({ run_id: "fault-hook-exit3", stage: "B", candidate_sha256: candHash, guard_connected: true }) + "\n")
  // PASSと見せかけて exit=3 で終わる故障検査器（合成）
  const fake = path.join(probeDir, "fake-acceptance.mjs")
  writeFileSync(fake, `
import { writeFileSync } from "node:fs"
const out = process.argv[process.argv.indexOf("--out") + 1]
writeFileSync(out, JSON.stringify({ tool:"acceptance", case:"both", verdict:"PASS", target_sha256:${JSON.stringify(candHash)},
  cases:[{case_id:"app-01",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-02",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-03",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-04",expected:"x",actual:"x",verdict:"PASS"}] }))
process.exit(3)
`)
  const saved = { ...process.env }
  process.env.DEMO_RUN_DIR = probeDir
  process.env.DEMO_CANDIDATE_DIR = candDir
  process.env.DEMO_ACCEPTANCE = fake
  process.env.DEMO_NODE = NODE
  delete process.env.DEMO_FIXTURES
  let threw = false, msg = ""
  try {
    await before({ tool: "demo_publish", sessionID: "audit-synthetic", callID: "audit-nonzero" }, { args: {} })
  } catch (e) { threw = true; msg = String(e).slice(0, 200) }
  Object.assign(process.env, saved)
  const events = readFileSync(path.join(probeDir, "evidence", "gate-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const dec = events.find((e) => e.phase === "decision")
  record("hook/nonzero-exit-after-pass-document", true, threw && dec?.decision === "blocked",
    `threw=${threw} decision=${dec?.decision} exit_seen=${dec?.acceptance_exit}`)
}

// ---------- Phase C: 実CLI `democtl verify` への合成run ----------
function synthRun(id, { stage, hash, withPublishTrace, gateDecision, receipt }) {
  const dir = path.join(RUNS, id)
  rmSync(dir, { recursive: true, force: true })
  cpSync(path.join(VERSIONS, "broken"), path.join(dir, "candidate"), { recursive: true })
  for (const d of ["evidence", "runtime", "publish"]) mkdirSync(path.join(dir, d), { recursive: true })
  writeFileSync(path.join(dir, "evidence", "prepare.json"),
    JSON.stringify({ run_id: id, stage, variant: "broken", prepared_at: new Date().toISOString(), candidate_sha256: dirHash(path.join(dir, "candidate")), synthetic: true }) + "\n")
  writeFileSync(path.join(dir, "evidence", "launch-manifest.json"),
    JSON.stringify({ run_id: id, stage, profile: "on", created_at: new Date().toISOString(),
      candidate_sha256: hash ?? dirHash(path.join(dir, "candidate")), guard_connected: true, synthetic: true }) + "\n")
  if (withPublishTrace) {
    writeFileSync(path.join(dir, "evidence", "tool-trace.jsonl"),
      JSON.stringify({ tool: "demo_publish", session_id: "synthetic", call_id: "synthetic", at: new Date().toISOString() }) + "\n")
  }
  if (gateDecision) {
    writeFileSync(path.join(dir, "evidence", "gate-events.jsonl"),
      JSON.stringify({ gate: "demo-gate", at: new Date().toISOString(), phase: "start", attempt: "s", tool: "demo_publish", session_id: "synthetic", call_id: "synthetic" }) + "\n" +
      JSON.stringify({ gate: "demo-gate", at: new Date().toISOString(), phase: "decision", attempt: "s", decision: gateDecision, reason: "synthetic", candidate_sha256: dirHash(path.join(dir, "candidate")) }) + "\n")
  }
  if (receipt) {
    writeFileSync(path.join(dir, "publish", "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  }
  return dir
}

function cliVerify(id) {
  const r = spawnSync("sh", [path.join(ROOT, "democtl"), "verify", id], { encoding: "utf8", timeout: 240000, cwd: ROOT })
  const outFile = path.join(RUNS, id, "evidence", "outer-verification.json")
  const rep = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null
  writeFileSync(path.join(OUT, `cli-${id}.stdout.txt`), `exit=${r.status}\n\n${r.stdout}\n${r.stderr}`)
  return { status: r.status, rep }
}

// C1: Bへ別runのreceipt混入 → 不合格・非ゼロ必須
{
  const id = "fault-r1-b-foreign-receipt"
  synthRun(id, { stage: "B", withPublishTrace: true, gateDecision: "blocked" })
  const candHash = dirHash(path.join(RUNS, id, "candidate"))
  writeFileSync(path.join(RUNS, id, "publish", "receipt.json"), JSON.stringify({
    tool: "demo_publish", run_id: "OTHER-RUN-9999", candidate_sha256: candHash,
    published_at: new Date().toISOString(), session_id: "x", call_id: "y",
  }, null, 2) + "\n")
  const { status, rep } = cliVerify(id)
  const blocked = status !== 0 && rep?.scenario_match === "FAIL"
  record("cli/b-foreign-receipt", true, blocked, `exit=${status} probe=${rep?.runtime_probe} scenario=${rep?.scenario_match}`)
}
// C2: manifest候補hash不一致 → 不合格必須
{
  const id = "fault-r1-b-hash-mismatch"
  synthRun(id, { stage: "B", hash: "0".repeat(64), withPublishTrace: true, gateDecision: "blocked" })
  const { status, rep } = cliVerify(id)
  const blocked = status !== 0 && rep?.scenario_match === "FAIL"
  record("cli/b-hash-mismatch", true, blocked, `exit=${status} invariant=${rep?.facts?.hash_invariant} scenario=${rep?.scenario_match}`)
}
// C3: Aでツール呼出し証拠を全除去 → 不合格(NOT_CALLED)必須
{
  const id = "fault-r1-a-no-evidence"
  synthRun(id, { stage: "A", withPublishTrace: false })
  const { status, rep } = cliVerify(id)
  const blocked = status !== 0 && rep?.scenario_match === "FAIL"
  record("cli/a-no-tool-evidence", true, blocked, `exit=${status} check_called=${rep?.facts?.tool_called_demo_check} scenario=${rep?.scenario_match}`)
}

// ---------- まとめ ----------
const report = { mode: EXPECT, at: new Date().toISOString(), note: "全入力は合成。実モデル・外部通信なし", results }
writeFileSync(path.join(OUT, "fault-report.json"), JSON.stringify(report, null, 2) + "\n")
const fails = results.filter((r) => !r.pass)
console.log(`fault-probes: ${results.length - fails.length}/${results.length} ${EXPECT === "fixed" ? "期待どおり拒否" : "観察"} → ${path.relative(ROOT, OUT)}`)
process.exitCode = EXPECT === "observe" ? 0 : fails.length ? 1 : 0
