import { useAtomValue } from "@effect/atom-react";
import { ChevronsDownIcon, CornerDownRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { primaryServerKeybindingsAtom } from "~/state/server";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import {
  buildThreadMoveTargetGroups,
  THREAD_MOVE_SHOW_MORE_VALUE,
  THREAD_MOVE_TARGET_PAGE_SIZE,
} from "./ThreadMoveUnderDialog.logic";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

export interface ThreadMoveTarget {
  /** Scoped thread key of the thread to move under. */
  readonly key: string;
  readonly title: string;
  readonly projectName: string | null;
}

type Request = {
  readonly threadTitle: string;
  readonly targets: ReadonlyArray<ThreadMoveTarget>;
  readonly resolve: (key: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Ask which thread to move `threadTitle` under. `targets` is every thread
 * that may take it (see listSidebarMoveTargets), however many there are: the
 * picker narrows them by title and project and pages through the rest, so
 * targets that share both stay reachable. Resolves to the chosen target's key,
 * or null when the picker is dismissed.
 */
export function requestThreadMoveTarget(input: {
  readonly threadTitle: string;
  readonly targets: ReadonlyArray<ThreadMoveTarget>;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(key: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(key);
}

export function ThreadMoveUnderDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ThreadMoveUnderDialog request={request} /> : null;
}

function ThreadMoveUnderDialog({ request }: { request: Request }) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(THREAD_MOVE_TARGET_PAGE_SIZE);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const items = useMemo<CommandPaletteActionItem[]>(
    () =>
      request.targets.map((target) => ({
        kind: "action",
        value: `move-under:${target.key}`,
        searchTerms: [target.title, target.projectName ?? ""],
        title: target.title,
        ...(target.projectName === null ? {} : { description: target.projectName }),
        icon: <CornerDownRightIcon className={ITEM_ICON_CLASS} />,
        run: async () => finish(target.key),
      })),
    [request.targets],
  );
  // Drawn a page at a time, so an environment with thousands of threads opens
  // fast; "Show more" reaches the rest.
  const groups = useMemo(
    () =>
      buildThreadMoveTargetGroups({
        items,
        query,
        visibleCount,
        showMoreIcon: <ChevronsDownIcon className={ITEM_ICON_CLASS} />,
        showMore: (firstRevealedValue) => {
          setVisibleCount((count) => count + THREAD_MOVE_TARGET_PAGE_SIZE);
          // The first new row lands where "Show more" was, which is the row
          // the list still has highlighted: show that, so Enter moves under
          // the row that looks selected.
          setHighlightedItemValue(firstRevealedValue);
        },
      }),
    [items, query, visibleCount],
  );
  const label = `Move "${request.threadTitle}" under`;

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <CommandDialogPopup
        aria-label={label}
        className="overflow-hidden"
        onBackdropPointerDown={() => finish(null)}
      >
        <CommandPaletteContent
          aria-label={label}
          autoHighlight="always"
          escapeLabel="Cancel"
          footerActionLabel={
            highlightedItemValue === THREAD_MOVE_SHOW_MORE_VALUE ? "Show more" : "Move under"
          }
          inputProps={{ placeholder: `${label}…` }}
          mode="none"
          onItemHighlighted={(value) => {
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={(value) => {
            setHighlightedItemValue(null);
            setVisibleCount(THREAD_MOVE_TARGET_PAGE_SIZE);
            setQuery(value);
          }}
          testId="thread-move-under-picker"
          value={query}
        >
          <CommandPaletteResults
            groups={groups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
            emptyStateMessage="No matching threads."
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
