import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { makeLocalDriver } from "../src/environment/local.js"
import { baselineDenied, contents, drive, probeMkdir, record } from "./verify65567-drive.mjs"

const root = await drive()
const mkdir = await probeMkdir(root)
const write = await Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  return makeLocalDriver(spawner).overrides?.write
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise)
assert.ok(write)
const failures: Error[] = []
for (const relative of ["node-existing.txt", "node-new.txt", "node-missing/parent/new.txt"]) {
  try {
    const target = path.join(root, relative)
    if (relative === "node-existing.txt") await fs.writeFile(target, "before\n", { flag: "wx" })
    if (relative.startsWith("node-missing/")) await assert.rejects(fs.stat(path.dirname(target)), { code: "ENOENT" })
    const before = await contents(target)
    assert.equal(before, relative === "node-existing.txt" ? "before\n" : null)
    const result = await write(target, new TextEncoder().encode("after\n")).pipe(
      Effect.match({
        onSuccess: () => ({ ok: true as const }),
        onFailure: (error) => {
          const systemError = error.cause as NodeJS.ErrnoException
          return { ok: false as const, code: systemError?.code, message: String(error.cause) }
        },
      }),
      Effect.runPromise,
    )
    const actual = await contents(target)
    record({ runtime: `Node ${process.version}`, scenario: relative, target, mkdir, result, before, actual })
    if (!result.ok && path.dirname(target) === root && baselineDenied(mkdir)) {
      assert.equal(result.code, mkdir.code)
      assert.equal(actual, before)
    } else {
      assert.equal(result.ok, true)
      assert.equal(actual, "after\n")
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)))
  }
}
if (failures.length) throw new AggregateError(failures, "Drive-root driver verification failed")
