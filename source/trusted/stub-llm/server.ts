// stub-llm — OpenAI互換の決定的ローカル応答サーバー（教材用フォールバック）。
// プロンプト内の `CALL <tool> <json>` 指示に対し、そのツール呼出しを含む
// chat.completion を返す。実モデルを介さない固定応答であり、検証対象は
// OpenCode のツール/プラグイン実経路そのもの。
import { createServer } from "node:http"

const port = Number(process.env.DEMO_STUB_PORT ?? 4531)

function toolCall(name: string, argsJson: string) {
  return {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    type: "function",
    function: { name, arguments: argsJson },
  }
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text : ""))
        .join("\n")
    }
  }
  return ""
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text : "")).join("\n")
  }
  return ""
}

function decide(messages: { role: string; content: unknown }[], tools: { function?: { name?: string }; name?: string }[] = []) {
  const text = lastUserText(messages)
  const toolNames = new Set((tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean))
  const called = messages.some((msg) => (msg as { role?: string }).role === "tool")

  // ツール実行後は必ずテキスト応答に戻す（CALL指示の再解釈によるリトライループ防止）
  if (!called) {
    const m = text.match(/CALL\s+(\w+)\s+(\{.*\})/s)
    if (m && toolNames.has(m[1])) {
      try {
        JSON.parse(m[2])
        return { content: null, tool_calls: [toolCall(m[1], m[2])] }
      } catch {
        /* fallthrough to text reply */
      }
    }
    return { content: "指示を確認しました。必要な検査には提供ツールを使います（固定応答プロバイダ）。" }
  }
  // 実測したツール結果をそのまま報告する（加工・捏造なし。実OpenCodeのUIに実値が出る）
  const lastTool = [...messages].reverse().find((m) => (m as { role?: string }).role === "tool") as
    | { content?: unknown }
    | undefined
  const out = toolText(lastTool?.content).trim()
  const body = out ? out.slice(0, 1400) : "(tool output empty)"
  return { content: `ツールの実測結果をそのまま報告します:\n\n${body}` }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-demo", object: "model" }] }))
    return
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      const reqBody = JSON.parse(raw)
      const decided = decide(reqBody.messages ?? [], reqBody.tools)
      const id = `chatcmpl-stub-${Date.now()}`
      const model = reqBody.model ?? "stub-demo"

      if (reqBody.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        if (decided.tool_calls) {
          res.write(chunk({ role: "assistant", tool_calls: decided.tool_calls }, null))
          res.write(chunk({}, "tool_calls"))
        } else {
          res.write(chunk({ role: "assistant", content: decided.content }, null))
          res.write(chunk({}, "stop"))
        }
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      const completion = {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", ...decided },
            finish_reason: decided.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(completion))
    })
    return
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(port, "127.0.0.1", () => console.log(`STUB_LLM_READY http://127.0.0.1:${port}`))
