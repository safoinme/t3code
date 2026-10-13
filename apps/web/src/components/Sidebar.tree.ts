import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveSidebarParentThreadId, SIDEBAR_TREE_MAX_DEPTH } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import {
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
  type SidebarSection,
  type SidebarThreadStatus,
} from "./Sidebar.logic";

// Sidebar thread trees. A family is a root thread with the threads nested
// under it. Parents come from sidebar organization (see
// resolveSidebarParentThreadId): the creator, fork or subagent parent unless
// the user chose a parent or the top level. Nothing here reads titles or
// branches, and nothing here changes lineage.
//
// Only roots take a slot in a lifecycle section. Their descendants render
// inside the root's row, so pin order, active order and lifecycle drops keep
// operating on roots.
//
// A tree is a root, its children and their children (SIDEBAR_TREE_MAX_DEPTH).
// Chosen placements are held to that here and on the server. Recorded fork
// and subagent chains can be longer, and are drawn within it.

type SidebarTreeThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "environmentId"
  | "lineage"
  | "forkedFrom"
  | "sidebarOrganization"
  | "createdAt"
  | "creatorThreadId"
>;

/** Thread ids repeat across environments, so every tree lookup uses this key. */
export function sidebarThreadKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">) {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export interface SidebarThreadTree<T> {
  /** Threads that take a slot in a lifecycle section, in input order. */
  readonly roots: ReadonlyArray<T>;
  /** Nested children in creation order, keyed by their parent. */
  readonly childrenByKey: ReadonlyMap<string, ReadonlyArray<T>>;
  /** The parent each nested thread is drawn under. Roots have no entry. */
  readonly parentKeyByKey: ReadonlyMap<string, string>;
}

const byCreation = <T extends SidebarTreeThread>(left: T, right: T) =>
  left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : sidebarThreadKey(left).localeCompare(sidebarThreadKey(right));

function sidebarParentKey(thread: SidebarTreeThread): string | null {
  const parentId = resolveSidebarParentThreadId(thread);
  return parentId === null
    ? null
    : sidebarThreadKey({ environmentId: thread.environmentId, id: parentId });
}

/**
 * Arrange the visible threads into families. `threads` is the list after the
 * archive and project filters. Every one of them gets a row: under its parent
 * when that parent is in the list, and as a root when the parent is archived,
 * deleted, filtered or missing. That holds for subagents too.
 *
 * No row is drawn deeper than SIDEBAR_TREE_MAX_DEPTH. A thread whose recorded
 * ancestry runs deeper keeps its row at that depth, beside the thread it
 * descends from, under their shared ancestor one level up. Only the drawing
 * changes: its lineage and its stored placement stay as they are.
 */
