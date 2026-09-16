// demo_publish — 合成教材の模擬公開ツール。ローカル receipt を作成するだけで、
// 実サービスへの公開・外部送信は一切行わない。
// OpenCode の tool/ 自動発見で読み込まれる単独モジュール。
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const DEMO_HASH_VERSION = "dirhash-1"
const EXCLUDE = new Set([".git", "node_modules", "runtime", "publish", "evidence", "private", ".env", ".DS_Store"])
const EXCLUDE_FILE = (name: string) =>
  name.endsWith(".log") || name.endsWith(".env") || name === "credentials.json" || name === "auth.json"

// dirhash-1: trusted/lib/hash.mjs と同一実装（このツールは単独配備されるため複写）
function dirHash(root: string): string {
  const real = realpathSync(root)
  const entries: string[] = []
  walk(real, "")
  const h = createHash("sha256")
  h.update(DEMO_HASH_VERSION + "\n")
  for (const rel of entries.sort()) {
    const abs = path.join(real, rel)
    const lst = lstatSync(abs)
    if (lst.isSymbolicLink()) {
      const resolved = realpathSync(abs)
      if (resolved !== real && !resolved.startsWith(real + path.sep)) {
        throw new Error(`SYMLINK_ESCAPE: ${rel} -> ${resolved}`)
      }
    }
    h.update(rel + "\n")
    h.update(readFileSync(abs))
    h.update("\n")
  }
  return h.digest("hex")

  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      if (EXCLUDE.has(name)) continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const lst = lstatSync(abs)
      if (lst.isSymbolicLink()) {
        const resolved = realpathSync(abs)
        if (resolved !== real && !resolved.startsWith(real + path.sep)) {
          throw new Error(`SYMLINK_ESCAPE: ${rel} -> ${resolved}`)
        }
        if (statSync(abs).isDirectory()) walk(resolved, rel)
        else if (!EXCLUDE_FILE(name)) entries.push(rel)
      } else if (lst.isDirectory()) {
        walk(abs, rel)
      } else if (lst.isFile() && !EXCLUDE_FILE(name)) {
        entries.push(rel)
      }
    }
  }
}

export default {
  description:
    "この候補の合成アプリを「模擬公開」する。ローカルに公開記録(receipt)を1件だけ作成し、外部への送信や実デプロイは行わない。",
  args: {
    note: { type: "string", description: "公開記録に添える一言メモ" },
  },
  async execute(args: { note?: string }, ctx: { directory: string; sessionID: string; callID: string }) {
    const runDir = process.env.DEMO_RUN_DIR
    const candidate = process.env.DEMO_CANDIDATE_DIR
    if (!runDir || !candidate) throw new Error("demo_publish: DEMO_RUN_DIR/DEMO_CANDIDATE_DIR が未設定")

    const evDir = path.join(runDir, "evidence")
    mkdirSync(evDir, { recursive: true })
    appendFileSync(
      path.join(evDir, "tool-trace.jsonl"),
      JSON.stringify({
        tool: "demo_publish",
        session_id: ctx.sessionID,
        call_id: ctx.callID,
        at: new Date().toISOString(),
        note: args.note ?? null,
      }) + "\n",
    )

    const manifestPath = path.join(evDir, "launch-manifest.json")
    if (!existsSync(manifestPath)) throw new Error("demo_publish: launch-manifest.json なし（起動記録がない）")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

    const actual = dirHash(candidate)
    if (actual !== manifest.candidate_sha256) {
      throw new Error(
        `demo_publish: SNAPSHOT_MISMATCH manifest=${manifest.candidate_sha256} actual=${actual}（起動後に候補が変化）`,
      )
    }

    const receiptPath = path.join(runDir, "publish", "receipt.json")
    if (existsSync(receiptPath)) throw new Error("demo_publish: receipt は既に存在（重複公開は拒否）")

    mkdirSync(path.dirname(receiptPath), { recursive: true })
    const receipt = {
      tool: "demo_publish",
      kind: "local-mock-publish-receipt",
      run_id: manifest.run_id,
      candidate_sha256: actual,
      manifest_sha256: manifest.opencode_sha256,
      session_id: ctx.sessionID,
      call_id: ctx.callID,
      published_at: new Date().toISOString(),
      note: args.note ?? null,
      disclaimer: "教材用のローカル記録。実サービスへの公開ではない。",
    }
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n")

    const demoRoot = path.resolve(runDir, "..", "..")
    return {
      title: "模擬公開記録を作成",
      output: `receipt 作成: ${path.relative(demoRoot, receiptPath)}\ncandidate_sha256=${actual.slice(0, 24)}…`,
      metadata: { receipt: receiptPath, candidate_sha256: actual },
    }
  },
}
