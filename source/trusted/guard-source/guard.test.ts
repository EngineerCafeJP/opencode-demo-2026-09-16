// ガード内部テスト: publish-guard の判定関数と plugin 形状を直接検査する。
// このテストは OpenCode への接続有無に関係なく実行できる（D状態でも合格する）。
import { test } from "node:test"
import assert from "node:assert/strict"
import guard, { evaluateGateDecision } from "./publish-guard.ts"

const HASH = "a".repeat(64)

test("plugin形状: id と server 関数を持つ", () => {
  assert.equal(guard.id, "demo-publish-guard")
  assert.equal(typeof guard.server, "function")
})

test("server() は tool.execute.before フックを返す", async () => {
  const hooks = await guard.server({} as never)
  assert.equal(typeof hooks["tool.execute.before"], "function")
})

test("PASS + 件数あり + hash一致 → 放行", () => {
  const r = evaluateGateDecision(
    { verdict: "PASS", cases: [{ case_id: "app-01" }], target_sha256: HASH },
    HASH,
  )
  assert.equal(r.allow, true)
})

test("受入FAIL → 遮断", () => {
  const r = evaluateGateDecision(
    { verdict: "FAIL", cases: [{ case_id: "app-03" }], target_sha256: HASH },
    HASH,
  )
  assert.equal(r.allow, false)
  assert.match(r.reason, /ACCEPTANCE_FAIL/)
})

test("検査結果なし(null) → 遮断（検査不能を合格扱いしない）", () => {
  const r = evaluateGateDecision(null, HASH)
  assert.equal(r.allow, false)
  assert.match(r.reason, /CHECK_UNAVAILABLE/)
})

test("検査ケース0件 → 遮断（0件を合格扱いしない）", () => {
  const r = evaluateGateDecision({ verdict: "PASS", cases: [], target_sha256: HASH }, HASH)
  assert.equal(r.allow, false)
  assert.match(r.reason, /0件/)
})

test("検査対象hash不一致 → 遮断（別物を検査した結果を信用しない）", () => {
  const r = evaluateGateDecision(
    { verdict: "PASS", cases: [{ case_id: "app-01" }], target_sha256: "b".repeat(64) },
    HASH,
  )
  assert.equal(r.allow, false)
  assert.match(r.reason, /SNAPSHOT_MISMATCH/)
})

test("demo_publish 以外のツール呼出しは素通し", async () => {
  const hooks = await guard.server({} as never)
  const before = hooks["tool.execute.before"]!
  await before({ tool: "read", sessionID: "s", callID: "c" }, { args: {} })
})
