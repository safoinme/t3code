import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildThreadActionMenuItems } from "../components/threadActionMenu.logic";
import { waitForAtomValue } from "../state/waitForAtomValue";
import type { ThreadSidebarOrganizationThread } from "./useThreadSidebarOrganization";

const environmentId = EnvironmentId.make("environment-1");
const SHELL_WAIT_TIMEOUT_MS = 5_000;

type ShellThread = ThreadSidebarOrganizationThread & { readonly archivedAt: string | null };

const testState = vi.hoisted(() => {
  const milestone = () => {
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    return { reach: () => reach(), reached };
  };
  return {
    milestone,
    createThread: vi.fn(),
    setSidebarOrganization: vi.fn(),
    setFamilyExpansion: vi.fn(),
    toasts: [] as Array<{ readonly title: string; readonly description: string }>,
    shells: [] as Array<unknown>,
    waitForThreadShell: (_ref: unknown): Promise<boolean> => Promise.resolve(false),
    onToast: () => undefined as void,
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/ThreadMoveUnderDialog", () => ({ requestThreadMoveTarget: vi.fn() }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: <T>(toast: T) => toast,
  toastManager: {
    add: (toast: { readonly title: string; readonly description: string }) => {
      testState.toasts.push(toast);
      testState.onToast();
    },
  },
}));
vi.mock("../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/utils")>()),
  newThreadId: () => "thread-child",
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsSidebarOrganization: () => true,
  readProject: () => null,
  readThreadShells: () => testState.shells,
  waitForThreadShell: (ref: unknown) => testState.waitForThreadShell(ref),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({
  threadEnvironment: { create: "create", setSidebarOrganization: "set-sidebar-organization" },
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) =>
    command === "create" ? testState.createThread : testState.setSidebarOrganization,
}));
vi.mock("./useLocalStorage", () => ({
  useLocalStorage: () => [{}, testState.setFamilyExpansion],
}));

import { useThreadSidebarOrganization } from "./useThreadSidebarOrganization";

function thread(
  id: string,
  options: {
    readonly organization?: ShellThread["sidebarOrganization"];
    readonly archived?: boolean;
  } = {},
): ShellThread {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project-infra"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    interactionMode: "default",
    branch: "feature/costs",
    worktreePath: "/worktrees/costs",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(id),
    },
    forkedFrom: null,
    ...(options.organization === undefined ? {} : { sidebarOrganization: options.organization }),
    archivedAt: options.archived ? "2026-01-02T00:00:00.000Z" : null,
  };
}

/**
 * The hook under a client store this test owns. `waitForThreadShell` is the
 * real subscription wait over `shellAtom`, standing in for the thread's shell
 * atom; `waiting` is reached once the hook is subscribed to it.
 */
function setup() {
  const registry = AtomRegistry.make();
  const shellAtom = Atom.make<ScopedThreadRef | null>(null);
  const waiting = testState.milestone();
  const navigated = testState.milestone();
  const toasted = testState.milestone();
  const navigateToThread = vi.fn((_ref: ScopedThreadRef) => navigated.reach());

  testState.toasts.length = 0;
  testState.shells = [];
  testState.onToast = toasted.reach;
  testState.setFamilyExpansion.mockClear();
  testState.setSidebarOrganization.mockReset();
  testState.setSidebarOrganization.mockResolvedValue(AsyncResult.success(undefined));
  testState.createThread.mockReset();
  testState.createThread.mockResolvedValue(AsyncResult.success(undefined));
  testState.waitForThreadShell = () => {
    const ready = waitForAtomValue({
      registry,
      atom: shellAtom,
      predicate: (shell) => shell !== null,
      timeoutMs: SHELL_WAIT_TIMEOUT_MS,
    });
    waiting.reach();
    return ready;
  };

  return {
    organization: useThreadSidebarOrganization({ navigateToThread }),
    navigateToThread,
    shellArrives: () => registry.set(shellAtom, childRef),
    waiting: waiting.reached,
    navigated: navigated.reached,
    toasted: toasted.reached,
  };
}

const parent = thread("thread-parent");
const childRef = scopeThreadRef(environmentId, ThreadId.make("thread-child"));

afterEach(() => {
  vi.useRealTimers();
});

