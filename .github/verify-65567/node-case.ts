import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { makeLocalDriver } from "../src/environment/local.js"
import { baselineDenied, contents, drive, probeMkdir, record, reserveFixedFile } from "./verify65567-drive.mjs"

const runtime = `Node ${process.version}`
assert.equal(process.version, "v22.23.4")
const write = await Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const write = makeLocalDriver(spawner).overrides?.write
  assert.ok(write)
  return write
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise)

async function exercise(root: string, target: string, scenario: string, expected: string | null, mkdir: Awaited<ReturnType<typeof probeMkdir>>) {
  const before = await contents(target)
  assert.equal(before, expected)
  const result = await write(target, new TextEncoder().encode("after\n")).pipe(
    Effect.match({
      onSuccess: () => ({ ok: true as const }),
      onFailure: (error) => {
        const cause = error.cause as NodeJS.ErrnoException
        return { ok: false as const, code: cause?.code, errno: cause?.errno, syscall: cause?.syscall, message: String(cause) }
      },
    }),
    Effect.runPromise,
  )
  const actual = await contents(target)
  record({ runtime, scenario, root, target, mkdir, result, before, actual })
  if (!result.ok && path.dirname(target) === root && baselineDenied(mkdir)) {
    assert.equal(result.code, mkdir.code)
    assert.equal(result.syscall, "mkdir")
    assert.equal(actual, before)
  } else {
    assert.equal(result.ok, true)
    assert.equal(actual, "after\n")
  }
}

const failures = []
try {
  const fixed = await reserveFixedFile(runtime)
  if (fixed) {
    try {
      await exercise(fixed.root, fixed.target, "fixed-existing-driver-write", "before\n", fixed.mkdir)
    } finally {
      await fs.unlink(fixed.target)
    }
  }
} catch (error) {
  failures.push(error)
}

const root = await drive()
const mkdir = await probeMkdir(root)
for (const relative of ["node-existing.txt", "node-new.txt", "node-missing/parent/new.txt"]) {
  try {
    const target = path.join(root, relative)
    if (relative === "node-existing.txt") await fs.writeFile(target, "before\n", { flag: "wx" })
    if (relative.startsWith("node-missing/")) await assert.rejects(fs.stat(path.dirname(target)), { code: "ENOENT" })
    await exercise(root, target, relative, relative === "node-existing.txt" ? "before\n" : null, mkdir)
  } catch (error) {
    failures.push(error)
  }
}
if (failures.length) throw new AggregateError(failures, "Drive-root driver verification failed")
