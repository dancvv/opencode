import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

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
    return { ok: false, code: error.code, errno: error.errno, syscall: error.syscall, message: error.message }
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

// The fixed volume never receives a marker or a predetermined test filename.
export async function reserveFixedFile(runtime) {
  assert.equal(process.platform, "win32")
  const root = process.env.VERIFY65567_FIXED_ROOT
  if (!root) {
    record({ runtime, scenario: "fixed-root-unavailable" })
    return
  }
  assert.match(root, /^[A-Z]:\\$/i)
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE)
  assert.equal(path.parse(workspace).root.toUpperCase(), root.toUpperCase())
  const mkdir = await probeMkdir(root)
  record({ runtime, scenario: "fixed-root-mkdir", root, workspace, mkdir })
  const target = path.join(root, `opencode-65567-${randomUUID()}.txt`)
  let handle
  try {
    handle = await fs.open(target, "wx")
  } catch (error) {
    if (!["EPERM", "EACCES", "EROFS"].includes(error.code)) throw error
    record({ runtime, scenario: "fixed-root-file-unavailable", root, target, errno: error.errno,
      code: error.code, syscall: error.syscall, message: error.message })
    return
  }
  try {
    try {
      await handle.writeFile("before\n")
    } finally {
      await handle.close()
    }
  } catch (error) {
    await fs.unlink(target)
    throw error
  }
  return { root, target, mkdir }
}
