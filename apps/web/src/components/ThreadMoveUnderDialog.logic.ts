import type { ReactNode } from "react";

import {
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

/** How many more targets each "Show more" adds to the picker. */
export const THREAD_MOVE_TARGET_PAGE_SIZE = 50;
export const THREAD_MOVE_SHOW_MORE_VALUE = "move-under:show-more";

/**
 * The "Move under" picker's rows: the targets matching `query`, the first
 * `visibleCount` of them, then a "Show more" row while any are left. Paging is
 * what keeps every target reachable. A query only narrows by title and
 * project, and any number of targets can share both.
 */
export function buildThreadMoveTargetGroups(input: {
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
  readonly query: string;
  readonly visibleCount: number;
  readonly showMoreIcon: ReactNode;
  /** Called with the first row the next page reveals, which takes the "Show more" row's place. */
  readonly showMore: (firstRevealedValue: string) => void;
}): CommandPaletteGroup[] {
  return filterCommandPaletteGroups({
    activeGroups: [{ value: "move-under-targets", label: "Threads", items: input.items }],
    query: input.query,
    isInSubmenu: true,
    projectSearchItems: [],
    threadSearchItems: [],
  }).map((group) => {
    const firstHidden = group.items[input.visibleCount];
    if (firstHidden === undefined) return group;
    const hiddenCount = group.items.length - input.visibleCount;
    return {
      ...group,
      label: `Threads · ${input.visibleCount} of ${group.items.length}`,
      items: [
        ...group.items.slice(0, input.visibleCount),
        {
          kind: "action",
          value: THREAD_MOVE_SHOW_MORE_VALUE,
          searchTerms: [],
          title: `Show ${Math.min(hiddenCount, THREAD_MOVE_TARGET_PAGE_SIZE)} more`,
          description: `${hiddenCount} more not shown`,
          icon: input.showMoreIcon,
          run: async () => input.showMore(firstHidden.value),
        },
      ],
    };
  });
}
