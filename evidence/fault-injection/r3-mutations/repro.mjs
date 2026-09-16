// R3: R2検収の変異ケースを修正版へ再現する。
// 各ケースは検証済みの実runを /tmp/r3-mutations/<case>/<orig-name> へコピーし
// （basenameを保持 = 正当なrenameではなく「同一runのコピー」として identity を保つ）、
// 指定の変異を加えてから実CLI `democtl verify --run <path>` を実行する。
import { execFileSync, spawnSync, spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

const ROOT = "<DEMO_ROOT>"
const RUNS = path.join(ROOT, "runs")
const NODE = process.execPath
const CTL = path.join(ROOT, "trusted/controller/democtl.ts")
const BASE = "/tmp/r3-mutations"
const ACCEPTANCE = path.join(ROOT, "trusted/acceptance/acceptance.ts")

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex")
const j = (f) => JSON.parse(readFileSync(f, "utf8"))
const wj = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + "\n")

const results = []
const record = (id, expected, ok, detail) => {
  results.push({ id, expected, ok, detail })
  console.log(`${ok ? "✔" : "✖"} ${id}: ${detail}`)
}

function cloneRun(runName, caseName) {
  const dstParent = path.join(BASE, caseName)
  rmSync(dstParent, { recursive: true, force: true })
  mkdirSync(dstParent, { recursive: true })
  const dst = path.join(dstParent, runName) // basename保持
  cpSync(path.join(RUNS, runName), dst, { recursive: true, dereference: true })
  // 共有stateの副作用を防ぐため runtime を空に（app/serverプロセスは既に停止済み）
  return dst
}

function cliVerify(runDir) {
  const r = spawnSync(NODE, [CTL, "verify", "--run", runDir], { encoding: "utf8", timeout: 180000 })
  let report = {}
  try { report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) } catch { report = { parse_error: true, tail: (r.stdout ?? "").slice(-300), stderr: (r.stderr ?? "").slice(-300) } }
  return { exit: r.status, report }
}

// 最新の検証済みrun名
const pick = (st) => readdirSync(RUNS).filter((d) => d.startsWith(`${st}-`)).sort().at(-1)
const RUN_B = pick("B"), RUN_C = pick("C"), RUN_D = pick("D")
console.log(`base runs: B=${RUN_B} C=${RUN_C} D=${RUN_D}`)

// control: コピーそのまま → 変異なしで成立するか（B/C/D）
{
  const d = cloneRun(RUN_B, "control-B")
  const v = cliVerify(d)
  record("control-B", "exit=0 scenario=PASS", v.exit === 0 && v.report.scenario_match === "PASS",
    `exit=${v.exit} scenario=${v.report.scenario_match} viol=${JSON.stringify(v.report.violations)}`)
}
{
  const d = cloneRun(RUN_C, "control-C")
  const v = cliVerify(d)
  record("control-C", "exit=0 scenario=PASS", v.exit === 0 && v.report.scenario_match === "PASS",
    `exit=${v.exit} scenario=${v.report.scenario_match} viol=${JSON.stringify(v.report.violations)}`)
}
{
  const d = cloneRun(RUN_D, "control-D")
  const v = cliVerify(d)
  record("control-D", "exit=0 scenario=PASS probe=FAIL(意図)", v.exit === 0 && v.report.scenario_match === "PASS" && v.report.runtime_probe === "FAIL",
    `exit=${v.exit} scenario=${v.report.scenario_match} probe=${v.report.runtime_probe}`)
}

