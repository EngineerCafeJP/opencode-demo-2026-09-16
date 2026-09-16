import { test } from "node:test"
import assert from "node:assert/strict"
import { canRegister } from "../../app/capacity.ts"

test("空席あり: 9名 + 定員10 → 受付可", () => {
  assert.equal(canRegister(9, 10), true)
})

test("満席: 10名 + 定員10 → 受付不可", () => {
  assert.equal(canRegister(10, 10), false)
})

test("空の状態: 0名 + 定員10 → 受付可", () => {
  assert.equal(canRegister(0, 10), true)
})

test("超過状態: 11名 + 定員10 → 受付不可", () => {
  assert.equal(canRegister(11, 10), false)
})
