// Canonical candidate-hash implementation.
// The same algorithm is duplicated (verbatim) inside trusted/tools/*.ts and
// trusted/guard-source/publish-guard.ts because those files are loaded by the
// OpenCode process as standalone modules and must not import each other.
// If you change this file, update those copies and bump DEMO_HASH_VERSION.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

export const DEMO_HASH_VERSION = "dirhash-1"

const EXCLUDE = new Set([".git", "node_modules", "runtime", "publish", "evidence", "private", ".env", ".DS_Store"])
const EXCLUDE_FILE = (name) =>
  name.endsWith(".log") || name.endsWith(".env") || name === "credentials.json" || name === "auth.json"

export function dirHash(root) {
  const real = realpathSync(root)
  const entries = []
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

  function walk(dir, prefix) {
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

export function fileHash(file) {
  const h = createHash("sha256")
  h.update(readFileSync(file))
  return h.digest("hex")
}
