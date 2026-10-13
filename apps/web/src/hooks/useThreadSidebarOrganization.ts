import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  resolveSidebarParentThreadId,
  type OrchestrationV2ThreadSidebarOrganization,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import {
  canAddSidebarSubthread,
  listSidebarMoveTargets,
  sidebarOrdinaryGroupKey,
  sidebarThreadKey,
} from "../components/Sidebar.tree";
import type {
  ThreadActionMenuId,
  ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { requestThreadMoveTarget } from "../components/ThreadMoveUnderDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentSupportsSidebarOrganization,
  readProject,
  readThreadShells,
  waitForThreadShell,
} from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import type { SidebarThreadSummary } from "../types";
import { useLocalStorage } from "./useLocalStorage";

// The user's open/closed choice per family parent, by scoped thread key.
// Ordinary v2 and subagent choices are separate; old parent keys remain for
// fork/manual families that existed before creator grouping.
export const THREAD_FAMILY_EXPANDED_KEY = "t3code:sidebar:thread-family-expanded";
export const ThreadFamilyExpansion = Schema.Record(Schema.String, Schema.Boolean);

const SIDEBAR_TREE_ACTIONS = [
  "new-subthread",
  "move-under",
  "move-to-top-level",
  "return-to-recorded-parent",
] as const satisfies ReadonlyArray<ThreadActionMenuId>;
export type ThreadSidebarTreeAction = (typeof SIDEBAR_TREE_ACTIONS)[number];

export function isThreadSidebarTreeAction(
  action: ThreadActionMenuId,
): action is ThreadSidebarTreeAction {
  return SIDEBAR_TREE_ACTIONS.some((candidate) => candidate === action);
}

/** The thread fields the tree actions read; every thread shell has them. */
export type ThreadSidebarOrganizationThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "modelSelection"
  | "interactionMode"
  | "branch"
  | "worktreePath"
  | "lineage"
  | "forkedFrom"
  | "sidebarOrganization"
  | "creatorThreadId"
>;

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The sidebar tree actions of the thread menu: New subthread, Move under,
 * Move to top level and Return to original parent. The sidebar row menu and
 * the chat header menu both go through this, so one capability gate and one
 * set of rules decides what each offers. Every action is sidebar organization
 * only: the conversation, its lineage and its workspace stay as they are, and
 * the server validates the parent and rejects cycles.
 */
