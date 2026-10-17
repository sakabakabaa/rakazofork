import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { plainTextFromMarkdown } from "@rakazo/core";

/** Keep unusually long bot replies from taking over the chat while preserving the full answer. */
export const LONG_REPLY_COLLAPSE_CHARS = 1_600;
const PREVIEW_CHARS = 280;

export function LongReplyMarkdown({
  children: text,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  if (streaming || text.length <= LONG_REPLY_COLLAPSE_CHARS) {
    return <ChatMarkdown streaming={streaming}>{text}</ChatMarkdown>;
  }

  const preview = plainTextFromMarkdown(text).replace(/\s+/g, " ").trim();
  const excerpt = preview.slice(0, PREVIEW_CHARS);

  return (
    <details className="long-reply-disclosure" data-testid="long-reply-disclosure">
      <summary className="cursor-pointer list-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="block text-foreground/85">
          {excerpt}
          {preview.length > PREVIEW_CHARS ? "…" : ""}
        </span>
        <span className="mt-2 inline-block text-[12px] font-medium text-muted-foreground underline underline-offset-4">
          <Trans>Show full response</Trans>
        </span>
      </summary>
      <div className="mt-3 border-t border-border/70 pt-3">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </details>
  );
}
