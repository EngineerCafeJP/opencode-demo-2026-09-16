// always-error-acceptance — 検査不能の実演用合成検査器。
// 実acceptance.tsと同じCLI形を持つが、内部で即座に ERROR(exit=4) を返す。
// 「検査そのものが実行不能な場合にガードが確実に遮断する」を実OpenCode経路で示す。
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const out = arg("out")
if (out) {
  const { writeFileSync, mkdirSync } = await import("node:fs")
  const path = await import("node:path")
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({
    tool: "acceptance", case: arg("case") ?? "both", verdict: "ERROR",
    error: "INSPECTOR_UNAVAILABLE(synthetic): 検査器が結果を生成できません",
    cases: [], at: new Date().toISOString(),
  }, null, 2) + "\n")
}
console.error("always-error-acceptance: synthetic inspector outage (exit=4)")
process.exit(4)
