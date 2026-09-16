// ガード内部テスト: publish-guard の判定関数と plugin 形状を直接検査する。
// このテストは OpenCode への接続有無に関係なく実行できる（D状態でも合格する）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import guard, { evaluateGateDecision, dirHash as dirHashForTest } from "./publish-guard.ts"

const HASH = "a".repeat(64)
const OK_RUN = { status: 0 }
const okCase = (id: string) => ({ case_id: id, expected: "x", actual: "measured", verdict: "PASS" })
const fullReport = (cases: unknown[]) => ({
  tool: "acceptance",
  case: "both",
  verdict: "PASS",
  target_sha256: HASH,
  cases,
})
const ALL4 = () => ["app-01", "app-02", "app-03", "app-04"].map(okCase)

test("plugin形状: id と server 関数を持つ", () => {
  assert.equal(guard.id, "demo-publish-guard")
  assert.equal(typeof guard.server, "function")
})

test("server() は tool.execute.before フックを返す", async () => {
  const hooks = await guard.server({} as never)
  assert.equal(typeof hooks["tool.execute.before"], "function")
})

test("全必須ケースPASS + exit=0 + hash一致 → 放行", () => {
  const r = evaluateGateDecision(fullReport(ALL4()), HASH, OK_RUN)
  assert.equal(r.allow, true)
})

test("受入FAIL → 遮断", () => {
  const r = evaluateGateDecision(
    { tool: "acceptance", case: "both", verdict: "FAIL", cases: ALL4(), target_sha256: HASH },
    HASH,
    OK_RUN,
  )
  assert.equal(r.allow, false)
  assert.match(r.reason, /ACCEPTANCE/)
})

test("検査結果なし(null) → 遮断（検査不能を合格扱いしない）", () => {
  const r = evaluateGateDecision(null, HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /CHECK_UNAVAILABLE/)
})

test("検査ケース0件 → 遮断（0件を合格扱いしない）", () => {
  const r = evaluateGateDecision(fullReport([]), HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /0件/)
})

test("検査対象hash不一致 → 遮断（別物を検査した結果を信用しない）", () => {
  const r = evaluateGateDecision(
    { tool: "acceptance", case: "both", verdict: "PASS", cases: ALL4(), target_sha256: "b".repeat(64) },
    HASH,
    OK_RUN,
  )
  assert.equal(r.allow, false)
  assert.match(r.reason, /SNAPSHOT_MISMATCH/)
})

test("必須ケース欠落(1件だけPASS) → 遮断", () => {
  const r = evaluateGateDecision(fullReport([okCase("app-01")]), HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /CHECK_INCOMPLETE/)
})

test("全体PASSだが個別case FAIL → 遮断", () => {
  const cases = ALL4()
  cases[2] = { ...cases[2], verdict: "FAIL" }
  const r = evaluateGateDecision(fullReport(cases), HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /ACCEPTANCE_FAIL/)
})

test("case要素がnull → 遮断（schema不正）", () => {
  const r = evaluateGateDecision({ verdict: "PASS", cases: [null], target_sha256: HASH }, HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /CHECK_SCHEMA|CHECK_UNAVAILABLE/)
})

test("case重複 → 遮断", () => {
  const r = evaluateGateDecision(
    fullReport(["app-01", "app-01", "app-02", "app-03", "app-04"].map(okCase)),
    HASH,
    OK_RUN,
  )
  assert.equal(r.allow, false)
  assert.match(r.reason, /重複/)
})

test("検査プロセス異常終了(exit=3) → 遮断（文書がPASSでも拒否）", () => {
  const r = evaluateGateDecision(fullReport(ALL4()), HASH, { status: 3 })
  assert.equal(r.allow, false)
  assert.match(r.reason, /異常終了/)
})

test("検査タイムアウト/signal → 遮断", () => {
  const r1 = evaluateGateDecision(fullReport(ALL4()), HASH, { status: null, signal: "SIGTERM", timedOut: true })
  assert.equal(r1.allow, false)
  assert.match(r1.reason, /タイムアウト/)
  const r2 = evaluateGateDecision(fullReport(ALL4()), HASH, { status: null, signal: "SIGKILL" })
  assert.equal(r2.allow, false)
  assert.match(r2.reason, /シグナル終了/)
})

test("検査identity不一致(acceptance/both以外) → 遮断", () => {
  const r = evaluateGateDecision({ tool: "other", case: "both", verdict: "PASS", cases: ALL4(), target_sha256: HASH }, HASH, OK_RUN)
  assert.equal(r.allow, false)
  assert.match(r.reason, /CHECK_SCHEMA/)
})

test("demo_publish 以外のツール呼出しは素通し", async () => {
  const hooks = await guard.server({} as never)
  const before = hooks["tool.execute.before"]!
  await before({ tool: "read", sessionID: "s", callID: "c" }, { args: {} })
})

test("実hook経路: manifestの検査器hash不一致 → 遮断（検収R2-02）", async () => {
  // 起動記録の acceptance_sha256 が実ファイルと違う = 検査器差替え → 実行前に遮断
  const dir = mkdtempSync(path.join(tmpdir(), "guard-ident-"))
  const runDir = path.join(dir, "run")
  const candidate = path.join(runDir, "candidate")
  mkdirSync(path.join(runDir, "evidence"), { recursive: true })
  mkdirSync(candidate, { recursive: true })
  writeFileSync(path.join(candidate, "app.ts"), "x")
  const inspector = path.join(dir, "fake-acceptance.ts")
  writeFileSync(inspector, "// fake inspector")
  const manifest = {
    candidate_sha256: dirHashForTest(candidate),
    acceptance_sha256: "0".repeat(64), // 実ファイルと意図的に不一致
  }
  writeFileSync(path.join(runDir, "evidence", "launch-manifest.json"), JSON.stringify(manifest))
  const saved = { DEMO_RUN_DIR: process.env.DEMO_RUN_DIR, DEMO_CANDIDATE_DIR: process.env.DEMO_CANDIDATE_DIR, DEMO_ACCEPTANCE: process.env.DEMO_ACCEPTANCE, DEMO_NODE: process.env.DEMO_NODE, DEMO_FIXTURES: process.env.DEMO_FIXTURES }
  process.env.DEMO_RUN_DIR = runDir
  process.env.DEMO_CANDIDATE_DIR = candidate
  process.env.DEMO_ACCEPTANCE = inspector
  process.env.DEMO_NODE = process.execPath
  try {
    const hooks = await guard.server({} as never)
    const before = hooks["tool.execute.before"]!
    await assert.rejects(
      () => before({ tool: "demo_publish", sessionID: "s", callID: "c" }, { args: {} }),
      /INSPECTOR_IDENTITY_MISMATCH/,
    )
    const events = readFileSync(path.join(runDir, "evidence", "gate-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    const dec = events.find((e) => e.phase === "decision")
    assert.equal(dec?.decision, "blocked")
    assert.match(dec?.reason ?? "", /INSPECTOR_IDENTITY_MISMATCH/)
    assert.equal(dec?.session_id, "s") // decision側にもidentityが残る
    assert.equal(dec?.call_id, "c")
    assert.equal(existsSync(path.join(runDir, "publish", "receipt.json")), false)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(dir, { recursive: true, force: true })
  }
})
