import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("ranking an inbox row by its family", () => {
  const completedRun = (completedAt: string) => ({
    runId: RunId.make(`run:${completedAt}`),
    status: "completed" as const,
    requestedAt: "2026-06-01T00:30:00.000Z",
    startedAt: "2026-06-01T00:30:00.000Z",
    completedAt,
    assistantMessageId: null,
  });
  const root = thread("root", false);
  const other = { ...thread("other", false), latestRun: completedRun("2026-06-01T02:00:00.000Z") };
  // Nested under `root` in the sidebar, so the root's row stands for it.
  const child = { ...thread("child", false), latestRun: completedRun("2026-06-01T03:00:00.000Z") };
  const familyOf = (candidate: { readonly id: string }) => (candidate.id === "root" ? [child] : []);

  it("surfaces a root when a nested thread's run comes back to the user", () => {
    expect(sortInboxThreadsByReturn([root, other]).map((entry) => entry.id)).toEqual([
      "other",
      "root",
    ]);
    expect(
      sortInboxThreadsByReturn([root, other], undefined, familyOf).map((entry) => entry.id),
    ).toEqual(["root", "other"]);
  });

  it("counts a nested thread's observed return the same way", () => {
    const quiet = thread("quiet-child", false);
    const observed = (candidate: { readonly id: string }) =>
      candidate.id === "quiet-child" ? Date.parse("2026-06-02T00:00:00.000Z") : undefined;

    expect(
      sortInboxThreadsByReturn([other, root], observed, (candidate) =>
        candidate.id === "root" ? [quiet] : [],
      ).map((entry) => entry.id),
    ).toEqual(["root", "other"]);
  });

  it("orders Working families by the last message sent anywhere in them", () => {
    const sentEarly = {
      ...thread("root", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
    };
    const sentLate = {
      ...thread("other", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const nested = {
      ...thread("child", true),
      latestUserAuthoredMessageAt: "2026-06-01T03:00:00.000Z",
    };

    expect(sortWorkingThreadsBySend([sentEarly, sentLate]).map((entry) => entry.id)).toEqual([
      "other",
      "root",
    ]);
    expect(
      sortWorkingThreadsBySend([sentEarly, sentLate], (candidate) =>
        candidate.id === "root" ? [nested] : [],
      ).map((entry) => entry.id),
    ).toEqual(["root", "other"]);
  });
});