// M1: Bのセッション記録を別run・別session・別callへ改ざん
{
  const d = cloneRun(RUN_B, "B-foreign-session")
  const sf = readdirSync(path.join(d, "evidence")).find((f) => f.startsWith("session-"))
  const s = j(path.join(d, "evidence", sf))
  s.run_id = "FOREIGN-RUN"; s.session_id = "ses_FOREIGN"
  for (const c of s.tool_calls ?? []) c.callID = "call_FOREIGN"
  wj(path.join(d, "evidence", sf), s)
  const v = cliVerify(d)
  const viol = JSON.stringify(v.report.violations)
  record("M1 B-foreign-session", "exit!=0 scenario=FAIL（session同一性違反）",
    v.exit !== 0 && v.report.scenario_match === "FAIL" && /SESSION_RUN_MISMATCH|GATE_CALL_UNBOUND/.test(viol),
    `exit=${v.exit} scenario=${v.report.scenario_match} viol=${viol.slice(0, 220)}`)
}

// M2: Cのreceiptのsession/callだけ別物へ
{
  const d = cloneRun(RUN_C, "C-foreign-receipt-call")
  const rp = path.join(d, "publish", "receipt.json")
  const r = j(rp); r.session_id = "ses_OTHER"; r.call_id = "call_OTHER"; wj(rp, r)
  const v = cliVerify(d)
  record("M2 C-foreign-receipt-call", "exit!=0 receipt無効・probe=FAIL",
    v.exit !== 0 && v.report.scenario_match === "FAIL" && v.report.runtime_probe === "FAIL",
    `exit=${v.exit} scenario=${v.report.scenario_match} probe=${v.report.runtime_probe} receipt=${v.report.facts?.receipt}`)
}

// M3: Bの起動記録のrun_idだけ別物へ
{
  const d = cloneRun(RUN_B, "B-manifest-run-id-mismatch")
  const mp = path.join(d, "evidence", "launch-manifest.json")
  const m = j(mp); m.run_id = "OTHER-RUN"; wj(mp, m)
  const v = cliVerify(d)
  record("M3 B-manifest-run-id", "exit!=0 scenario=FAIL（manifest同一性違反）",
    v.exit !== 0 && v.report.scenario_match === "FAIL" && /MANIFEST_RUN_ID_MISMATCH/.test(JSON.stringify(v.report.violations)),
    `exit=${v.exit} scenario=${v.report.scenario_match} viol=${JSON.stringify(v.report.violations).slice(0, 200)}`)
}

// M4a: Cの検査器が PASS文書を書いた後 異常終了(exit=3)（manifestを同期し exit-status 経路だけを単独評価）
{
  const d = cloneRun(RUN_C, "C-PASS-doc-exit3")
  const fake = path.join(d, "fake-acceptance.ts")
  // 正規検査器を内部で呼び、出力文書はそのまま書かせてから exit 3 で死ぬ
  writeFileSync(fake, `import { spawnSync } from "node:child_process"\nconst a=process.argv.slice(2)\nconst i=a.indexOf("--out")\nconst r=spawnSync(process.execPath,["${ACCEPTANCE}",...a],{stdio:"inherit",env:process.env})\nprocess.exit(3)\n`)
  const mp = path.join(d, "evidence", "launch-manifest.json")
  const m = j(mp); m.acceptance_sha256 = sha(fake); m.acceptance_path = path.relative(ROOT, fake); m.inspector_override = true; wj(mp, m)
  const v = cliVerify(d)
  const viol = JSON.stringify(v.report.violations)
  record("M4a C-PASS-doc-exit3", "exit!=0（PASS文書+異常終了は信用しない）",
    v.exit !== 0 && v.report.scenario_match === "FAIL" && (/ACCEPTANCE_UNTRUSTED/.test(viol) || v.report.facts?.app_acceptance === "ERROR"),
    `exit=${v.exit} scenario=${v.report.scenario_match} acc=${v.report.facts?.app_acceptance} viol=${viol.slice(0, 200)}`)
}

