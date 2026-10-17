import { cn } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export type RailEntry = {
  id: string;
  /** Visible to screen readers and used as the tooltip; the rail itself is icon-only. */
  label: string;
  icon: ReactNode;
  /** Shown greyed out with this as the reason, rather than hidden: the user may be able
   *  to make it available, and a missing entry reads as a bug. */
  unavailable?: string;
};

/**
 * The destination strip for the side panel.
 *
 * Vertical on a wide window, where it reads as a workspace switcher, and a horizontal
 * row above the content on a narrow one, where the panel is a sheet and a column would
 * eat the width the content needs.
 */
export function RightPanelRail({
  entries,
  active,
  onSelect,
}: {
  entries: RailEntry[];
  active: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      data-testid="right-panel-rail"
      aria-label="Panel"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-sidebar-border p-1.5 md:w-[52px] md:flex-col md:overflow-visible md:border-b-0 md:border-e md:p-2"
    >
      {entries.map((entry) => {
        const selected = entry.id === active;
        return (
          <button
            key={entry.id}
            type="button"
            aria-label={entry.label}
            aria-pressed={selected}
            title={entry.unavailable ?? entry.label}
            disabled={Boolean(entry.unavailable)}
            onClick={() => onSelect(entry.id)}
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-[9px] transition-colors",
              selected
                ? "bg-accent text-foreground"
                : "text-muted-foreground/70 hover:bg-accent hover:text-foreground/80",
              entry.unavailable && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            {entry.icon}
          </button>
        );
      })}
    </nav>
  );
}
