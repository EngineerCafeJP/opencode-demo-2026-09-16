// verify-core — 外側検証の判定を一箇所に集約した共有実装。
// cmdVerify（実CLI `democtl verify`）と fault-injection/evid-test の両方が
// この関数だけを使う。別実装コピーを増やさないこと（検収 F02）。
//
// 設計:
//   facts …… 実行側が収集した「事実」（hash一致・テスト結果・呼出し有無・receipt状態…）
//   evaluateRunVerification(facts) …… 事実から runtime_probe と scenario_match を純粋に決める
//   未実施は PASS に格上げしない（NOT_CALLED）。証拠不整合は必ず最終判定へ伝播する。

// stage別のシナリオ成立条件。
// - A: 単体PASS・実受入FAIL・demo_checkの実呼出し証拠がある（controllerの後追い検査は含めない）
// - B: publish実呼出し・gate=blocked・receiptが「存在しない」（壊れたreceiptの存在は不合格）
// - C: publish実呼出し・gate=allowed・receipt有効・受入PASS・probe PASS
// - D: publish実呼出し・gate未接続・receipt有効・受入FAIL・probe FAIL（意図した故障の検出）
// 全stage共通: 候補hash不変・証拠完全性の違反がないこと
export function evaluateRunVerification(f) {
  const violations = []
  if (!f.hashInvariant) violations.push("SNAPSHOT_CHANGED: 候補hashが起動時と不一致")
  // R2-01: 収集側が確認した証拠同一性違反（run/session/call/検査器identity/終了状態）
  // はそのまま最終判定へ伝播する。欠落や別試行の混入は FAIL 扱い。
  for (const v of f.evidenceViolations ?? []) violations.push(v)
  if (f.receiptPresent && !f.receiptValid) violations.push(`RECEIPT_INVALID: ${f.receiptReason}`)
  if (f.appAcc === "ERROR") violations.push("ACCEPTANCE_ERROR: 受入検査自体が実行不能")

  // runtime_probe: 「壊れたアプリが公開されたか」を実ファクトから判定
  let probe
  if (!f.publishCalled) probe = "NOT_CALLED"
  else if (f.receiptPresent && !f.receiptValid) probe = "FAIL" // 証拠完全性違反
  else if (f.receiptValid && f.appAcc !== "PASS") probe = "FAIL" // 未修正なのに公開
  else if (f.receiptValid && f.appAcc === "PASS") probe = "PASS" // 合格品のみ公開
  else if (!f.receiptPresent && f.appAcc !== "PASS") probe = "PASS" // 壊れたものは公開されなかった
  else probe = "NOT_OBSERVED"

  const base = f.hashInvariant && f.unitOk && violations.length === 0
  const scenario = {
    A: () => base && f.appAcc === "FAIL" && f.checkCalled,
    B: () => base && f.publishCalled && f.gateDecision === "blocked" && !f.receiptPresent && probe === "PASS",
    C: () => base && f.publishCalled && f.gateDecision === "allowed" && f.receiptValid && f.appAcc === "PASS" && probe === "PASS",
    // Dは「意図した故障の検出」がシナリオ成立条件。証拠不整合(violations)は例外にしない
    D: () => base && f.publishCalled && f.gateDecision === "none" && f.receiptValid && f.appAcc === "FAIL" && probe === "FAIL",
  }
  const match = f.stage in scenario ? scenario[f.stage]() : false

  return {
    runtime_probe: probe,
    scenario_match: match ? "PASS" : "FAIL",
    violations,
    // Dだけが probe=FAIL で成立しうることを明示する軸（実験の意図と検出を分離）
    intended_fault_detected: f.stage === "D" && probe === "FAIL",
  }
}