// M4b: manifestのacceptance_sha256だけ不一致（検査器identity）
{
  const d = cloneRun(RUN_C, "C-inspector-hash-mismatch")
  const mp = path.join(d, "evidence", "launch-manifest.json")
  const m = j(mp); m.acceptance_sha256 = "0".repeat(64); wj(mp, m)
  const v = cliVerify(d)
  record("M4b C-inspector-hash", "exit!=0 INSPECTOR_IDENTITY_MISMATCH",
    v.exit !== 0 && /INSPECTOR_IDENTITY_MISMATCH/.test(JSON.stringify(v.report.violations)),
    `exit=${v.exit} viol=${JSON.stringify(v.report.violations).slice(0, 200)}`)
}

// M5: 別プロジェクトのプロセスを古い記録のPIDに見立ててstop → 停止しないこと
{
  const foreign = path.join(BASE, "foreign-proj", "app")
  mkdirSync(foreign, { recursive: true })
  writeFileSync(path.join(foreign, "server.ts"), `import http from "node:http"\nhttp.createServer((q,s)=>s.end("ok")).listen(0)\nsetInterval(()=>{},60000)\n`)
  const proc = spawn(NODE, [path.join(foreign, "server.ts")], { detached: true, stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 1200))
  const pid = proc.pid
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  // 旧形式の記録（ownerなし・pidのみ）+ 新形式でもexe/run_dir/lstart不一致の両方を試す
  const d = cloneRun(RUN_B, "stale-pid-ownership")
  wj(path.join(d, "app-info.json"), { pid, port: 1, fixture: "x", started_at: "2020-01-01T00:00:00Z" }) // ownerなし旧形式
  const r1 = spawnSync(NODE, [CTL, "stop", "--run", d], { encoding: "utf8", cwd: ROOT })
  const aliveAfterLegacy = alive()
  // 新形式: owner.exe=我々のcandidate、lstart=偽造 → exe不一致でskipされるべき
  wj(path.join(d, "app-info.json"), { pid, port: 1, owner: { exe: path.join(d, "candidate", "app", "server.ts"), run_dir: d, lstart: "Mon Jan  1 00:00:00 2020" } })
  const r2 = spawnSync(NODE, [CTL, "stop", "--run", d], { encoding: "utf8", cwd: ROOT })
  const aliveAfterNew = alive()
  // 掃除: 自分のプロセスなので直接kill
  if (alive()) process.kill(pid, "SIGTERM")
  record("M5 stale-pid-ownership", "別プロジェクトのプロセスを停止しない",
    aliveAfterLegacy && aliveAfterNew && /skip/.test(r1.stdout + r2.stdout),
    `legacy_alive=${aliveAfterLegacy} newfmt_alive=${aliveAfterNew} out=${(r1.stdout + r2.stdout).trim().split("\n").slice(-3).join(" | ")}`)
}

// M6: Dの証拠（receipt/session/tool呼出し）を除去 → explain が「公開された」と言わないこと
{
  const d = cloneRun(RUN_D, "D-no-evidence-explain")
  rmSync(path.join(d, "publish", "receipt.json"), { force: true })
  for (const f of readdirSync(path.join(d, "evidence"))) if (f.startsWith("session-") || f === "tool-trace.jsonl") rmSync(path.join(d, "evidence", f))
  const v = cliVerify(d)
  const r = spawnSync(NODE, [CTL, "explain", "--run", d], { encoding: "utf8", cwd: ROOT })
  const out = r.stdout ?? ""
  const claimsPublished = out.includes("模擬公開されてしまいました")
  record("M6 D-explain-no-evidence", "未呼出時に「公開された」と表示しない",
    v.report.runtime_probe === "NOT_CALLED" && !claimsPublished && /記録なし|未実行|要レビュー/.test(out),
    `probe=${v.report.runtime_probe} publishedClaim=${claimsPublished} out_tail=${out.trim().split("\n").slice(-4).join(" | ")}`)
}

const pass = results.every((r) => r.ok)
writeFileSync(path.join(BASE, "results.json"), JSON.stringify(results, null, 2))
console.log(`\nR3 mutation repro: ${pass ? "ALL PASS" : "FAILURES"} (${results.filter((r) => r.ok).length}/${results.length})`)
process.exit(pass ? 0 : 1)