describe("New subthread", () => {
  it("opens the subthread only once it has reached the client store", async () => {
    const harness = setup();

    harness.organization.runMenuAction("new-subthread", parent);
    await Promise.race([harness.waiting, harness.navigated]);

    // The receipt is in and the shell is not: opening now would land on the
    // thread route's missing-thread redirect and on another conversation.
    expect(testState.createThread).toHaveBeenCalledOnce();
    expect(harness.navigateToThread).not.toHaveBeenCalled();

    harness.shellArrives();
    await harness.navigated;

    expect(harness.navigateToThread).toHaveBeenCalledExactlyOnceWith(childRef);
    expect(testState.toasts).toEqual([]);
  });

  it("opens a subthread whose shell arrived before the receipt", async () => {
    const harness = setup();
    harness.shellArrives();

    harness.organization.runMenuAction("new-subthread", parent);
    await harness.navigated;

    expect(harness.navigateToThread).toHaveBeenCalledExactlyOnceWith(childRef);
  });

  it("creates it on the parent's project and workspace, placed under the parent", async () => {
    const harness = setup();
    harness.shellArrives();

    harness.organization.runMenuAction("new-subthread", parent);
    await harness.navigated;

    expect(testState.createThread).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: expect.objectContaining({
        threadId: childRef.threadId,
        projectId: parent.projectId,
        modelSelection: parent.modelSelection,
        interactionMode: parent.interactionMode,
        branch: parent.branch,
        worktreePath: parent.worktreePath,
        sidebarParentThreadId: parent.id,
      }),
    });
  });

  it("says the subthread was saved when it never reaches the client, and opens nothing", async () => {
    vi.useFakeTimers();
    const harness = setup();

    harness.organization.runMenuAction("new-subthread", parent);
    await harness.waiting;
    await vi.advanceTimersByTimeAsync(SHELL_WAIT_TIMEOUT_MS);
    await harness.toasted;

    expect(harness.navigateToThread).not.toHaveBeenCalled();
    expect(testState.toasts).toEqual([
      expect.objectContaining({
        type: "error",
        title: "Subthread created, but it could not be opened",
      }),
    ]);
    // The saved subthread stays findable under its parent.
    expect(testState.setFamilyExpansion).toHaveBeenCalledOnce();
  });

  it("neither waits nor opens anything when the subthread could not be created", async () => {
    const harness = setup();
    testState.createThread.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Project is gone."))),
    );

    harness.organization.runMenuAction("new-subthread", parent);
    await harness.toasted;

    expect(testState.toasts).toEqual([
      expect.objectContaining({
        title: "Could not create subthread",
        description: "Project is gone.",
      }),
    ]);
    expect(harness.navigateToThread).not.toHaveBeenCalled();
    expect(testState.setFamilyExpansion).not.toHaveBeenCalled();
  });
});

describe("New subthread at the depth limit", () => {
  it("is offered on a root and a child and not on a grandchild", () => {
    const harness = setup();
    const root = thread("thread-root");
    const child = thread("thread-nested", {
      organization: { type: "parent", threadId: root.id },
    });
    const grandchild = thread("thread-grandchild", {
      organization: { type: "parent", threadId: child.id },
    });
    const lone = thread("thread-lone");
    testState.shells = [root, child, grandchild, lone];

    expect(harness.organization.readMenuState(root)?.canAddSubthread).toBe(true);
    expect(harness.organization.readMenuState(child)?.canAddSubthread).toBe(true);
    expect(harness.organization.readMenuState(grandchild)?.canAddSubthread).toBe(false);
    // The root carries two levels, so not even an unrelated root can take it,
    // while that lone root can still go under the root or the child.
    expect(harness.organization.readMenuState(root)?.hasMoveTargets).toBe(false);
    expect(harness.organization.readMenuState(lone)?.hasMoveTargets).toBe(true);
  });
});

describe("Move to top level", () => {
  const under = (id: string) => ({ type: "parent" as const, threadId: ThreadId.make(id) });
  const offersMoveToTopLevel = (
    organization: ReturnType<typeof setup>["organization"],
    candidate: ShellThread,
  ) =>
    buildThreadActionMenuItems({
      canOperate: true,
      branch: null,
      projectFilter: null,
      sidebarTree: organization.readMenuState(candidate),
      lifecycleOwnedByParent: false,
      isPinned: false,
      isSettled: false,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: true,
        autoSettleOptOut: true,
        snooze: true,
        pinning: true,
        titleRegeneration: true,
      },
      snoozePresets: [],
    }).some((item) => item.id === "move-to-top-level");

  it("is offered while the stored parent is archived or missing, so the thread can stop returning to it", () => {
    const harness = setup();
    const underArchived = thread("thread-a", { organization: under("thread-archived") });
    const underMissing = thread("thread-b", { organization: under("thread-missing") });
    testState.shells = [
      thread("thread-archived", { archived: true }),
      thread("thread-other"),
      underArchived,
      underMissing,
    ];

    expect(offersMoveToTopLevel(harness.organization, underArchived)).toBe(true);
    expect(offersMoveToTopLevel(harness.organization, underMissing)).toBe(true);

    harness.organization.runMenuAction("move-to-top-level", underArchived);

    // Only the stored placement is written; nothing addresses lineage.
    expect(testState.setSidebarOrganization).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: underArchived.id, organization: { type: "top-level" } },
    });
  });

  it("is not offered for a thread with no stored parent", () => {
    const harness = setup();
    const explicitTopLevel = thread("thread-a", { organization: { type: "top-level" } });
    const neverNested = thread("thread-b");
    testState.shells = [thread("thread-other"), explicitTopLevel, neverNested];

    expect(offersMoveToTopLevel(harness.organization, explicitTopLevel)).toBe(false);
    expect(offersMoveToTopLevel(harness.organization, neverNested)).toBe(false);
  });
});
