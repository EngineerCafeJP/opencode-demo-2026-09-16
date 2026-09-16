// crop.mjs <src> <dst> <topPx> — 上端 topPx を切り落とす（端末タイトルバー除去用）
import { chromium } from "playwright"
import { readFileSync, writeFileSync } from "node:fs"
const [src, dst, top] = process.argv.slice(2)
const b = await chromium.launch({ headless: true })
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