export function buildSidebarThreadTree<T extends SidebarTreeThread>(input: {
  readonly threads: ReadonlyArray<T>;
}): SidebarThreadTree<T> {
  const threadByKey = new Map(input.threads.map((thread) => [sidebarThreadKey(thread), thread]));
  const parentKeyByKey = new Map<string, string>();
  for (const [key, thread] of threadByKey) {
    const parentKey = sidebarParentKey(thread);
    if (parentKey !== null && parentKey !== key && threadByKey.has(parentKey)) {
      parentKeyByKey.set(key, parentKey);
    }
  }

  // The server never stores a cycle. This cut only keeps data it did not
  // validate (another server version, a hand-edited database) from recursing,
  // and picks the oldest thread so every client draws the same root.
  const acyclic = new Set<string>();
  for (const start of parentKeyByKey.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !acyclic.has(cursor) && !onPath.has(cursor)) {
      path.push(cursor);
      onPath.add(cursor);
      cursor = parentKeyByKey.get(cursor);
    }
    if (cursor !== undefined && onPath.has(cursor)) {
      const oldest = path
        .slice(path.indexOf(cursor))
        .map((key) => threadByKey.get(key)!)
        .toSorted(byCreation)[0]!;
      parentKeyByKey.delete(sidebarThreadKey(oldest));
    }
    for (const key of path) acyclic.add(key);
  }

  const depthByKey = new Map<string, number>();
  const depthOf = (key: string): number => {
    const known = depthByKey.get(key);
    if (known !== undefined) return known;
    const parentKey = parentKeyByKey.get(key);
    const depth = parentKey === undefined ? 0 : depthOf(parentKey) + 1;
    depthByKey.set(key, depth);
    return depth;
  };
  const drawnParentKeyByKey = new Map(parentKeyByKey);
  for (const key of parentKeyByKey.keys()) {
    if (depthOf(key) <= SIDEBAR_TREE_MAX_DEPTH) continue;
    let ancestorKey = parentKeyByKey.get(key)!;
    while (depthOf(ancestorKey) >= SIDEBAR_TREE_MAX_DEPTH) {
      ancestorKey = parentKeyByKey.get(ancestorKey)!;
    }
    drawnParentKeyByKey.set(key, ancestorKey);
  }

  const children = new Map<string, T[]>();
  for (const [key, parentKey] of drawnParentKeyByKey) {
    const siblings = children.get(parentKey) ?? [];
    siblings.push(threadByKey.get(key)!);
    children.set(parentKey, siblings);
  }
  for (const siblings of children.values()) siblings.sort(byCreation);

  return {
    roots: input.threads.filter((thread) => !parentKeyByKey.has(sidebarThreadKey(thread))),
    childrenByKey: children,
    parentKeyByKey: drawnParentKeyByKey,
  };
}

/**
 * A subagent drawn under a parent leaves pin, settle, snooze, archive and
 * delete to that family. As a root it is an ordinary row: its parent is
 * archived, deleted or filtered, or the user moved it out, and nothing else in
 * the sidebar could clear it.
 */
export function isSidebarLifecycleOwnedByParent(
  tree: Pick<SidebarThreadTree<unknown>, "parentKeyByKey">,
  thread: Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
): boolean {
  return isSidebarSubagentThread(thread) && tree.parentKeyByKey.has(sidebarThreadKey(thread));
}

/**
 * The nested threads whose state counts for their family root: every
 * descendant that is not a subagent. A subagent is part of the run that
 * spawned it, so it never moves or re-sorts the family on its own.
 */
export function sidebarNestedConversations<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
>(tree: Pick<SidebarThreadTree<T>, "childrenByKey">, rootKey: string): T[] {
  return collectSidebarDescendants(tree, rootKey, sidebarThreadKey).filter(
    (thread) => !isSidebarSubagentThread(thread),
  );
}

/**
 * The section a whole family is drawn in, from its root's own section and
 * those of its nested conversations. Nesting never changes a thread's own pin
 * or lifecycle, so the family follows its root, except that a parked or
 * folded root does not bury a conversation the inbox would still show: the
 * family sits in the inbox while any of its conversations does, and in
 * Working while one is still running. A pinned root keeps its family pinned;
 * a pinned child keeps its pin but takes no slot of its own in the pinned block.
 */
export function resolveSidebarFamilySection(
  root: SidebarSection,
  nested: ReadonlyArray<SidebarSection>,
): SidebarSection {
  if (root === "pinned" || root === "active") return root;
  if (nested.some((section) => section === "active" || section === "pinned")) return "active";
  return nested.includes("working") ? "working" : root;
}

/** A nested thread's ancestors from its family root down to its parent. */
export function sidebarAncestorKeys(
  tree: Pick<SidebarThreadTree<unknown>, "parentKeyByKey">,
  key: string,
): string[] {
  const ancestors: string[] = [];
  for (
    let parentKey = tree.parentKeyByKey.get(key);
    parentKey !== undefined;
    parentKey = tree.parentKeyByKey.get(parentKey)
  ) {
    ancestors.unshift(parentKey);
  }
  return ancestors;
}

