import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { appendRegistration, readState } from "./store.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(dir, "public")
const stateFile = process.env.DEMO_STATE_FILE ?? path.join(tmpdir(), "demo-registration-state.json")
const port = Number(process.env.DEMO_PORT ?? 0)
const subrun = process.env.DEMO_SUBRUN_ID ?? "standalone"

const types: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/app.css": "text/css; charset=utf-8",
  "/client.js": "text/javascript; charset=utf-8",
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(payload)
}

function serve(res: ServerResponse, file: string, type: string) {
  res.writeHead(200, { "content-type": type })
  res.end(readFileSync(path.join(publicDir, file)))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "/").split("?")[0]

  if (req.method === "GET" && url === "/healthz") {
    return json(res, 200, { ok: true })
  }

  if (req.method === "GET" && url in types) {
    return serve(res, url === "/" ? "index.html" : url.slice(1), types[url])
  }

  if (req.method === "GET" && url === "/api/state") {
    const state = readState(stateFile)
    return json(res, 200, {
      event: state.event,
      capacity: state.capacity,
      count: state.registrations.length,
      full: state.registrations.length >= state.capacity,
      subrun,
    })
  }

  if (req.method === "POST" && url === "/api/registrations") {
    const state = readState(stateFile)
    if (state.registrations.length >= state.capacity) {
      return json(res, 409, { ok: false, result: "full" })
    }
    const next = appendRegistration(stateFile)
    return json(res, 201, {
      ok: true,
      result: "accepted",
      count: next.registrations.length,
      capacity: next.capacity,
    })
  }

  return json(res, 404, { ok: false, result: "not_found" })
})

server.listen(port, "127.0.0.1", () => {
  const address = server.address()
  const actual = typeof address === "object" && address ? address.port : port
  console.log(`READY http://127.0.0.1:${actual}`)
})
