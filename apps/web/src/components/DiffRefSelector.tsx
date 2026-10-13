import type { BaseRefChoice } from "../lib/baseRefChoices";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { filterBaseRefChoices } from "../lib/baseRefChoices";

const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

export function DiffRefSelector({
  choices,
  value,
  displayValue,
  label,
  defaultLabel,
  query,
  onQueryChange,
  onChange,
}: {
  choices: ReadonlyArray<BaseRefChoice>;
  value: string | null;
  displayValue: string;
  label: string;
  defaultLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  onChange: (value: string | null) => void;
}) {
  const valueForBaseRefChoice = (choice: BaseRefChoice) =>
    value && value === choice.remote?.name
      ? value
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const items = [AUTOMATIC_BASE_REF, ...choices.map(valueForBaseRefChoice)];
  const filteredItems = [
    ...(query.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...filterBaseRefChoices(choices, query).map(valueForBaseRefChoice),
  ];
  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      value={value ?? AUTOMATIC_BASE_REF}
      onOpenChange={(open) => {
        if (!open) onQueryChange("");
      }}
      onValueChange={(value) => {
        if (!value) return;
        onChange(value === AUTOMATIC_BASE_REF ? null : value);
      }}
    >
      <ComboboxTrigger
        render={<Button variant="ghost-muted" size="xs" />}
        className="min-w-0 max-w-48"
        aria-label={`${label}. Currently ${displayValue}`}
      >
        <span className="min-w-0 truncate">{displayValue}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
      >
        <ComboboxSearchInput
          placeholder="Search refs..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
          <span aria-hidden="true" />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
            <span>Branch</span>
            <span className="text-right">Remote</span>
          </div>
        </div>
        <ComboboxEmpty>No matching refs.</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
          <ComboboxItem
            className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
            value={AUTOMATIC_BASE_REF}
          >
            <span className="block min-w-0 truncate">{defaultLabel}</span>
          </ComboboxItem>
          {choices.map((choice) => {
            const item = valueForBaseRefChoice(choice);
            const hasBoth = choice.local !== null && choice.remote !== null;
            const useRemote = choice.remote?.name === item;
            return (
              <ComboboxItem
                key={choice.id}
                className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                value={item}
              >
                <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                  <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                  {hasBoth ? (
                    <div
                      className="flex justify-end"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Switch
                        aria-label={`Use remote version of ${choice.label}`}
                        checked={useRemote}
                        className="[--thumb-size:--spacing(3)]"
                        onCheckedChange={(checked) => {
                          const nextRef = checked ? choice.remote?.name : choice.local?.name;
                          if (nextRef) onChange(nextRef);
                        }}
                      />
                    </div>
                  ) : choice.remote ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex justify-end text-muted-foreground">
                            <CheckIcon role="img" aria-label="Remote only" className="size-3" />
                          </span>
                        }
                      />
                      <TooltipPopup side="top">Remote only</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