/** Every thread nested under `key`, depth first. */
export function collectSidebarDescendants<T>(
  tree: Pick<SidebarThreadTree<T>, "childrenByKey">,
  key: string,
  keyOf: (thread: T) => string,
): T[] {
  return (tree.childrenByKey.get(key) ?? []).flatMap((child) => [
    child,
    ...collectSidebarDescendants(tree, keyOf(child), keyOf),
  ]);
}

/**
 * Whether a family shows its children. Without a stored choice, a family with
 * a conversation the user could already see in the sidebar starts open, and a
 * family of subagents alone starts closed, as subagents were never listed.
 */
export function resolveSidebarFamilyExpanded(
  choice: boolean | undefined,
  children: ReadonlyArray<Pick<SidebarThreadSummary, "lineage">>,
): boolean {
  return choice ?? children.some((child) => !isSidebarSubagentThread(child));
}

/** Share the stored choices without reusing a family's ordinary expansion. */
export function sidebarSubagentGroupKey(parentKey: string): string {
  return `${parentKey}:subagents`;
}

export function sidebarOrdinaryGroupKey(parentKey: string): string {
  return `${parentKey}:ordinary-v2`;
}

/** A legacy choice belongs to ordinary rows only if they were already nested
 * by fork/lineage or manual placement before creator grouping existed. */
export function resolveSidebarOrdinaryExpanded(
  choices: Readonly<Record<string, boolean>>,
  parentKey: string,
  children: ReadonlyArray<SidebarTreeThread>,
): boolean {
  const hadOrdinaryFamily = children.some(
    (child) =>
      !isSidebarSubagentThread(child) &&
      resolveSidebarParentThreadId({ ...child, creatorThreadId: null }) !== null,
  );
  return resolveSidebarFamilyExpanded(
    choices[sidebarOrdinaryGroupKey(parentKey)] ??
      (hadOrdinaryFamily ? choices[parentKey] : undefined),
    children,
  );
}

export type SidebarFamilyGroupKind = "ordinary" | "subagents";

/** Null means a bare row, with no family padding or sortable wrapper. */
export function sidebarFamilyGroupKinds<T extends Pick<SidebarThreadSummary, "lineage">>(
  tree: Pick<SidebarThreadTree<T>, "childrenByKey">,
  parentKey: string,
): ReadonlyArray<SidebarFamilyGroupKind> | null {
  const children = tree.childrenByKey.get(parentKey) ?? [];
  if (children.length === 0) return null;
  const groups: SidebarFamilyGroupKind[] = [];
  if (children.some((child) => !isSidebarSubagentThread(child))) groups.push("ordinary");
  if (children.some(isSidebarSubagentThread)) groups.push("subagents");
  return groups;
}

export interface SidebarFamilyRow<T> {
  readonly key: string;
  readonly thread: T;
  /** 1 for a child of the family root. */
  readonly depth: number;
  readonly childCount: number;
}

/**
 * The nested rows a family renders below its root. A collapsed node hides its
 * descendants except the path to `revealKey`, the open thread, which must stay
 * reachable the same way the collapsed shelves keep it.
 */
export function flattenSidebarFamily<T extends SidebarTreeThread>(
  tree: SidebarThreadTree<T>,
  rootKey: string,
  options: {
    readonly isExpanded: (key: string, children: ReadonlyArray<T>) => boolean;
    readonly isSubagentsExpanded?: (key: string) => boolean;
    readonly revealKey: string | null;
  },
): SidebarFamilyRow<T>[] {
  const revealPath =
    options.revealKey === null
      ? new Set<string>()
      : new Set([...sidebarAncestorKeys(tree, options.revealKey), options.revealKey]);
  const rows: SidebarFamilyRow<T>[] = [];
  const visit = (parentKey: string, depth: number) => {
    const children = tree.childrenByKey.get(parentKey) ?? [];
    const open = options.isExpanded(parentKey, children);
    // Render ordinary conversations before the separately collapsed agent group.
    const ordered = [
      ...children.filter((thread) => !isSidebarSubagentThread(thread)),
      ...children.filter(isSidebarSubagentThread),
    ];
    for (const thread of ordered) {
      const key = sidebarThreadKey(thread);
      const groupOpen = isSidebarSubagentThread(thread)
        ? (options.isSubagentsExpanded?.(parentKey) ?? false)
        : open;
      if (!groupOpen && !revealPath.has(key)) continue;
      rows.push({ key, thread, depth, childCount: tree.childrenByKey.get(key)?.length ?? 0 });
      visit(key, depth + 1);
    }
  };
  visit(rootKey, 1);
  return rows;
}

