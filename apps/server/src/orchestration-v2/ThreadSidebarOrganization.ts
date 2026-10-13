import {
  resolveSidebarParentThreadId,
  SIDEBAR_TREE_MAX_DEPTH,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadSidebarOrganization,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

type SidebarPlacement = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "forkedFrom" | "sidebarOrganization" | "creatorThreadId"
>;

/**
 * Held while a command that changes sidebar placement is validated and
 * committed. Placements are the only edges of the sidebar graph that change
 * after a thread exists, so one holder at a time means the cycle check always
 * reads the graph its own commit lands on: two crossing moves cannot both pass.
 *
 * Take it inside the moved thread's command lock and take no thread lock
 * while holding it.
 */
export class ThreadSidebarOrganizationLock extends Context.Service<
  ThreadSidebarOrganizationLock,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadSidebarOrganization/ThreadSidebarOrganizationLock") {}

export const layerLock = Layer.effect(
  ThreadSidebarOrganizationLock,
  Effect.map(Semaphore.make(1), (semaphore) =>
    ThreadSidebarOrganizationLock.of({ withLock: (effect) => semaphore.withPermit(effect) }),
  ),
);

/**
 * Why a sidebar placement cannot be stored, or null when it can.
 *
 * The walk follows the parent every client would render, so it also catches a
 * cycle closed through a recorded fork or subagent parent, including one that
 * restoring `automatic` would reopen. `readThread` returns null for a thread
 * that does not exist; a deleted thread ends the chain because clients never
 * nest under it.
 *
 * A chosen parent must also keep the thread, and every thread nested under
 * it, within SIDEBAR_TREE_MAX_DEPTH. `readChildren` returns the threads drawn
 * directly under any of the given threads: not archived, not deleted, and
 * with one of them as their sidebar parent. `automatic` and `top-level` are
 * never refused for depth, so there is always a way back out of a tree.
 *
 * Call it under ThreadSidebarOrganizationLock, or the answer can be stale by
 * the time the placement is stored.
 */
export const sidebarOrganizationRejection = <E>(input: {
  readonly thread: SidebarPlacement;
  readonly organization: OrchestrationV2ThreadSidebarOrganization;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    (SidebarPlacement & Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt">) | null,
    E
  >;
  readonly readChildren: (
    parentIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, E>;
}): Effect.Effect<string | null, E> =>
  Effect.gen(function* () {
    const { thread, organization, readThread, readChildren } = input;
    if (organization.type === "parent") {
      if (organization.threadId === thread.id) {
        return `Thread ${thread.id} cannot be its own sidebar parent.`;
      }
      const parent = yield* readThread(organization.threadId);
      if (parent === null || parent.deletedAt !== null) {
        return `Sidebar parent ${organization.threadId} does not exist.`;
      }
    }
    const visited = new Set<ThreadId>([thread.id]);
    // The thread's depth: its ancestors up to the first archived one, which
    // clients leave out, so the thread below it is drawn as a root.
    let depth = 0;
    let countingDepth = true;
    let ancestorId = resolveSidebarParentThreadId({ ...thread, sidebarOrganization: organization });
    while (ancestorId !== null) {
      if (ancestorId === thread.id) {
        return `Thread ${thread.id} cannot sit under one of its own sidebar descendants.`;
      }
      // A cycle that does not include this thread predates the command.
      if (visited.has(ancestorId)) return null;
      visited.add(ancestorId);
      const ancestor = yield* readThread(ancestorId);
      if (ancestor === null || ancestor.deletedAt !== null) break;
      if (ancestor.archivedAt !== null) countingDepth = false;
      if (countingDepth) depth += 1;
      ancestorId = resolveSidebarParentThreadId(ancestor);
    }
    if (organization.type !== "parent") return null;
    if (depth > SIDEBAR_TREE_MAX_DEPTH) {
      return `Thread ${thread.id} cannot sit under ${organization.threadId}: it would be on a fourth sidebar level, and a tree has three.`;
    }
    // The threads nested under this one move with it. Read one level at a
    // time and stop at the first level that would not fit.
    let level: ReadonlyArray<ThreadId> = [thread.id];
    for (let nestedDepth = depth + 1; level.length > 0; nestedDepth += 1) {
      level = (yield* readChildren(level)).filter((childId) => !visited.has(childId));
      if (level.length === 0) break;
      if (nestedDepth > SIDEBAR_TREE_MAX_DEPTH) {
        return `Thread ${thread.id} cannot sit under ${organization.threadId}: a thread nested under it would be on a fourth sidebar level, and a tree has three.`;
      }
      for (const childId of level) visited.add(childId);
    }
    return null;
  });
