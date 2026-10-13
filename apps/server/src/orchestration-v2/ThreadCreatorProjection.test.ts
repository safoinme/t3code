import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  resolveSidebarParentThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { sidebarOrganizationRejection } from "./ThreadSidebarOrganization.ts";

const creatorProvenance = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const later = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const rootId = ThreadId.make("root");
  const otherId = ThreadId.make("other");
  const create = (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) => {
    const threadId = ThreadId.make(id);
    const thread: OrchestrationV2AppThread = {
      createdBy: "agent",
      creationSource: "mcp",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Ordinary conversation",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...overrides,
    };
    return store
      .apply({
        id: EventId.make(`create:${id}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  const message = (
    threadId: ThreadId,
    id: string,
    senderThreadId: ThreadId,
    initial: boolean,
    createdBy: "agent" | "user" = "agent",
  ) =>
    store.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId,
      occurredAt: initial ? now : later,
      payload: {
        id: MessageId.make(id),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Task",
        attachments: [],
        streaming: false,
        createdBy,
        creationSource: "mcp",
        senderThreadId,
        createdAt: initial ? now : later,
        updatedAt: initial ? now : later,
      },
    });
  yield* create(rootId, { createdBy: "user", creationSource: "web", creatorThreadId: null });
  yield* create(otherId, { creatorThreadId: null });
  const launched = yield* create("mcp:launch-request");
  yield* message(launched.id, launched.id, rootId, true);
  yield* message(launched.id, "message:mcp:session:thread-send:later", otherId, false);
  const batched = yield* create("thread:mcp:session:request:0");
  yield* message(batched.id, "message:mcp:session:request:0", launched.id, true);
  const tied = yield* create("thread:mcp:session:Z:0");
  yield* message(tied.id, "message:mcp:session:Z:0", rootId, true);
  // Same immutable createdAt; binary ID ordering must select the initial dispatch.
  yield* message(tied.id, "message:mcp:session:thread-send:tie", otherId, true);
  const tiedChild = yield* create("tie-child", { creatorThreadId: tied.id });
  const unknown = yield* create("mcp:legacy-no-prompt");
  // A first post-creation dispatch from another agent is not a creator.
  yield* message(unknown.id, "message:mcp:different:thread-send:first", otherId, false);
  const emptyBatch = yield* create("thread:mcp:session:no-prompt:0");
  yield* message(emptyBatch.id, "message:mcp:different:thread-send:batch-first", otherId, false);
  const explicitNone = yield* create("mcp:new-unknown", { creatorThreadId: null });
  yield* message(explicitNone.id, explicitNone.id, otherId, true);
  const explicitCreator = yield* create("new-no-prompt", { creatorThreadId: rootId });
  yield* message(explicitCreator.id, "sent-later", otherId, false);
  const humanFirst = yield* create("mcp:human-first");
  yield* message(humanFirst.id, "first-human-message", rootId, true, "user");
  yield* message(humanFirst.id, humanFirst.id, otherId, false);
  const humanCreated = yield* create("mcp:human-created", { createdBy: "user" });
  yield* message(humanCreated.id, humanCreated.id, otherId, true);
  const ambiguous = yield* create("thread:mcp:session:thread-send:0");
  yield* message(ambiguous.id, "message:mcp:session:thread-send:0", otherId, false);
  const delegated = yield* create("delegated", {
    lineage: { parentThreadId: rootId, relationshipToParent: "subagent", rootThreadId: rootId },
  });
  yield* message(delegated.id, delegated.id, otherId, true);
  const moved = yield* create("manual-top", {
    creatorThreadId: rootId,
    sidebarOrganization: { type: "top-level" },
  });
  const manualParent = yield* create("manual-parent", {
    creatorThreadId: rootId,
    sidebarOrganization: { type: "parent", threadId: otherId },
  });
  const expected = new Map([
    [launched.id, rootId],
    [batched.id, launched.id],
    [tied.id, rootId],
    [tiedChild.id, tied.id],
    [unknown.id, null],
    [emptyBatch.id, null],
    [explicitNone.id, null],
    [explicitCreator.id, rootId],
    [humanFirst.id, null],
    [humanCreated.id, null],
    [ambiguous.id, null],
    [delegated.id, null],
    [moved.id, rootId],
    [manualParent.id, rootId],
  ]);
  const snapshot = yield* store.getShellSnapshot();
  for (const [id, creator] of expected) {
    assert.strictEqual(
      snapshot.threads.find((thread) => thread.id === id)?.creatorThreadId,
      creator,
    );
    assert.strictEqual((yield* store.getThreadShell(id))?.creatorThreadId, creator);
    assert.strictEqual((yield* store.getThread(id)).creatorThreadId, creator);
  }
  assert.sameMembers(
    [...(yield* store.getSidebarChildThreadIds([rootId]))],
    [launched.id, explicitCreator.id, delegated.id, tied.id],
  );
  assert.deepEqual(yield* store.getSidebarChildThreadIds([launched.id]), [batched.id]);
  assert.deepEqual(yield* store.getSidebarChildThreadIds([tied.id]), [tiedChild.id]);
  assert.deepEqual(yield* store.getSidebarChildThreadIds([otherId]), [manualParent.id]);
  assert.isNull(resolveSidebarParentThreadId(yield* store.getThread(moved.id)));
  const rejection = (thread: OrchestrationV2AppThread, threadId: ThreadId) =>
    sidebarOrganizationRejection({
      thread,
      organization: { type: "parent", threadId },
      readThread: (id) => store.getThread(id),
      readChildren: (ids) => store.getSidebarChildThreadIds(ids),
    });
  // Recovered ancestry must also govern cycle, creation-depth and move-depth validation.
  assert.isString(yield* rejection(yield* store.getThread(rootId), batched.id));
  assert.isString(yield* rejection(yield* store.getThread(otherId), batched.id));
  const candidate = yield* create("candidate");
  assert.isString(yield* rejection(candidate, batched.id));
  assert.isString(yield* rejection(candidate, tiedChild.id));
  assert.isString(yield* rejection(yield* store.getThread(rootId), tiedChild.id));
});

it.effect(
  "memory projection recovers only proven initial creators and preserves placement validation",
  () => creatorProvenance.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
it.effect("SQLite message identity columns use BINARY collation for timestamp ties", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string | null; readonly coll: string }>`
      SELECT name, coll FROM pragma_index_xinfo('sqlite_autoindex_orchestration_v2_projection_messages_1')
    `;
    assert.strictEqual(columns.find((column) => column.name === "message_id")?.coll, "BINARY");
    const comparison = yield* sql<{ readonly before: number }>`
      SELECT 'message:mcp:session:Z:0' < 'message:mcp:session:thread-send:later' COLLATE BINARY AS before
    `;
    assert.strictEqual(comparison[0]?.before, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
it.effect(
  "SQL projection recovers only proven initial creators and preserves placement validation",
  () =>
    creatorProvenance.pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
);
