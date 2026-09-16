import { chromium } from "playwright"
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
const ROOT = "<DEMO_ROOT>"
const manifest = JSON.parse(readFileSync(path.join(ROOT, "assets/shot-manifest.json"), "utf8"))
const NAME = {
  "SHOT-01": "SHOT-01_unit-tests-pass", "SHOT-02": "SHOT-02_register-9-to-10",
  "SHOT-03": "SHOT-03_full-before-click", "SHOT-04": "SHOT-04_over-capacity",
  "SHOT-05": "SHOT-05_opencode-check-measured", "SHOT-06": "SHOT-06_guard-blocked",
  "SHOT-07": "SHOT-07_app-only-diff", "SHOT-08": "SHOT-08_full-rejected-10",
  "SHOT-09": "SHOT-09_publish-allowed-receipt", "SHOT-10": "SHOT-10_guard-tests-pass",
  "SHOT-11": "SHOT-11_unguarded-publish", "SHOT-12": "SHOT-12_outer-verify-fail",
}
const b = await chromium.launch({ headless: true })
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
  transform.push({ shot_id: s.shot_id, src: s.raw_path, dst: path.relative(ROOT, dst), crop_top_px: cropTop })
  console.log(s.shot_id, "→", NAME[s.shot_id], cropTop ? `crop ${cropTop}px` : "copy")
}
writeFileSync(path.join(ROOT, "assets", "slide-transform.json"), JSON.stringify({ generated_at: new Date().toISOString(), transform }, null, 2) + "\n")
await b.close()
