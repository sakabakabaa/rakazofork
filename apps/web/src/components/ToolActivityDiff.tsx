import { Trans } from "@lingui/react/macro";
import type { ToolDiff } from "@rakazo/contracts";
import { ChevronRight, FileText } from "lucide-react";

type DiffLineKind = "add" | "del" | "context";

/** Tinted by the semantic status tokens; the `+`/`-` prefix carries the same meaning without colour. */
const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  context: "text-muted-foreground",
};

/** File headers (`+++`/`---`) are context, not a change to the file's contents. */
function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "context";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function DiffHeader({ diff }: { diff: ToolDiff }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <FileText aria-hidden size={13} className="shrink-0 text-muted-foreground" />
      <span
        className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] font-mono text-[12px] text-muted-foreground"
        title={diff.path}
      >
        {diff.path}
      </span>
      {diff.additions === undefined ? null : (
        <span className="shrink-0 font-mono text-[12px] text-success">+{diff.additions}</span>
      )}
      {diff.deletions === undefined ? null : (
        <span className="shrink-0 font-mono text-[12px] text-destructive">−{diff.deletions}</span>
      )}
    </span>
  );
}

/**
 * One file change under an activity row. Collapsed by default; a patch that was never
 * produced renders its reason instead, and a truncated one points at the artifact.
 */
export function ToolDiffView({ diff }: { diff: ToolDiff }) {
  const reason = diff.unavailableReason?.trim();
  const patch = diff.patch;
  // A patch that was cut short, or one that could not be produced at all, is never shown as
  // if it were the whole change.
  if (!patch || diff.truncated || reason) {
    const note =
      reason ?? (diff.truncated ? <Trans>Truncated. Open the artifact for the rest.</Trans> : null);
    return (
      <div
        data-testid="tool-diff"
        className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-border/60 px-2 py-1"
      >
        <DiffHeader diff={diff} />
        {note ? (
          <span className="min-w-0 text-[12px] leading-4 text-muted-foreground">{note}</span>
        ) : null}
      </div>
    );
  }
  return (
    <details
      data-testid="tool-diff"
      className="group/diff mt-1 min-w-0 rounded-md border border-border/60"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden
          size={12}
          strokeWidth={1.8}
          className="shrink-0 text-muted-foreground transition-transform duration-150 group-open/diff:rotate-90 motion-reduce:transition-none"
        />
        <DiffHeader diff={diff} />
      </summary>
      <pre className="mt-0.5 overflow-x-auto border-t border-border/60 py-1 text-[12px] leading-4">
        <code className="block">
          {patch.split("\n").map((line, index) => {
            const kind = diffLineKind(line);
            return (
              <span
                // Diff lines have no stable identity; the position is the identity.
                key={index}
                data-testid="tool-diff-line"
                data-kind={kind}
                className={`block whitespace-pre px-2 ${LINE_CLASS[kind]}`}
              >
                {line.length === 0 ? "\u00a0" : line}
              </span>
            );
          })}
        </code>
      </pre>
    </details>
  );
}