export function useThreadSidebarOrganization(input: {
  readonly navigateToThread: (threadRef: ScopedThreadRef) => unknown;
}) {
  const { navigateToThread } = input;
  const setThreadSidebarOrganization = useOrchestrationCommand(
    threadEnvironment.setSidebarOrganization,
    { reportFailure: false },
  );
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const [, setFamilyExpansion] = useLocalStorage(
    THREAD_FAMILY_EXPANDED_KEY,
    {},
    ThreadFamilyExpansion,
  );

  const organizeThread = useCallback(
    (threadRef: ScopedThreadRef, organization: OrchestrationV2ThreadSidebarOrganization) => {
      if (organization.type === "parent") {
        // Open the destination so the moved thread does not vanish into it.
        const parentKey = scopedThreadKey(
          scopeThreadRef(threadRef.environmentId, organization.threadId),
        );
        setFamilyExpansion((current) => ({
          ...current,
          [sidebarOrdinaryGroupKey(parentKey)]: true,
        }));
      }
      void (async () => {
        const result = await setThreadSidebarOrganization({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, organization },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to move thread", squashAtomCommandFailure(result));
        }
      })();
    },
    [setFamilyExpansion, setThreadSidebarOrganization],
  );

  // A subthread is a separate conversation that starts on its parent's
  // project, branch and worktree. It is not a fork (no shared history) and
  // not a delegated task (the parent never waits on it); only the sidebar
  // places it under the parent. It takes permissions from the project's
  // defaults and the project's default model, falling back to the parent's
  // model when the project sets none. Only the working mode carries over.
  const createSubthread = useCallback(
    (parent: ThreadSidebarOrganizationThread) => {
      void (async () => {
        const threadRef = scopeThreadRef(parent.environmentId, newThreadId());
        const { settings } = resolveProjectSettings(
          appAtomRegistry.get(environmentServerConfigsAtom).get(parent.environmentId)?.settings ??
            DEFAULT_SERVER_SETTINGS,
          parent.projectId,
          readProject(scopeProjectRef(parent.environmentId, parent.projectId)),
        );
        const result = await createThread({
          environmentId: parent.environmentId,
          input: {
            threadId: threadRef.threadId,
            projectId: parent.projectId,
            title: "New thread",
            modelSelection: settings.defaultModelSelection ?? parent.modelSelection,
            runtimeMode: settings.defaultRuntimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            sidebarParentThreadId: parent.id,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            failureToast("Could not create subthread", squashAtomCommandFailure(result));
          }
          return;
        }
        // The subthread is saved from here on, so open its family whether or
        // not the client goes on to open the conversation.
        setFamilyExpansion((current) => ({
          ...current,
          [sidebarOrdinaryGroupKey(sidebarThreadKey(parent))]: true,
        }));
        // The command's receipt can arrive before the thread reaches this
        // client. The thread route treats a thread it cannot find as missing
        // and leaves for another conversation, so wait for the shell first.
        if (!(await waitForThreadShell(threadRef))) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Subthread created, but it could not be opened",
              description:
                "It was saved under its parent, but its thread data did not reach this client. Reconnect and open it from the sidebar.",
            }),
          );
          return;
        }
        void navigateToThread(threadRef);
      })();
    },
    [createThread, navigateToThread, setFamilyExpansion],
  );

  // Every eligible thread in the environment, newest activity first: nested,
  // snoozed and settled ones too, which no row in view may be showing.
  const moveUnder = useCallback(
    (thread: ThreadSidebarOrganizationThread) => {
      void (async () => {
        const targets = listSidebarMoveTargets(
          new Map(readThreadShells().map((shell) => [sidebarThreadKey(shell), shell])),
          sidebarThreadKey(thread),
        ).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const targetKey = await requestThreadMoveTarget({
          threadTitle: thread.title.trim() || "Untitled thread",
          targets: targets.map((target) => ({
            key: sidebarThreadKey(target),
            title: target.title.trim() || "Untitled thread",
            projectName:
              readProject(scopeProjectRef(target.environmentId, target.projectId))?.title ?? null,
          })),
        });
        const targetRef = targetKey === null ? null : parseScopedThreadKey(targetKey);
        if (targetRef === null) return;
        organizeThread(scopeThreadRef(thread.environmentId, thread.id), {
          type: "parent",
          threadId: targetRef.threadId,
        });
      })();
    },
    [organizeThread],
  );

  return useMemo(
    () => ({
      organizeThread,
      /** The menu's `sidebarTree` state, or null when the thread's server cannot store a placement. */
      readMenuState: (
        thread: ThreadSidebarOrganizationThread,
      ): ThreadActionMenuState["sidebarTree"] => {
        if (!readEnvironmentSupportsSidebarOrganization(thread.environmentId)) return null;
        const threadByKey = new Map(
          readThreadShells().map((shell) => [sidebarThreadKey(shell), shell]),
        );
        return {
          canAddSubthread: canAddSidebarSubthread(threadByKey, sidebarThreadKey(thread)),
          // Whether or not the parent is in the list. While it is archived or
          // missing the thread is drawn at the top, but the stored parent
          // still takes it back when it returns, and this is the way out.
          hasSidebarParent: resolveSidebarParentThreadId(thread) !== null,
          canReturnToRecordedParent:
            (thread.sidebarOrganization?.type === "top-level" ||
              thread.sidebarOrganization?.type === "parent") &&
            resolveSidebarParentThreadId({
              lineage: thread.lineage,
              forkedFrom: thread.forkedFrom,
              creatorThreadId: thread.creatorThreadId,
            }) !== null,
          hasMoveTargets: listSidebarMoveTargets(threadByKey, sidebarThreadKey(thread)).length > 0,
        };
      },
      runMenuAction: (action: ThreadSidebarTreeAction, thread: ThreadSidebarOrganizationThread) => {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        switch (action) {
          case "new-subthread":
            createSubthread(thread);
            return;
          case "move-under":
            moveUnder(thread);
            return;
          case "move-to-top-level":
            organizeThread(threadRef, { type: "top-level" });
            return;
          case "return-to-recorded-parent":
            organizeThread(threadRef, { type: "automatic" });
            return;
        }
      },
    }),
    [createSubthread, moveUnder, organizeThread],
  );
}
