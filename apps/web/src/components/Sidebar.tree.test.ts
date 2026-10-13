import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { filterSidebarV2VisibleThreads } from "./Sidebar.logic";
import {
  buildSidebarSearchRows,
  buildSidebarThreadTree,
  canAddSidebarSubthread,
  canNestSidebarThreadUnder,
  flattenSidebarFamily,
  isSidebarLifecycleOwnedByParent,
  listSidebarMoveTargets,
  resolveSidebarFamilyExpanded,
  resolveSidebarOrdinaryExpanded,
  resolveSidebarFamilySection,
  sidebarAncestorKeys,
  sidebarNestedConversations,
  sidebarFamilyGroupKinds,
  sidebarOrdinaryGroupKey,
  sidebarSubagentGroupKey,
  sidebarThreadKey,
  stepSidebarSearchRow,
  summarizeSidebarDescendants,
  summarizeSidebarFamilyGroup,
} from "./Sidebar.tree";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");

type TreeThread = Parameters<typeof buildSidebarThreadTree>[0]["threads"][number] & {
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
};

let createdAtTick = 0;
function thread(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly projectId?: string;
    readonly archived?: boolean;
    readonly forkOf?: string;
    readonly subagentOf?: string;
    readonly creator?: string;
    readonly organization?: TreeThread["sidebarOrganization"];
    readonly createdAt?: string;
  } = {},
): TreeThread {
  const parent = options.forkOf ?? options.subagentOf ?? null;
  createdAtTick += 1;
  return {
    id: ThreadId.make(id),
    environmentId: options.environmentId ?? local,
    projectId: ProjectId.make(options.projectId ?? "project-a"),
    createdAt:
      options.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, createdAtTick)).toISOString(),
    lineage: {
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent:
        options.forkOf !== undefined
          ? "fork"
          : options.subagentOf !== undefined
            ? "subagent"
            : null,
      rootThreadId: ThreadId.make(parent ?? id),
    },
    forkedFrom:
      options.forkOf === undefined
        ? null
        : { type: "run", threadId: ThreadId.make(options.forkOf), runId: RunId.make("run-1") },
    ...(options.organization === undefined ? {} : { sidebarOrganization: options.organization }),
    ...(options.creator === undefined ? {} : { creatorThreadId: ThreadId.make(options.creator) }),
    archivedAt: options.archived ? "2026-01-02T00:00:00.000Z" : null,
  };
}

const under = (id: string) => ({ type: "parent" as const, threadId: ThreadId.make(id) });
const build = (threads: ReadonlyArray<TreeThread>) => buildSidebarThreadTree({ threads });
const ids = (threads: ReadonlyArray<TreeThread> | undefined) =>
  (threads ?? []).map((candidate) => candidate.id);
const key = (id: string, environmentId = local) =>
  sidebarThreadKey({ environmentId, id: ThreadId.make(id) });

