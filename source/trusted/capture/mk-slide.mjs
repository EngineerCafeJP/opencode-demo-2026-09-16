import { chromium } from "playwright"
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"

// R2-04: env未指定だと親process.envがブラウザへ継承されるため、deny系を除去し明示envを渡す
const ENV_DENY = /^(OPENCODE_CONFIG_CONTENT|.*_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|AZURE_|AIDD_|SSH_AUTH_SOCK)/i
for (const k of Object.keys(process.env)) if (ENV_DENY.test(k)) delete process.env[k]
const BROWSER_ENV = Object.fromEntries(
  ["PATH", "HOME", "LANG", "TMPDIR", "SYSTEM_VERSION_COMPAT", "XPC_FLAGS", "XPC_SERVICE_NAME", "PLAYWRIGHT_BROWSERS_PATH", "__CF_USER_TEXT_ENCODING"]
    .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const manifest = JSON.parse(readFileSync(path.join(ROOT, "assets/shot-manifest.json"), "utf8"))
const NAME = {
  "SHOT-01": "SHOT-01_unit-tests-pass", "SHOT-02": "SHOT-02_register-9-to-10",
  "SHOT-03": "SHOT-03_full-before-click", "SHOT-04": "SHOT-04_over-capacity",
  "SHOT-05": "SHOT-05_opencode-check-measured", "SHOT-06": "SHOT-06_guard-blocked",
  "SHOT-07": "SHOT-07_app-only-diff", "SHOT-08": "SHOT-08_full-rejected-10",
  "SHOT-09": "SHOT-09_publish-allowed-receipt", "SHOT-10": "SHOT-10_guard-tests-pass",
  "SHOT-11": "SHOT-11_unguarded-publish", "SHOT-12": "SHOT-12_outer-verify-fail",
}
// 要求revが未キャッシュなら最新キャッシュの shell へフォールバック（capture.mjsと同じ方針）
async function launchBrowser() {
  try { return await chromium.launch({ headless: true, env: BROWSER_ENV }) } catch (e) {
    const cache = path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
    for (const d of (existsSync(cache) ? readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse() : [])) {
      const exe = path.join(cache, d, "chrome-headless-shell-mac-arm64", "chrome-headless-shell")
      if (existsSync(exe)) return await chromium.launch({ headless: true, env: BROWSER_ENV, executablePath: exe })
    }
    throw e
  }
}
const b = await launchBrowser()
const p = await b.newPage()
const outDir = path.join(ROOT, "assets", "slide-ready")
mkdirSync(outDir, { recursive: true })
const transform = []
for (const s of manifest.shots) {
  if (s.status !== "CAPTURED") continue
  const src = path.join(ROOT, s.raw_path)
  const dst = path.join(outDir, NAME[s.shot_id] + ".png")
  const cropTop = s.screen_type === "terminal" ? 86 : 0
  if (cropTop > 0) {
    const b64 = readFileSync(src).toString("base64")
    const out = await p.evaluate(async ([b64, top]) => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64 })
      const c = document.createElement("canvas")
      c.width = img.width; c.height = img.height - Number(top)
      const g = c.getContext("2d")
      g.drawImage(img, 0, Number(top), img.width, img.height - Number(top), 0, 0, img.width, img.height - Number(top))
      return c.toDataURL("image/png").split(",")[1]
    }, [b64, cropTop])
    writeFileSync(dst, Buffer.from(out, "base64"))
  } else {
    copyFileSync(src, dst)
  }
  transform.push({ shot_id: s.shot_id, src: s.raw_path, dst: path.relative(ROOT, dst), crop_top_px: cropTop, reencode: cropTop > 0 ? "canvas re-encode（色管理で画素バイト非一致・改ざんではない）" : "byte-identical copy" })
  console.log(s.shot_id, "→", NAME[s.shot_id], cropTop ? `crop ${cropTop}px` : "copy")
}
writeFileSync(path.join(ROOT, "assets", "slide-transform.json"), JSON.stringify({ generated_at: new Date().toISOString(), transform }, null, 2) + "\n")
await b.close()
