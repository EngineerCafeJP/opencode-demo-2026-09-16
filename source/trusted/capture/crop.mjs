// crop.mjs <src> <dst> <topPx> — 上端 topPx を切り落とす（端末タイトルバー除去用）
import { chromium } from "playwright"
import { readFileSync, writeFileSync } from "node:fs"
const [src, dst, top] = process.argv.slice(2)
// R2-04: env未指定だと親process.envが継承されるためdeny系を除去
const ENV_DENY = /^(OPENCODE_CONFIG_CONTENT|.*_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|AZURE_|AIDD_|SSH_AUTH_SOCK)/i
for (const k of Object.keys(process.env)) if (ENV_DENY.test(k)) delete process.env[k]
const BROWSER_ENV = Object.fromEntries(["PATH","HOME","LANG","TMPDIR","SYSTEM_VERSION_COMPAT","XPC_FLAGS","XPC_SERVICE_NAME","PLAYWRIGHT_BROWSERS_PATH","__CF_USER_TEXT_ENCODING"].filter((k)=>process.env[k]).map((k)=>[k,process.env[k]]))
async function launch() {
  try { return await chromium.launch({ headless: true, env: BROWSER_ENV }) } catch (e) {
    const { readdirSync, existsSync } = await import("node:fs")
    const path = await import("node:path")
    const cache = path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
    for (const d of (existsSync(cache) ? readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse() : [])) {
      const exe = path.join(cache, d, "chrome-headless-shell-mac-arm64", "chrome-headless-shell")
      if (existsSync(exe)) return await chromium.launch({ headless: true, env: BROWSER_ENV, executablePath: exe })
    }
    throw e
  }
}
const b = await launch()
const p = await b.newPage()
const b64 = readFileSync(src).toString("base64")
const out = await p.evaluate(async ([b64, top]) => {
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64 })
  const c = document.createElement("canvas")
  c.width = img.width; c.height = img.height - Number(top)
  const g = c.getContext("2d")
  g.drawImage(img, 0, Number(top), img.width, img.height - Number(top), 0, 0, img.width, img.height - Number(top))
  return c.toDataURL("image/png").split(",")[1]
}, [b64, top])
writeFileSync(dst, Buffer.from(out, "base64"))
await b.close()
console.log(`${dst} cropped -${top}px`)
