
import { baselineDenied, contents, drive, probeMkdir, record } from "./verify65567-drive.mjs"

for (const relative of ["edit-root.txt", "existing-dir/edit-subdir.txt"]) {
  it.live(`verify-65567 native edit ${relative}`, () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(drive)
      const target = path.join(root, relative)
      const inRoot = path.dirname(target) === root
      if (!inRoot) yield* Effect.promise(() => fs.mkdir(path.dirname(target)))
      yield* Effect.promise(() => fs.writeFile(target, "before\n", { flag: "wx" }))
      const mkdir = yield* Effect.promise(() => probeMkdir(root))
      const fixture = makeEditFixture()
      const result = yield* withTool(root, fixture, (registry) =>
        executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
      )
      const actual = yield* Effect.promise(() => contents(target))
      record({ runtime: `Bun ${Bun.version}`, scenario: relative, target, mkdir, writes: fixture.writes, result, actual })
      expect(fixture.writes.map((file) => path.normalize(file).toLowerCase())).toEqual([target.toLowerCase()])
      if (inRoot && baselineDenied(mkdir) && result.status === "error") {
        expect(result.error.message).toContain("Unable to edit")
        expect(actual).toBe("before\n")
      } else {
        expect(result.status).toBe("completed")
        expect(actual).toBe("after\n")
      }
    }),
  )
}
