import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

export async function drive() {
  assert.equal(process.platform, "win32")
  const root = process.env.VERIFY65567_ROOT
  assert.match(root ?? "", /^[R-Z]:\\$/)
  const token = process.env.VERIFY65567_MARKER
  assert.ok(token)
  assert.equal(await fs.readFile(path.join(root, ".verify65567"), "utf8"), token)
  assert.ok(["baseline", "candidate"].includes(process.env.VERIFY65567_REVISION))
  return root
}

export async function probeMkdir(root) {
  try {
    await fs.mkdir(root, { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, code: error.code, message: error.message }
  }
}

export async function contents(target) {
  try {
    return await fs.readFile(target, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

export function record(data) {
  console.log("VERIFY65567 " + JSON.stringify({ revision: process.env.VERIFY65567_REVISION, ...data }))
}

export function baselineDenied(mkdir) {
  return process.env.VERIFY65567_REVISION === "baseline" && ["EPERM", "EACCES"].includes(mkdir.code)
}