describe("buildSidebarThreadTree", () => {
  it("hides delegated rows while retaining ordinary agent tasks, parent fallback and search", () => {
    const hiddenAgent = thread("agent", { subagentOf: "root" });
    const movedAgent = thread("moved-agent", {
      subagentOf: "root",
      organization: { type: "top-level" },
    });
    const creatorTask = { ...thread("creator-task", { creator: "agent" }), createdBy: "agent" };
    const manualTask = thread("manual-task", { organization: under("moved-agent") });
    const ordinary = thread("ordinary", { creator: "root" });
    const tree = build(
      filterSidebarV2VisibleThreads(
        [
          thread("root"),
          hiddenAgent,
          movedAgent,
          creatorTask,
          manualTask,
          ordinary,
          thread("grandchild", { creator: "ordinary" }),
        ],
        null,
      ),
    );
    expect(ids(tree.roots)).toEqual(["root", "creator-task", "manual-task"]);
    expect(sidebarFamilyGroupKinds(tree, key("root"))).toEqual(["ordinary"]);
    expect(sidebarFamilyGroupKinds(tree, key("creator-task"))).toBeNull();
    expect(
      flattenSidebarFamily(tree, key("root"), {
        isExpanded: () => true,
        isSubagentsExpanded: () => true,
        revealKey: key("agent"),
      }).map((row) => [row.thread.id, row.depth]),
    ).toEqual([
      ["ordinary", 1],
      ["grandchild", 2],
    ]);
    expect(buildSidebarSearchRows(tree, [key("agent"), key("moved-agent")])).toEqual([]);
    expect(
      buildSidebarSearchRows(tree, [key("creator-task"), key("manual-task")]).map(
        (row) => row.thread.id,
      ),
    ).toEqual(["creator-task", "manual-task"]);
    expect(creatorTask.creatorThreadId).toBe("agent");
    expect(manualTask.sidebarOrganization).toEqual(under("moved-agent"));
  });
  it("nests forks and subagents under their recorded parent", () => {
    const tree = build([
      thread("root"),
      thread("fork", { forkOf: "root" }),
      thread("agent", { subagentOf: "fork" }),
    ]);

    expect(ids(tree.roots)).toEqual(["root"]);
    expect(ids(tree.childrenByKey.get(key("root")))).toEqual(["fork"]);
    expect(ids(tree.childrenByKey.get(key("fork")))).toEqual(["agent"]);
  });

  it("keeps a thread at the top level when the user chose that over its lineage", () => {
    const tree = build([
      thread("root"),
      thread("fork", { forkOf: "root", organization: { type: "top-level" } }),
    ]);

    expect(ids(tree.roots)).toEqual(["root", "fork"]);
    expect(tree.childrenByKey.get(key("root"))).toBeUndefined();
  });

  it("follows a chosen parent across projects instead of the recorded one", () => {
    const tree = build([
      thread("root"),
      thread("other", { projectId: "project-b" }),
      thread("fork", { forkOf: "root", organization: under("other") }),
    ]);

    expect(ids(tree.childrenByKey.get(key("other")))).toEqual(["fork"]);
    expect(tree.childrenByKey.get(key("root"))).toBeUndefined();
  });

  it("returns to the recorded parent when the choice is automatic again", () => {
    const tree = build([
      thread("root"),
      thread("fork", { forkOf: "root", organization: { type: "automatic" } }),
    ]);

    expect(ids(tree.childrenByKey.get(key("root")))).toEqual(["fork"]);
  });

  it("never attaches a thread to a same-id parent in another environment", () => {
    const tree = build([
      thread("shared", { environmentId: remote }),
      thread("child", { organization: under("shared") }),
      thread("shared"),
      thread("remote-child", { environmentId: remote, organization: under("shared") }),
    ]);

    expect(ids(tree.childrenByKey.get(key("shared")))).toEqual(["child"]);
    expect(ids(tree.childrenByKey.get(key("shared", remote)))).toEqual(["remote-child"]);
  });

  it("shows a thread as a root when its chosen parent lives in another environment only", () => {
    const tree = build([
      thread("elsewhere", { environmentId: remote }),
      thread("child", { organization: under("elsewhere") }),
    ]);

    expect(ids(tree.roots)).toEqual(["elsewhere", "child"]);
  });

  it("keeps children visible as roots when their parent is archived, deleted or filtered", () => {
    const tree = build([
      thread("orphan", { forkOf: "missing" }),
      thread("grandchild", { forkOf: "orphan" }),
    ]);

    expect(ids(tree.roots)).toEqual(["orphan"]);
    expect(ids(tree.childrenByKey.get(key("orphan")))).toEqual(["grandchild"]);
  });

  it("breaks a self-parent and a cycle at the oldest thread instead of recursing", () => {
    const tree = build([
      thread("self", { organization: under("self") }),
      thread("b", { organization: under("a"), createdAt: "2026-02-02T00:00:00.000Z" }),
      thread("c", { organization: under("b"), createdAt: "2026-02-03T00:00:00.000Z" }),
      thread("a", { organization: under("c"), createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);

    expect(ids(tree.roots)).toEqual(["self", "a"]);
    expect(ids(tree.childrenByKey.get(key("a")))).toEqual(["b"]);
    expect(ids(tree.childrenByKey.get(key("b")))).toEqual(["c"]);
    expect(tree.childrenByKey.get(key("c"))).toBeUndefined();
  });

  it("breaks a cycle that closes through a recorded parent", () => {
    const tree = build([
      thread("source", { organization: under("fork"), createdAt: "2026-02-01T00:00:00.000Z" }),
      thread("fork", { forkOf: "source", createdAt: "2026-02-02T00:00:00.000Z" }),
    ]);

    expect(ids(tree.roots)).toEqual(["source"]);
    expect(ids(tree.childrenByKey.get(key("source")))).toEqual(["fork"]);
  });

  it("orders children by creation, not by input order or activity", () => {
    const tree = build([
      thread("late", { forkOf: "root", createdAt: "2026-03-03T00:00:00.000Z" }),
      thread("root", { createdAt: "2026-03-01T00:00:00.000Z" }),
      thread("early", { forkOf: "root", createdAt: "2026-03-02T00:00:00.000Z" }),
    ]);

    expect(ids(tree.childrenByKey.get(key("root")))).toEqual(["early", "late"]);
  });

  it("lists a subagent as a root when its parent is archived, deleted, filtered or missing", () => {
    const tree = build([
      thread("agent", { subagentOf: "archived" }),
      thread("nested-agent", { subagentOf: "agent" }),
      thread("moved-here", { organization: under("agent") }),
    ]);

    expect(ids(tree.roots)).toEqual(["agent"]);
    expect(ids(tree.childrenByKey.get(key("agent")))).toEqual(["nested-agent", "moved-here"]);
  });

  it("keeps a subagent chain's tail listed when a link in the middle is missing", () => {
    const tree = build([
      thread("root"),
      thread("agent", { subagentOf: "root" }),
      thread("tail", { subagentOf: "missing-middle" }),
      thread("tail-child", { subagentOf: "tail" }),
    ]);

    expect(ids(tree.roots)).toEqual(["root", "tail"]);
    expect(ids(tree.childrenByKey.get(key("root")))).toEqual(["agent"]);
    expect(ids(tree.childrenByKey.get(key("tail")))).toEqual(["tail-child"]);
  });

  it("follows the user's placement of a subagent whose recorded parent is gone", () => {
    const tree = build([
      thread("root"),
      thread("top", { subagentOf: "archived", organization: { type: "top-level" } }),
      thread("moved", { subagentOf: "archived", organization: under("root") }),
      thread("stranded", { subagentOf: "archived", organization: under("also-archived") }),
      thread("restored", { subagentOf: "archived", organization: { type: "automatic" } }),
    ]);

    expect(ids(tree.roots)).toEqual(["root", "top", "stranded", "restored"]);
    expect(ids(tree.childrenByKey.get(key("root")))).toEqual(["moved"]);
  });

  it("draws a chosen parent whatever lifecycle the two threads are in", () => {
    // Nesting reads no pin, snooze or settle state: a pinned thread moved
    // under an active one, or an active one under a settled one, stays nested.
    const tree = build([
      thread("active-root"),
      thread("pinned-child", { organization: under("active-root") }),
      thread("settled-root"),
      thread("active-child", { organization: under("settled-root") }),
      thread("active-fork", { forkOf: "settled-root" }),
    ]);

    expect(ids(tree.roots)).toEqual(["active-root", "settled-root"]);
    expect(ids(tree.childrenByKey.get(key("active-root")))).toEqual(["pinned-child"]);
    expect(ids(tree.childrenByKey.get(key("settled-root")))).toEqual([
      "active-child",
      "active-fork",
    ]);
  });
});

describe("resolveSidebarFamilySection", () => {
  it("keeps a family in its root's section while the root is pinned or in the inbox", () => {
    expect(resolveSidebarFamilySection("pinned", ["active", "settled", "working"])).toBe("pinned");
    expect(resolveSidebarFamilySection("active", ["pinned", "settled", "snoozed"])).toBe("active");
    expect(resolveSidebarFamilySection("active", ["working"])).toBe("active");
  });

  it("gives a pinned child no slot of its own in the pinned block", () => {
    expect(resolveSidebarFamilySection("active", ["pinned"])).toBe("active");
    expect(resolveSidebarFamilySection("settled", ["pinned"])).toBe("active");
  });

  it("brings a parked or folded root into the inbox while a nested conversation is there", () => {
    expect(resolveSidebarFamilySection("settled", ["active"])).toBe("active");
    expect(resolveSidebarFamilySection("snoozed", ["settled", "active"])).toBe("active");
    expect(resolveSidebarFamilySection("working", ["active"])).toBe("active");
  });

  it("shows a parked root in Working while a nested conversation is still running", () => {
    expect(resolveSidebarFamilySection("settled", ["working", "settled"])).toBe("working");
    expect(resolveSidebarFamilySection("snoozed", ["working"])).toBe("working");
  });

  it("leaves a family parked when every conversation in it is", () => {
    expect(resolveSidebarFamilySection("settled", [])).toBe("settled");
    expect(resolveSidebarFamilySection("settled", ["snoozed", "settled"])).toBe("settled");
    expect(resolveSidebarFamilySection("snoozed", ["settled"])).toBe("snoozed");
    expect(resolveSidebarFamilySection("working", ["settled"])).toBe("working");
  });
});

describe("sidebarNestedConversations", () => {
  it("counts nested forks and subthreads at any depth, never subagents", () => {
    const tree = build([
      thread("root"),
      thread("fork", { forkOf: "root" }),
      thread("agent", { subagentOf: "root" }),
      thread("subthread", { organization: under("agent") }),
    ]);

    expect(ids(sidebarNestedConversations(tree, key("root")))).toEqual(["fork", "subthread"]);
    expect(sidebarNestedConversations(tree, key("fork"))).toEqual([]);
  });
});

describe("isSidebarLifecycleOwnedByParent", () => {
  it("leaves a nested subagent's lifecycle to its family and frees one drawn as a root", () => {
    const nested = thread("nested", { subagentOf: "root" });
    const orphan = thread("orphan", { subagentOf: "archived" });
    const moved = thread("moved", { subagentOf: "archived", organization: under("root") });
    const fork = thread("fork", { forkOf: "root" });
    const tree = build([thread("root"), nested, orphan, moved, fork]);

    expect(isSidebarLifecycleOwnedByParent(tree, nested)).toBe(true);
    expect(isSidebarLifecycleOwnedByParent(tree, moved)).toBe(true);
    expect(isSidebarLifecycleOwnedByParent(tree, orphan)).toBe(false);
    expect(isSidebarLifecycleOwnedByParent(tree, fork)).toBe(false);
  });
});

describe("flattenSidebarFamily", () => {
  const threads = [
    thread("root"),
    thread("a", { forkOf: "root" }),
    thread("a1", { forkOf: "a" }),
    thread("b", { forkOf: "root" }),
  ];
  const tree = build(threads);

  it("lists expanded descendants depth first with their depth", () => {
    const rows = flattenSidebarFamily(tree, key("root"), {
      isExpanded: () => true,
      revealKey: null,
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["a", 1],
      ["a1", 2],
      ["b", 1],
    ]);
  });

  it("hides the descendants of a collapsed node", () => {
    const rows = flattenSidebarFamily(tree, key("root"), {
      isExpanded: (nodeKey) => nodeKey !== key("a"),
      revealKey: null,
    });

    expect(rows.map((row) => row.thread.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ childCount: 1 });
  });

  it("keeps the open thread's path visible inside collapsed ancestors", () => {
    const rows = flattenSidebarFamily(tree, key("root"), {
      isExpanded: () => false,
      revealKey: key("a1"),
    });

    expect(rows.map((row) => row.thread.id)).toEqual(["a", "a1"]);
  });

  it("keeps ordinary task conversations prominent and agents independently collapsed", () => {
    const mixed = build([
      thread("root"),
      thread("agent", { subagentOf: "root" }),
      thread("task", { creator: "root", projectId: "project-b" }),
      thread("task-child", { creator: "task" }),
      thread("task-agent", { subagentOf: "task" }),
    ]);
    const choices: Record<string, boolean> = { [key("root")]: true };
    const visible = (revealKey: string | null = null, agents = false) =>
      flattenSidebarFamily(mixed, key("root"), {
        isExpanded: (nodeKey, children) => resolveSidebarFamilyExpanded(choices[nodeKey], children),
        isSubagentsExpanded: () => agents,
        revealKey,
      }).map((row) => [row.thread.id, row.depth]);
    expect(visible()).toEqual([
      ["task", 1],
      ["task-child", 2],
    ]);
    expect(sidebarNestedConversations(mixed, key("root")).map((row) => row.id)).toEqual([
      "task",
      "task-child",
    ]);
    expect(visible(null, true)).toEqual([
      ["task", 1],
      ["task-child", 2],
      ["task-agent", 2],
      ["agent", 1],
    ]);
    choices[key("root")] = false;
    expect(visible(key("task-agent"))).toEqual([
      ["task", 1],
      ["task-child", 2],
      ["task-agent", 2],
    ]);
    const saved = { ...choices };
    expect(buildSidebarSearchRows(mixed, [key("agent")]).map((row) => row.thread.id)).toEqual([
      "root",
      "agent",
    ]);
    expect(choices).toEqual(saved);
    expect(visible()).toEqual([]);
    expect(visible(null, true)).toEqual([["agent", 1]]);
  });
});

describe("buildSidebarSearchRows", () => {
  const threads = [
    thread("root"),
    thread("a", { forkOf: "root" }),
    thread("a1", { forkOf: "a" }),
    thread("b", { forkOf: "root" }),
    thread("other"),
    thread("other-child", { organization: under("other") }),
    thread("lone"),
  ];
  const tree = build(threads);
  const rows = (...matchIds: string[]) =>
    buildSidebarSearchRows(
      tree,
      matchIds.map((id) => key(id)),
    ).map((row) => [row.thread.id, row.depth, row.isMatch]);

  it("keeps every ancestor of a nested match and drops branches without one", () => {
    expect(rows("a1")).toEqual([
      ["root", 0, false],
      ["a", 1, false],
      ["a1", 2, true],
    ]);
  });

  it("marks a matching ancestor as a match and lists siblings in creation order", () => {
    expect(rows("b", "root", "a1")).toEqual([
      ["root", 0, true],
      ["a", 1, false],
      ["a1", 2, true],
      ["b", 1, true],
    ]);
  });

  it("orders families by the best match they hold", () => {
    expect(rows("lone", "other-child", "root")).toEqual([
      ["lone", 0, true],
      ["other", 0, false],
      ["other-child", 1, true],
      ["root", 0, true],
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(rows()).toEqual([]);
  });

  it("opens a collapsed family for the search and leaves the user's choice as it was", () => {
    const choices: Record<string, boolean> = { [key("root")]: false, [key("a")]: false };
    const snapshot = structuredClone(choices);
    const flatten = () =>
      flattenSidebarFamily(tree, key("root"), {
        isExpanded: (nodeKey, children) => resolveSidebarFamilyExpanded(choices[nodeKey], children),
        revealKey: null,
      }).map((row) => row.thread.id);

    // Collapsed by the user: the family shows none of its nested threads.
    expect(flatten()).toEqual([]);
    // The search still reaches the match two levels down that collapsed family.
    expect(rows("a1").map(([id]) => id)).toEqual(["root", "a", "a1"]);
    // Clearing the search is just no longer building those rows: the stored
    // choices were never read or written, so the family is collapsed again.
    expect(choices).toEqual(snapshot);
    expect(flatten()).toEqual([]);
  });
});

describe("stepSidebarSearchRow", () => {
  const rows = [{ isMatch: false }, { isMatch: true }, { isMatch: false }, { isMatch: true }];

  it("moves between matches, stepping over ancestors kept for context", () => {
    expect(stepSidebarSearchRow(rows, 1, 1)).toBe(3);
    expect(stepSidebarSearchRow(rows, 3, -1)).toBe(1);
    expect(stepSidebarSearchRow(rows, 0, 1)).toBe(1);
  });

  it("wraps at either end and stays put when there is no other match", () => {
    expect(stepSidebarSearchRow(rows, 3, 1)).toBe(1);
    expect(stepSidebarSearchRow(rows, 1, -1)).toBe(3);
    expect(stepSidebarSearchRow([{ isMatch: false }, { isMatch: true }], 1, 1)).toBe(1);
  });
});

describe("resolveSidebarFamilyExpanded", () => {
  it("starts a family of real conversations open and a subagent-only family closed", () => {
    const fork = thread("fork", { forkOf: "root" });
    const agent = thread("agent", { subagentOf: "root" });

    expect(resolveSidebarFamilyExpanded(undefined, [agent, fork])).toBe(true);
    expect(resolveSidebarFamilyExpanded(undefined, [agent])).toBe(false);
  });

  it("lets the user's choice win either way", () => {
    const fork = thread("fork", { forkOf: "root" });
    const agent = thread("agent", { subagentOf: "root" });

    expect(resolveSidebarFamilyExpanded(false, [fork])).toBe(false);
    expect(resolveSidebarFamilyExpanded(true, [agent])).toBe(true);
  });
});

describe("ordinary expansion migration and family layout", () => {
  it("leaves childless and missing-parent roots bare, with groups only on actual parents", () => {
    const tree = build([
      thread("lone"),
      thread("root"),
      thread("task", { creator: "root" }),
      thread("agent", { subagentOf: "root" }),
      thread("orphan", { creator: "missing" }),
    ]);
    expect(sidebarFamilyGroupKinds(tree, key("lone"))).toBeNull();
    expect(sidebarFamilyGroupKinds(tree, key("orphan"))).toBeNull();
    expect(sidebarFamilyGroupKinds(tree, key("task"))).toBeNull();
    expect(sidebarFamilyGroupKinds(tree, key("root"))).toEqual(["ordinary", "subagents"]);
    expect(
      flattenSidebarFamily(tree, key("lone"), { isExpanded: () => true, revealKey: null }),
    ).toEqual([]);
  });

  it("ignores an old agent-only collapse for creator tasks while retaining new choices and reveal", () => {
    const tree = build([
      thread("root"),
      thread("task", { creator: "root" }),
      thread("agent", { subagentOf: "root" }),
      thread("task-agent", { subagentOf: "task" }),
    ]);
    const choices: Record<string, boolean> = { [key("root")]: false };
    const visible = (revealKey: string | null = null) =>
      flattenSidebarFamily(tree, key("root"), {
        isExpanded: (parentKey, children) =>
          resolveSidebarOrdinaryExpanded(choices, parentKey, children),
        isSubagentsExpanded: (parentKey) => choices[sidebarSubagentGroupKey(parentKey)] ?? false,
        revealKey,
      }).map((row) => row.thread.id);
    expect(visible()).toEqual(["task"]);
    choices[sidebarOrdinaryGroupKey(key("root"))] = false;
    expect(visible()).toEqual([]);
    expect(visible(key("task-agent"))).toEqual(["task", "task-agent"]);
    const saved = { ...choices };
    expect(buildSidebarSearchRows(tree, [key("agent")]).map((row) => row.thread.id)).toEqual([
      "root",
      "agent",
    ]);
    expect(choices).toEqual(saved);
    expect(visible()).toEqual([]);
    choices[sidebarOrdinaryGroupKey(key("root"))] = true;
    expect(visible()).toEqual(["task"]);
  });

  it("retains old ordinary fork/manual choices, with versioned toggles taking precedence", () => {
    const choices = { [key("root")]: false };
    const task = thread("task", { creator: "root" });
    for (const priorChild of [
      thread("fork", { forkOf: "root" }),
      thread("manual", { organization: under("root") }),
      thread("manual-task", { creator: "root", organization: under("root") }),
    ]) {
      expect(resolveSidebarOrdinaryExpanded(choices, key("root"), [priorChild, task])).toBe(false);
      expect(
        resolveSidebarOrdinaryExpanded(
          { ...choices, [sidebarOrdinaryGroupKey(key("root"))]: true },
          key("root"),
          [priorChild, task],
        ),
      ).toBe(true);
      expect(
        resolveSidebarOrdinaryExpanded(
          { [key("root")]: true, [sidebarOrdinaryGroupKey(key("root"))]: false },
          key("root"),
          [priorChild],
        ),
      ).toBe(false);
    }
  });
});

describe("summarizeSidebarDescendants", () => {
  const status = (
    overrides: Partial<Parameters<typeof summarizeSidebarDescendants>[0][number]>,
  ): Parameters<typeof summarizeSidebarDescendants>[0][number] => ({
    environmentId: local,
    projectId: ProjectId.make("project-a"),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  });
  const runtime = (value: string) =>
    ({ status: value }) as NonNullable<
      Parameters<typeof summarizeSidebarDescendants>[0][number]["runtime"]
    >;

  it("counts each kind separately but carries every concealed mixed descendant's status", () => {
    for (const subagents of [false, true]) {
      const owner = {
        ...thread("owner", subagents ? { subagentOf: "root" } : { creator: "root" }),
        ...status({}),
      };
      const pending = [
        status({ hasPendingApprovals: true }),
        status({ hasPendingUserInput: true }),
        status({ runtime: runtime("running") }),
        status({ runtime: runtime("failed") }),
        status({}),
        status({ runtime: runtime("idle") }),
      ].map((state, index) => ({
        ...thread(
          `descendant-${index}`,
          subagents
            ? index === 0
              ? { organization: under("owner") }
              : { creator: "owner" }
            : { subagentOf: "owner" },
        ),
        ...state,
      }));
      const tree = buildSidebarThreadTree({
        threads: [{ ...thread("root"), ...status({}) }, owner, ...pending],
      });
      const before = structuredClone([owner, ...pending]);
      const summary = summarizeSidebarFamilyGroup(
        tree,
        key("root"),
        subagents ? "subagents" : "ordinary",
        (row) => row.id === "descendant-4",
      );
      expect(summary).toEqual({
        sessionCount: 1,
        otherSessionCount: 6,
        projectCount: 1,
        attentionCount: 2,
        statuses: [
          { status: "approval", count: 1 },
          { status: "input", count: 1 },
          { status: "failed", count: 1 },
          { status: "unread", count: 1 },
          { status: "working", count: 1 },
          { status: "waiting", count: 1 },
        ],
      });
      expect(
        flattenSidebarFamily(tree, key("root"), {
          isExpanded: () => false,
          isSubagentsExpanded: () => false,
          revealKey: null,
        }),
      ).toEqual([]);
      expect(
        flattenSidebarFamily(tree, key("root"), {
          isExpanded: () => true,
          isSubagentsExpanded: () => true,
          revealKey: null,
        }).map((row) => row.thread.id),
      ).toEqual(["owner", ...pending.map((row) => row.id)]);
      expect(sidebarNestedConversations(tree, key("root")).length).toBe(subagents ? 6 : 1);
      expect([owner, ...pending]).toEqual(before);
      expect(pending[0]?.sidebarOrganization).toEqual(subagents ? under("owner") : undefined);
    }
  });

  it("counts what needs the user apart from background work, worst first", () => {
    const finished = status({ projectId: ProjectId.make("project-b") });
    const summary = summarizeSidebarDescendants(
      [
        status({ runtime: runtime("idle") }),
        status({ runtime: runtime("running") }),
        status({ hasPendingUserInput: true }),
        status({ hasPendingApprovals: true, runtime: runtime("running") }),
        finished,
        status({}),
      ],
      (thread) => thread === finished,
    );

    expect(summary).toEqual({
      sessionCount: 6,
      projectCount: 2,
      attentionCount: 2,
      statuses: [
        { status: "approval", count: 1 },
        { status: "input", count: 1 },
        { status: "unread", count: 1 },
        { status: "working", count: 1 },
        { status: "waiting", count: 1 },
      ],
    });
  });

  it("does not report background waiting as needing the user", () => {
    const summary = summarizeSidebarDescendants(
      [status({ runtime: runtime("idle") }), status({ runtime: runtime("idle") })],
      () => false,
    );

    expect(summary.attentionCount).toBe(0);
    expect(summary.statuses).toEqual([{ status: "waiting", count: 2 }]);
  });
});

describe("canNestSidebarThreadUnder", () => {
  const threads = new Map(
    [
      thread("root"),
      thread("fork", { forkOf: "root" }),
      thread("grandchild", { organization: under("fork") }),
      thread("other"),
      thread("root", { environmentId: remote }),
    ].map((candidate) => [sidebarThreadKey(candidate), candidate]),
  );

  it("allows an unrelated thread in the same environment", () => {
    expect(canNestSidebarThreadUnder(threads, key("other"), key("root"))).toBe(true);
    expect(canNestSidebarThreadUnder(threads, key("other"), key("fork"))).toBe(true);
  });

  it("stops at a grandchild, counting the threads that move with the thread", () => {
    const nest = (list: ReadonlyArray<TreeThread>, childId: string, parentId: string) =>
      canNestSidebarThreadUnder(
        new Map(list.map((candidate) => [sidebarThreadKey(candidate), candidate])),
        key(childId),
        key(parentId),
      );
    const family = [
      thread("root"),
      thread("child", { organization: under("root") }),
      thread("grandchild", { organization: under("child") }),
    ];

    // A fourth level is never offered.
    expect(nest([...family, thread("moved")], "moved", "grandchild")).toBe(false);
    // A thread with one nested level fits under a root and nowhere deeper.
    const withChild = [...family, thread("moved"), thread("moved-child", { forkOf: "moved" })];
    expect(nest(withChild, "moved", "root")).toBe(true);
    expect(nest(withChild, "moved", "child")).toBe(false);
    // With two nested levels it only fits at the top.
    const withGrandchild = [...withChild, thread("moved-grandchild", { forkOf: "moved-child" })];
    expect(nest(withGrandchild, "moved", "root")).toBe(false);
    // An archived thread is not drawn, so it does not count as nested.
    const archivedChild = [
      ...family,
      thread("moved"),
      thread("moved-child", { forkOf: "moved", archived: true }),
    ];
    expect(nest(archivedChild, "moved", "child")).toBe(true);
  });

  it("counts depth from an archived ancestor, where the list draws a new root", () => {
    const list = [
      thread("archived-root", { archived: true }),
      thread("child", { organization: under("archived-root") }),
      thread("grandchild", { organization: under("child") }),
      thread("moved"),
    ];
    const byKey = new Map(list.map((candidate) => [sidebarThreadKey(candidate), candidate]));

    expect(canNestSidebarThreadUnder(byKey, key("moved"), key("grandchild"))).toBe(true);
    expect(canAddSidebarSubthread(byKey, key("grandchild"))).toBe(true);
  });

  it("rejects the thread itself and any of its descendants, recorded or chosen", () => {
    expect(canNestSidebarThreadUnder(threads, key("root"), key("root"))).toBe(false);
    expect(canNestSidebarThreadUnder(threads, key("root"), key("fork"))).toBe(false);
    expect(canNestSidebarThreadUnder(threads, key("root"), key("grandchild"))).toBe(false);
  });

  it("rejects a parent in another environment", () => {
    expect(canNestSidebarThreadUnder(threads, key("other"), key("root", remote))).toBe(false);
  });
});

describe("listSidebarMoveTargets", () => {
  const targets = (threads: ReadonlyArray<TreeThread>, childId: string) =>
    ids(
      listSidebarMoveTargets(
        new Map(threads.map((candidate) => [sidebarThreadKey(candidate), candidate])),
        key(childId),
      ),
    );

  it("offers every thread in the environment, nested or not and however many there are", () => {
    const many = Array.from({ length: 40 }, (_, index) => thread(`root-${index}`));
    const threads = [
      thread("moved"),
      thread("root"),
      thread("nested", { forkOf: "root" }),
      thread("agent", { subagentOf: "nested" }),
      ...many,
    ];

    // "agent" is already a grandchild, so nothing can go under it.
    expect(targets(threads, "moved")).toEqual([
      "root",
      "nested",
      ...many.map((candidate) => candidate.id),
    ]);
  });

  it("excludes delegated destinations even at the top level while keeping ordinary tasks", () => {
    expect(
      targets(
        [
          thread("moved"),
          thread("root"),
          thread("agent", { subagentOf: "root" }),
          thread("top-agent", { subagentOf: "root", organization: { type: "top-level" } }),
          thread("task", { creator: "root" }),
        ],
        "moved",
      ),
    ).toEqual(["root", "task"]);
  });

  it("leaves out the thread, its descendants, its current parent and other environments", () => {
    const threads = [
      thread("parent"),
      thread("moved", { organization: under("parent") }),
      thread("child", { forkOf: "moved" }),
      thread("other"),
      thread("elsewhere", { environmentId: remote }),
    ];

    expect(targets(threads, "moved")).toEqual(["other"]);
  });

  it("leaves out archived threads, which could not keep a child nested", () => {
    expect(targets([thread("moved"), thread("gone", { archived: true })], "moved")).toEqual([]);
  });
});

describe("canAddSidebarSubthread", () => {
  it("offers a new subthread under a root or a child, not under a grandchild", () => {
    const byKey = new Map(
      [
        thread("root"),
        thread("child", { organization: under("root") }),
        thread("grandchild", { forkOf: "child" }),
      ].map((candidate) => [sidebarThreadKey(candidate), candidate]),
    );

    expect(canAddSidebarSubthread(byKey, key("root"))).toBe(true);
    expect(canAddSidebarSubthread(byKey, key("child"))).toBe(true);
    expect(canAddSidebarSubthread(byKey, key("grandchild"))).toBe(false);
  });
});

describe("a recorded chain deeper than the tree", () => {
  const chain = [
    thread("root"),
    thread("fork-1", { forkOf: "root" }),
    thread("fork-2", { forkOf: "fork-1" }),
    thread("fork-3", { forkOf: "fork-2" }),
    thread("fork-4", { subagentOf: "fork-3" }),
  ];
  const depths = (tree: ReturnType<typeof build>, rootId: string) =>
    flattenSidebarFamily(tree, key(rootId), {
      isExpanded: () => true,
      isSubagentsExpanded: () => true,
      revealKey: null,
    }).map((row) => [row.thread.id, row.depth]);

  it("keeps every row and draws the deeper ones as grandchildren", () => {
    const tree = build(chain);

    expect(ids(tree.roots)).toEqual(["root"]);
    expect(depths(tree, "root")).toEqual([
      ["fork-1", 1],
      ["fork-2", 2],
      ["fork-3", 2],
      ["fork-4", 2],
    ]);
    // No grandchild heads a family of its own.
    expect(tree.childrenByKey.get(key("fork-2"))).toBeUndefined();
    expect(sidebarAncestorKeys(tree, key("fork-4"))).toEqual([key("root"), key("fork-1")]);
    // A subagent drawn that way still leaves its lifecycle to the family.
    expect(isSidebarLifecycleOwnedByParent(tree, chain[4]!)).toBe(true);
  });

  it("shows a deep match under the same two ancestors in search", () => {
    expect(
      buildSidebarSearchRows(build(chain), [key("fork-4")]).map((row) => [
        row.thread.id,
        row.depth,
        row.isMatch,
      ]),
    ).toEqual([
      ["root", 0, false],
      ["fork-1", 1, false],
      ["fork-4", 2, true],
    ]);
  });

  it("counts the three levels from the visible root when an ancestor is filtered out", () => {
    const tree = build(chain.slice(1));

    expect(ids(tree.roots)).toEqual(["fork-1"]);
    expect(depths(tree, "fork-1")).toEqual([
      ["fork-2", 1],
      ["fork-3", 2],
      ["fork-4", 2],
    ]);
  });

  it("nests the chain again in full depth order once a thread is moved to the top", () => {
    const tree = build([
      ...chain.slice(0, 3),
      thread("fork-3", { forkOf: "fork-2", organization: { type: "top-level" } }),
      chain[4]!,
    ]);

    expect(ids(tree.roots)).toEqual(["root", "fork-3"]);
    expect(depths(tree, "root")).toEqual([
      ["fork-1", 1],
      ["fork-2", 2],
    ]);
    expect(depths(tree, "fork-3")).toEqual([["fork-4", 1]]);
  });
});

describe("sidebarAncestorKeys", () => {
  it("lists a nested thread's ancestors from the root down", () => {
    const tree = build([
      thread("root"),
      thread("a", { forkOf: "root" }),
      thread("a1", { forkOf: "a" }),
    ]);

    expect(sidebarAncestorKeys(tree, key("a1"))).toEqual([key("root"), key("a")]);
    expect(sidebarAncestorKeys(tree, key("root"))).toEqual([]);
  });
});
