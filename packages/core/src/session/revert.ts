export * as SessionRevert from "./revert.js"

import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Database } from "../database/database.js"
import { EventTable } from "../event/sql.js"
import { Event } from "@opencode/schema/event"
import { Bus } from "../bus.js"
import { Instance } from "../instance/service.js"
import { RelativePath } from "../schema.js"
import { Snapshot } from "../snapshot.js"
import { SessionEvent } from "./event.js"
import { MessageNotFoundError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionHistory } from "./history.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

interface BoundaryInput {
  readonly files?: boolean
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
}

export const stage = Effect.fn("SessionRevert.stage")(function* (input: BoundaryInput) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const original = input.session.revert?.snapshot ?? (yield* snapshot.capture())
    const next = yield* plan(database.db, input, original)
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size) yield* snapshot.restore({ files: restore })
    const paths = Array.from(next.keys())
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    yield* bus.publish(SessionEvent.RevertEvent.Staged, {
      sessionID: input.session.id,
      revert,
    })
    return revert
  }).pipe(instances.provide(input.session))
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    if (!session.revert) return
    const original = session.revert.snapshot
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
    })
  }).pipe(instances.provide(session))
})

export const commit = Effect.fn("SessionRevert.commit")(function* (bus: Bus.Interface, session: SessionSchema.Info) {
  if (!session.revert) return
  yield* bus.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    to: session.revert.messageID,
  })
})

const plan = Effect.fn("SessionRevert.plan")(function* (
  db: Database.Interface["db"],
  input: BoundaryInput,
  original: Snapshot.ID | undefined,
) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.session.id), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError({ sessionID: input.session.id, messageID: input.messageID })
  if (input.files === false) return new Map<RelativePath, Snapshot.ID>()
  const parentRows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.session.id),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  // Background steps can finish after the parent snapshot; follow the calls being reverted.
  const rows = [...(yield* SessionHistory.withParts(db, parentRows))]
  const seen = new Set(rows.map((row) => row.id))
  for (const row of rows) {
    const message = SessionHistory.decodeMessageRowSync(row)
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool" || tool.name !== "subagent" || tool.state.status === "streaming") continue
      const childID = Schema.decodeUnknownOption(SessionSchema.ID)(tool.state.metadata?.sessionID)
      if (Option.isNone(childID)) continue
      const promptID = Schema.decodeUnknownOption(SessionMessage.ID)(tool.state.metadata?.promptID)
      // Legacy launches own the first prompt. For continuations, match the prompt enqueued during this call.
      const legacyFollowup = Option.isNone(promptID) && tool.state.input.sessionID !== undefined
      const completed = tool.time.completed
      const text = tool.state.input.prompt
      if (legacyFollowup && (!completed || typeof text !== "string")) continue
      const prompts = () => db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
      const inChild = and(eq(SessionMessageTable.session_id, childID.value), eq(SessionMessageTable.type, "user"))
      const admitted = db
        .select({ id: sql<SessionMessage.ID>`json_extract(${EventTable.data}, '$.inboxID')` })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, childID.value),
            eq(
              EventTable.type,
              Event.versionedType(SessionEvent.InboxEnqueued.type, SessionEvent.InboxEnqueued.durable.version),
            ),
            gte(EventTable.created, DateTime.toEpochMillis(tool.time.ran ?? tool.time.created)),
            completed ? lte(EventTable.created, DateTime.toEpochMillis(completed)) : undefined,
          ),
        )
      const [after, ambiguous] = yield* prompts()
        .where(
          and(
            inChild,
            Option.isSome(promptID) ? eq(SessionMessageTable.id, promptID.value) : undefined,
            legacyFollowup && completed
              ? and(
                  eq(sql<string>`json_extract(${SessionMessageTable.data}, '$.text')`, text),
                  or(
                    inArray(SessionMessageTable.id, admitted),
                    and(
                      gte(SessionMessageTable.time_created, DateTime.toEpochMillis(tool.time.ran ?? tool.time.created)),
                      lte(SessionMessageTable.time_created, DateTime.toEpochMillis(completed)),
                    ),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .limit(legacyFollowup ? 2 : 1)
        .all()
        .pipe(Effect.orDie)
      if (!after || ambiguous) continue
      const before = yield* prompts()
        .where(and(inChild, gt(SessionMessageTable.seq, after.seq)))
        .orderBy(asc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const children = yield* db
        .select({ message: SessionMessageTable })
        .from(SessionMessageTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
        .where(
          and(
            eq(SessionTable.id, childID.value),
            eq(SessionTable.parent_id, row.session_id),
            eq(SessionTable.directory, input.session.location.directory),
            input.session.location.workspaceID === undefined
              ? isNull(SessionTable.workspace_id)
              : eq(SessionTable.workspace_id, input.session.location.workspaceID),
            eq(SessionMessageTable.type, "assistant"),
            gt(SessionMessageTable.seq, after.seq),
            before ? lt(SessionMessageTable.seq, before.seq) : undefined,
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const unseen = children.map((child) => child.message).filter((child) => !seen.has(child.id))
      for (const child of unseen) seen.add(child.id)
      rows.push(...(yield* SessionHistory.withParts(db, unseen)))
    }
  }
  const files = new Map<RelativePath, Snapshot.ID>()
  const snapshots = yield* Snapshot.Service
  const last = new Map<RelativePath, { time: number; tree: Snapshot.ID; child: boolean }>()
  const comparisons = new Map<string, Set<RelativePath>>()
  const changed = Effect.fnUntraced(function* (from: Snapshot.ID, to: Snapshot.ID, file: RelativePath) {
    if (from === to) return false
    const key = from + ":" + to
    const cached = comparisons.get(key)
    if (cached) return cached.has(file)
    const paths = new Set(yield* snapshots.files({ from, to }))
    comparisons.set(key, paths)
    return paths.has(file)
  })
  for (const row of rows.toSorted((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))) {
    const message = SessionHistory.decodeMessageRowSync(row)
    if (message.type !== "assistant") continue
    const tree = message.snapshot
    if (!tree?.start) continue
    const child = row.session_id !== input.session.id
    const end = DateTime.toEpochMillis(message.time.completed ?? message.time.created)
    for (const file of tree.files ?? []) {
      const previous = last.get(file)
      // A change between non-overlapping steps belongs to a different writer.
      if (
        !files.has(file) ||
        (previous &&
          (previous.child || child) &&
          previous.time <= row.time_created &&
          (yield* changed(previous.tree, tree.start, file)))
      )
        files.set(file, tree.start)
      if (tree.end && (!previous || previous.time <= end)) last.set(file, { time: end, tree: tree.end, child })
    }
  }
  // Keep the current version if another writer superseded the last delegated edit.
  if (original)
    for (const [file, end] of last) {
      if (end.child && (yield* changed(end.tree, original, file))) files.delete(file)
    }
  return files
})