export interface SidebarSearchRow<T> {
  readonly key: string;
  readonly thread: T;
  /** 0 for a family root. */
  readonly depth: number;
  /** False for an ancestor kept only to show where its matching descendant sits. */
  readonly isMatch: boolean;
}

/**
 * Search results as a tree: every matching thread with the ancestors it is
 * nested under, children in creation order. `matchKeys` lists the matches
 * best first, and families follow the best match they hold. Every path to a
 * match is open here whatever the user collapsed. This reads no expansion
 * choice and stores none, so the list the user left is the list they return
 * to when the search clears.
 */
export function buildSidebarSearchRows<T extends SidebarTreeThread>(
  tree: SidebarThreadTree<T>,
  matchKeys: ReadonlyArray<string>,
): SidebarSearchRow<T>[] {
  const rankByKey = new Map(matchKeys.map((key, rank) => [key, rank]));
  const families: { readonly rank: number; readonly rows: SidebarSearchRow<T>[] }[] = [];
  for (const root of tree.roots) {
    const rows: SidebarSearchRow<T>[] = [];
    // Returns the best rank at or under the thread, dropping the rows of a
    // branch that holds no match.
    const visit = (thread: T, depth: number): number => {
      const key = sidebarThreadKey(thread);
      const ownRank = rankByKey.get(key);
      const index = rows.length;
      rows.push({ key, thread, depth, isMatch: ownRank !== undefined });
      let best = ownRank ?? Number.POSITIVE_INFINITY;
      const children = (tree.childrenByKey.get(key) ?? []).toSorted(
        (left, right) =>
          Number(isSidebarSubagentThread(left)) - Number(isSidebarSubagentThread(right)),
      );
      for (const child of children) {
        best = Math.min(best, visit(child, depth + 1));
      }
      if (best === Number.POSITIVE_INFINITY) rows.length = index;
      return best;
    };
    const rank = visit(root, 0);
    if (rows.length > 0) families.push({ rank, rows });
  }
  return families.toSorted((left, right) => left.rank - right.rank).flatMap(({ rows }) => rows);
}

/**
 * The row the arrow keys move to from `index`: the next match in `direction`,
 * wrapping around. Ancestors kept for context are stepped over; they are
 * still rows a click can open.
 */
export function stepSidebarSearchRow(
  rows: ReadonlyArray<Pick<SidebarSearchRow<unknown>, "isMatch">>,
  index: number,
  direction: 1 | -1,
): number {
  for (let step = 1; step <= rows.length; step += 1) {
    const candidate = (((index + direction * step) % rows.length) + rows.length) % rows.length;
    if (rows[candidate]?.isMatch) return candidate;
  }
  return index;
}

// Worst first. Approval and input are the only states that need the user;
// "waiting" is background work holding a finished run, never a request.
// "unread" is a finished thread the user has not opened since.
const SUMMARY_STATUS_ORDER = [
  "approval",
  "input",
  "failed",
  "unread",
  "working",
  "waiting",
] as const;
export type SidebarFamilySummaryStatus = (typeof SUMMARY_STATUS_ORDER)[number];

export interface SidebarDescendantSummary {
  readonly sessionCount: number;
  readonly projectCount: number;
  /** Descendants blocked on an approval or an answer from the user. */
  readonly attentionCount: number;
  readonly statuses: ReadonlyArray<{
    readonly status: SidebarFamilySummaryStatus;
    readonly count: number;
  }>;
}

