import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@admin/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@admin/components/ui/command";

export type ModelChoice = {
  value: string;
  label: string;
  /** Secondary line: a model ID (monospace) or an inherited model name. */
  detail?: string;
  mono?: boolean;
  /** Choices sharing a group render under one heading (the provider). */
  group?: string;
  disabled?: boolean;
};

/** A searchable, keyboard-accessible picker for the organization model catalog. */
export function ModelChoicePicker({
  id,
  label,
  value,
  choices,
  disabled,
  searchLabel,
  emptyLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  choices: ModelChoice[];
  disabled: boolean;
  searchLabel: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = choices.find((choice) => choice.value === value);
  const groups = [...new Set(choices.map((choice) => choice.group ?? ""))];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full min-w-0 justify-between"
          disabled={disabled}
          aria-label={`${label}: ${current?.label ?? value}`}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            {current && !current.value && current.detail ? (
              // The fallback's own name stays whole; the inherited model yields.
              <span className="shrink-0">{current.label}</span>
            ) : (
              <span className="truncate">{current?.label ?? value}</span>
            )}
            {current && !current.value && current.detail && (
              <span className="truncate text-xs text-muted-foreground">
                {current.detail}
              </span>
            )}
          </span>
          <ChevronsUpDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-(--radix-popover-trigger-width) min-w-72"
      >
        <Command>
          <CommandInput placeholder={searchLabel} aria-label={searchLabel} />
          <CommandList aria-label={label}>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group || "none"} heading={group || undefined}>
                {choices
                  .filter((choice) => (choice.group ?? "") === group)
                  .map((choice) => (
                    <CommandItem
                      key={choice.value || "none"}
                      value={choice.value || "none"}
                      keywords={[
                        choice.label,
                        choice.detail ?? "",
                        choice.group ?? "",
                      ]}
                      disabled={choice.disabled}
                      data-checked={choice.value === value}
                      onSelect={() => {
                        if (choice.disabled) return;
                        if (choice.value !== value) onChange(choice.value);
                        setOpen(false);
                      }}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate">{choice.label}</span>
                        {choice.detail && (
                          <span
                            data-mono={choice.mono}
                            className="truncate text-xs text-muted-foreground data-[mono=true]:font-mono"
                          >
                            {choice.detail}
                          </span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
