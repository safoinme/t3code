import { resolveSidebarParentThreadId, RunId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { sidebarOrganizationRejection } from "./ThreadSidebarOrganization.ts";

type Placement = Parameters<typeof sidebarOrganizationRejection>[0]["thread"];

function placement(
  id: string,
  options: {
    readonly forkOf?: string;
    readonly organization?: Placement["sidebarOrganization"];
    readonly deleted?: boolean;
    readonly archived?: boolean;
  } = {},
) {
  return {
    id: ThreadId.make(id),
    lineage: {
      parentThreadId: options.forkOf === undefined ? null : ThreadId.make(options.forkOf),
      relationshipToParent: options.forkOf === undefined ? null : ("fork" as const),
      rootThreadId: ThreadId.make(options.forkOf ?? id),
    },
    forkedFrom:
      options.forkOf === undefined
        ? null
        : {
            type: "run" as const,
            threadId: ThreadId.make(options.forkOf),
            runId: RunId.make("run-1"),
          },
    ...(options.organization === undefined ? {} : { sidebarOrganization: options.organization }),
    deletedAt: options.deleted ? DateTime.makeUnsafe(0) : null,
    archivedAt: options.archived ? DateTime.makeUnsafe(0) : null,
  };
}

const under = (id: string) => ({ type: "parent" as const, threadId: ThreadId.make(id) });

const reject = (
  threads: ReadonlyArray<ReturnType<typeof placement>>,
  threadId: string,
  organization: Parameters<typeof sidebarOrganizationRejection>[0]["organization"],
) =>
  sidebarOrganizationRejection({
    thread: threads.find((candidate) => candidate.id === threadId)!,
    organization,
    readThread: (id) => Effect.succeed(threads.find((candidate) => candidate.id === id) ?? null),
    // The projection store's rule: drawn children only.
    readChildren: (parentIds) =>
      Effect.succeed(
        threads.flatMap((candidate) => {
          const parentId = resolveSidebarParentThreadId(candidate);
          return candidate.deletedAt === null &&
            candidate.archivedAt === null &&
            parentId !== null &&
            parentIds.includes(parentId)
            ? [candidate.id]
            : [];
        }),
      ),
  });

it.effect("rejects a parent that is a recorded descendant, not only a chosen one", () =>
  Effect.gen(function* () {
    const threads = [placement("source"), placement("fork", { forkOf: "source" })];

    assert.isString(yield* reject(threads, "source", under("fork")));
  }),
);

it.effect("rejects restoring the recorded parent when that would close a cycle", () =>
  Effect.gen(function* () {
    // The fork was moved to the top level, then its source was moved under it.
    const threads = [
      placement("source", { organization: under("fork") }),
      placement("fork", { forkOf: "source", organization: { type: "top-level" } }),
    ];

    assert.isString(yield* reject(threads, "fork", { type: "automatic" }));
    assert.isNull(yield* reject(threads, "fork", { type: "top-level" }));
  }),
);

it.effect("rejects a deleted parent and ends the ancestor walk at a deleted thread", () =>
  Effect.gen(function* () {
    const threads = [
      placement("moved"),
      placement("gone", { deleted: true, organization: under("moved") }),
      placement("child", { organization: under("gone") }),
    ];

    assert.isString(yield* reject(threads, "moved", under("gone")));
    // "gone" would lead back to "moved", but no client nests under a deleted thread.
    assert.isNull(yield* reject(threads, "moved", under("child")));
  }),
);

it.effect("accepts a move whose ancestors already hold an unrelated cycle", () =>
  Effect.gen(function* () {
    const threads = [
      placement("a", { organization: under("b") }),
      placement("b", { organization: under("a") }),
      placement("moved"),
    ];

    assert.isNull(yield* reject(threads, "moved", under("a")));
  }),
);

it.effect("accepts a chosen parent down to a grandchild and refuses a fourth level", () =>
  Effect.gen(function* () {
    const threads = [
      placement("root"),
      placement("child", { organization: under("root") }),
      placement("grandchild", { organization: under("child") }),
      placement("moved"),
    ];

    assert.isNull(yield* reject(threads, "moved", { type: "top-level" }));
    assert.isNull(yield* reject(threads, "moved", under("root")));
    assert.isNull(yield* reject(threads, "moved", under("child")));
    assert.match(
      (yield* reject(threads, "moved", under("grandchild"))) ?? "",
      /fourth sidebar level/,
    );
  }),
);

it.effect("counts the threads that move with a thread against the depth limit", () =>
  Effect.gen(function* () {
    const threads = [
      placement("root"),
      placement("child", { organization: under("root") }),
      placement("moved"),
      placement("moved-child", { organization: under("moved") }),
      placement("moved-grandchild", { forkOf: "moved-child" }),
      placement("other"),
      placement("other-child", { organization: under("other") }),
    ];

    // root > other > other-child fits; other-child would be a fourth level under "child".
    assert.isNull(yield* reject(threads, "other", under("root")));
    assert.isString(yield* reject(threads, "other", under("child")));
    // "moved" carries two levels, so it only fits at the top.
    assert.isString(yield* reject(threads, "moved", under("root")));
    assert.isNull(yield* reject(threads, "moved", { type: "top-level" }));
  }),
);

it.effect("never refuses recorded ancestry or the ways back for depth", () =>
  Effect.gen(function* () {
    // A recorded chain four forks deep, with the deepest one moved to the top.
    const threads = [
      placement("source"),
      placement("fork-1", { forkOf: "source" }),
      placement("fork-2", { forkOf: "fork-1" }),
      placement("fork-3", { forkOf: "fork-2" }),
      placement("fork-4", { forkOf: "fork-3", organization: { type: "top-level" } }),
    ];

    assert.isNull(yield* reject(threads, "fork-4", { type: "automatic" }));
    assert.isNull(yield* reject(threads, "fork-3", { type: "top-level" }));
    // A chosen parent is still held to the limit, wherever the chain came from.
    assert.isString(yield* reject(threads, "fork-4", under("fork-2")));
    assert.isNull(yield* reject(threads, "fork-4", under("fork-1")));
  }),
);

it.effect("counts depth from an archived ancestor, where clients draw a new root", () =>
  Effect.gen(function* () {
    const threads = [
      placement("archived-root", { archived: true }),
      placement("child", { organization: under("archived-root") }),
      placement("grandchild", { organization: under("child") }),
      placement("moved"),
      placement("moved-archived-child", { organization: under("moved"), archived: true }),
    ];

    // "child" is drawn as a root while its parent is archived, so
    // "grandchild" is at depth 1 and can still take a thread.
    assert.isNull(yield* reject(threads, "moved", under("grandchild")));
    // An archived ancestor still closes a cycle.
    assert.isString(yield* reject(threads, "archived-root", under("grandchild")));
  }),
);