export interface SidebarGroupSummary extends SidebarDescendantSummary {
  /** Opposite-kind descendants concealed by this group, labelled separately. */
  readonly otherSessionCount: number;
}

/** Counts distinguish kinds; attention includes everything behind the toggle. */
export function summarizeSidebarFamilyGroup<
  T extends SidebarTreeThread &
    Pick<
      SidebarThreadSummary,
      "projectId" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
    >,
>(
  tree: SidebarThreadTree<T>,
  parentKey: string,
  kind: SidebarFamilyGroupKind,
  isUnread: (thread: T) => boolean,
): SidebarGroupSummary {
  const subagents = kind === "subagents";
  const descendants = (tree.childrenByKey.get(parentKey) ?? []).flatMap((child) =>
    isSidebarSubagentThread(child) === subagents
      ? [child, ...collectSidebarDescendants(tree, sidebarThreadKey(child), sidebarThreadKey)]
      : [],
  );
  const sessionCount = descendants.filter(
    (thread) => isSidebarSubagentThread(thread) === subagents,
  ).length;
  return {
    ...summarizeSidebarDescendants(descendants, isUnread),
    sessionCount,
    otherSessionCount: descendants.length - sessionCount,
  };
}

/**
 * What a collapsed parent says about the descendants it is hiding. `isUnread`
 * is the rows' own unread rule, so a hidden completion is counted exactly when
 * its row would show one.
 */
export function summarizeSidebarDescendants<
  T extends Pick<
    SidebarThreadSummary,
    "environmentId" | "projectId" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
  >,
>(descendants: ReadonlyArray<T>, isUnread: (thread: T) => boolean): SidebarDescendantSummary {
  const counts = new Map<SidebarFamilySummaryStatus, number>();
  const projects = new Set<string>();
  for (const thread of descendants) {
    projects.add(`${thread.environmentId}:${thread.projectId}`);
    const status: SidebarThreadStatus = resolveSidebarThreadStatus(thread);
    if (status === "ready" && !isUnread(thread)) continue;
    const summaryStatus = status === "ready" ? "unread" : status === "limited" ? "failed" : status;
    counts.set(summaryStatus, (counts.get(summaryStatus) ?? 0) + 1);
  }
  return {
    sessionCount: descendants.length,
    projectCount: projects.size,
    attentionCount: (counts.get("approval") ?? 0) + (counts.get("input") ?? 0),
    statuses: SUMMARY_STATUS_ORDER.flatMap((status) => {
      const count = counts.get(status);
      return count === undefined ? [] : [{ status, count }];
    }),
  };
}

type SidebarStoredThread = SidebarTreeThread & Pick<SidebarThreadSummary, "archivedAt">;

/**
 * A thread's depth along its stored parents, 0 for a root. Like the server's
 * count, it stops at an archived or unknown thread, where the list draws a
 * new root.
 */
export function sidebarStoredDepth(
  threadByKey: ReadonlyMap<string, SidebarStoredThread>,
  key: string,
): number {
  const visited = new Set([key]);
  let depth = 0;
  for (let cursor = threadByKey.get(key); cursor !== undefined;) {
    const parentKey = sidebarParentKey(cursor);
    const parent = parentKey === null ? undefined : threadByKey.get(parentKey);
    if (parentKey === null || parent === undefined || parent.archivedAt !== null) break;
    if (visited.has(parentKey)) break;
    visited.add(parentKey);
    depth += 1;
    cursor = parent;
  }
  return depth;
}

/** Whether "New subthread" under `key` stays within SIDEBAR_TREE_MAX_DEPTH. */
export function canAddSidebarSubthread(
  threadByKey: ReadonlyMap<string, SidebarStoredThread>,
  key: string,
): boolean {
  return sidebarStoredDepth(threadByKey, key) < SIDEBAR_TREE_MAX_DEPTH;
}

// Unarchived threads by stored parent. Built on first use for each map, so a
// drag asks once per shell update rather than once per pointer move.
const storedChildKeysByMap = new WeakMap<
  ReadonlyMap<string, SidebarStoredThread>,
  ReadonlyMap<string, ReadonlyArray<string>>
