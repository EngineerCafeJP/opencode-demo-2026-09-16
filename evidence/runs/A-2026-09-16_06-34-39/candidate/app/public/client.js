const countEl = document.getElementById("count")
const capacityEl = document.getElementById("capacity")
const statusEl = document.getElementById("status")
const resultEl = document.getElementById("result")
const subrunEl = document.getElementById("subrun")
const eventEl = document.getElementById("event-name")
const applyBtn = document.getElementById("apply")

async function refresh() {
  const res = await fetch("/api/state")
  const state = await res.json()
  countEl.textContent = String(state.count)
  capacityEl.textContent = String(state.capacity)
  eventEl.textContent = state.event
  subrunEl.textContent = state.subrun
  statusEl.textContent = state.full ? "満席" : "受付中"
  statusEl.className = "status " + (state.full ? "full" : "open")
  document.title = `${state.count}/${state.capacity} ハーネス入門・デモ申込`
}

function setResult(text, kind) {
  resultEl.textContent = text
  resultEl.className = "result " + kind
}

applyBtn.addEventListener("click", async () => {
  setResult("送信中…", "error")
  applyBtn.disabled = true
  try {
    const res = await fetch("/api/registrations", { method: "POST" })
    const body = await res.json()
    if (res.status === 201 && body.ok) {
      setResult(`受付成功: ${body.count}名になりました（HTTP 201）`, "ok")
    } else if (res.status === 409) {
      setResult(`満席のため拒否されました: 現在 ${body.count}名（HTTP 409）`, "rejected")
    } else {
      setResult(`予期しない応答: HTTP ${res.status}`, "error")
    }
  } catch (err) {
    setResult(`通信失敗: ${err.message}`, "error")
  } finally {
    applyBtn.disabled = false
  }
  await refresh()
})

refresh()
