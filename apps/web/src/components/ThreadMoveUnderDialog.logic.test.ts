import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import {
  buildThreadMoveTargetGroups,
  THREAD_MOVE_SHOW_MORE_VALUE,
  THREAD_MOVE_TARGET_PAGE_SIZE,
} from "./ThreadMoveUnderDialog.logic";

function targets(count: number, title: string, projectName: string): CommandPaletteActionItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "action",
    value: `move-under:${title}-${index}`,
    searchTerms: [title, projectName],
    title,
    description: projectName,
    icon: null,
    run: async () => undefined,
  }));
}

/** Pages the way the picker does: runs "Show more" until it is gone. */
async function pageToEnd(items: ReadonlyArray<CommandPaletteActionItem>, query: string) {
  let visibleCount = THREAD_MOVE_TARGET_PAGE_SIZE;
  const revealed: string[] = [];
  const pages: Array<ReadonlyArray<string>> = [];
  for (;;) {
    const rows = buildThreadMoveTargetGroups({
      items,
      query,
      visibleCount,
      showMoreIcon: null,
      showMore: (firstRevealedValue) => {
        visibleCount += THREAD_MOVE_TARGET_PAGE_SIZE;
        revealed.push(firstRevealedValue);
      },
    }).flatMap((group) => group.items);
    pages.push(rows.map((row) => row.value));
    const showMore = rows.find((row) => row.value === THREAD_MOVE_SHOW_MORE_VALUE);
    if (showMore === undefined || showMore.kind !== "action") break;
    await showMore.run();
  }
  return { pages, revealed };
}

describe("buildThreadMoveTargetGroups", () => {
  it("reaches every one of 120 targets that share a title and project", async () => {
    const items = targets(120, "Reduce AWS costs", "cloud-infra");
    const values = items.map((item) => item.value);

    // The query matches all of them, so it cannot tell them apart.
    for (const query of ["", "aws cloud-infra"]) {
      const { pages, revealed } = await pageToEnd(items, query);

      expect(pages[0]).toEqual([...values.slice(0, 50), THREAD_MOVE_SHOW_MORE_VALUE]);
      expect(pages[1]).toEqual([...values.slice(0, 100), THREAD_MOVE_SHOW_MORE_VALUE]);
      expect(pages[2]).toEqual(values);
      // Each page hands back the row that takes the "Show more" row's place.
      expect(revealed).toEqual([values[50], values[100]]);
    }
  });

  it("says how many targets are still hidden", () => {
    const [group] = buildThreadMoveTargetGroups({
      items: targets(120, "Reduce AWS costs", "cloud-infra"),
      query: "",
      visibleCount: 100,
      showMoreIcon: null,
      showMore: () => undefined,
    });

    expect(group?.label).toBe("Threads · 100 of 120");
    expect(group?.items.at(-1)).toMatchObject({
      title: "Show 20 more",
      description: "20 more not shown",
    });
  });

  it("adds no paging row when a page holds every match", () => {
    const items = [
      ...targets(THREAD_MOVE_TARGET_PAGE_SIZE, "Reduce AWS costs", "cloud-infra"),
      ...targets(70, "Loader cache", "cloud-api"),
    ];
    const rows = (query: string) =>
      buildThreadMoveTargetGroups({
        items,
        query,
        visibleCount: THREAD_MOVE_TARGET_PAGE_SIZE,
        showMoreIcon: null,
        showMore: () => undefined,
      }).flatMap((group) => group.items.map((item) => item.value));

    expect(rows("aws")).toEqual(
      items.slice(0, THREAD_MOVE_TARGET_PAGE_SIZE).map((item) => item.value),
    );
    expect(rows("loader")).toHaveLength(THREAD_MOVE_TARGET_PAGE_SIZE + 1);
    expect(rows("no such thread")).toEqual([]);
  });
});