>();
function storedChildKeys(
  threadByKey: ReadonlyMap<string, SidebarStoredThread>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const known = storedChildKeysByMap.get(threadByKey);
  if (known !== undefined) return known;
  const childKeys = new Map<string, string[]>();
  for (const [key, thread] of threadByKey) {
    const parentKey = sidebarParentKey(thread);
    if (parentKey === null || thread.archivedAt !== null) continue;
    const siblings = childKeys.get(parentKey) ?? [];
    siblings.push(key);
    childKeys.set(parentKey, siblings);
  }
  storedChildKeysByMap.set(threadByKey, childKeys);
  return childKeys;
}

/** Whether `key` has threads nested more than `levels` levels under it. */
function sidebarSubtreeIsDeeperThan(
  threadByKey: ReadonlyMap<string, SidebarStoredThread>,
  key: string,
  levels: number,
): boolean {
  const childKeys = storedChildKeys(threadByKey);
  const visited = new Set([key]);
  let level = [key];
  for (let nested = 0; ; nested += 1) {
    level = level
      .flatMap((parentKey) => childKeys.get(parentKey) ?? [])
      .filter((childKey) => !visited.has(childKey));
    if (level.length === 0) return false;
    if (nested >= levels) return true;
    for (const childKey of level) visited.add(childKey);
  }
}

/**
 * Whether the sidebar may offer `parentKey` as a new parent for `childKey`:
 * same environment, no cycle, and the thread with everything nested under it
 * still fits in SIDEBAR_TREE_MAX_DEPTH. `threadByKey` holds every known
 * thread, hidden ones included, so a cycle through a filtered ancestor is
 * still caught. The server validates again and owns the answer; this only
 * keeps invalid targets out of the menu and the drag.
 */
export function canNestSidebarThreadUnder(
  threadByKey: ReadonlyMap<string, SidebarStoredThread>,
  childKey: string,
  parentKey: string,
): boolean {
  if (childKey === parentKey) return false;
  const child = threadByKey.get(childKey);
  const parent = threadByKey.get(parentKey);
  if (child === undefined || parent === undefined) return false;
  if (child.environmentId !== parent.environmentId) return false;
  const visited = new Set<string>();
  for (let cursor: SidebarStoredThread | undefined = parent; cursor !== undefined;) {
    const key = sidebarThreadKey(cursor);
    if (key === childKey) return false;
    if (visited.has(key)) break;
    visited.add(key);
    const ancestorKey = sidebarParentKey(cursor);
    cursor = ancestorKey === null ? undefined : threadByKey.get(ancestorKey);
  }
  const depth = parent.archivedAt === null ? sidebarStoredDepth(threadByKey, parentKey) + 1 : 0;
  return (
    depth <= SIDEBAR_TREE_MAX_DEPTH &&
    !sidebarSubtreeIsDeeperThan(threadByKey, childKey, SIDEBAR_TREE_MAX_DEPTH - depth)
  );
}

/**
 * Every thread `childKey` may move under, for the "Move under" picker: any
 * unarchived thread in the same environment, nested or not and whatever its
 * shelf, except the thread itself, its descendants, the parent it already
 * sits under, and any thread too deep to take it (see
 * canNestSidebarThreadUnder). An archived parent is left out because its
 * children fall back to the top level, which is not what a move asks for.
 */
export function listSidebarMoveTargets<T extends SidebarStoredThread>(
  threadByKey: ReadonlyMap<string, T>,
  childKey: string,
): T[] {
  const child = threadByKey.get(childKey);
  if (child === undefined) return [];
  const currentParentKey = sidebarParentKey(child);
  return [...threadByKey].flatMap(([key, candidate]) =>
    candidate.archivedAt === null &&
    key !== currentParentKey &&
    canNestSidebarThreadUnder(threadByKey, childKey, key)
      ? [candidate]
      : [],
  );
}
