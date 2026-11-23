
import { baselineDenied, contents, drive, probeMkdir, record, reserveFixedFile } from "./verify65567-drive.mjs"

const nativeEdit = (root: string, target: string, scenario: string, mkdir: Awaited<ReturnType<typeof probeMkdir>>) =>
  Effect.gen(function* () {
    const before = yield* Effect.promise(() => contents(target))
    expect(before).toBe("before\n")
    const fixture = makeEditFixture()
    const result = yield* withTool(root, fixture, (registry) =>
      executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
    )
    const actual = yield* Effect.promise(() => contents(target))
    record({ runtime: `Bun ${Bun.version}`, scenario, root, target, mkdir, writes: fixture.writes, result, before, actual })
    expect(fixture.writes.map((file) => path.normalize(file).toLowerCase())).toEqual([target.toLowerCase()])
    if (path.dirname(target) === root && baselineDenied(mkdir) && result.status === "error") {
      expect(result.error?.message).toContain("Unable to edit")
      expect(actual).toBe(before)
    } else {
      expect(result.status).toBe("completed")
      expect(actual).toBe("after\n")
    }
  })

it.live("verify-65567 native edit existing fixed volume root file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => reserveFixedFile(`Bun ${Bun.version}`)),
    (file) => file ? nativeEdit(file.root, file.target, "fixed-existing-edit", file.mkdir) : Effect.void,
    (file) => file ? Effect.promise(() => fs.unlink(file.target)) : Effect.void,
  ),
)

for (const relative of ["edit-root.txt", "existing-dir/edit-subdir.txt"]) {
  it.live(`verify-65567 native edit ${relative}`, () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(drive)
      const target = path.join(root, relative)
      if (path.dirname(target) !== root) yield* Effect.promise(() => fs.mkdir(path.dirname(target)))
      yield* Effect.promise(() => fs.writeFile(target, "before\n", { flag: "wx" }))
      const mkdir = yield* Effect.promise(() => probeMkdir(root))
      yield* nativeEdit(root, target, relative, mkdir)
    }),
  )
}
