import { z } from "zod";
import type { ContextOptions, TaskContext } from "./contracts.js";
import { inspectMessage } from "./message-policy.js";

const historySchema = z.array(
  z.object({
    info: z.object({
      id: z.string().optional(),
      role: z.enum(["user", "assistant"]),
      time: z.object({ created: z.number() }).optional(),
      summary: z.union([z.boolean(), z.object({})]).optional(),
    }),
    parts: z.array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string(),
          synthetic: z.boolean().default(false),
          ignored: z.boolean().default(false),
          injected: z.boolean().default(false),
        }),
        z.object({ type: z.string().refine((type) => type !== "text") }).transform(() => null),
      ]),
    ),
  }),
);

function excerpt(text: string, limit: number): string {
  const prefix = text.slice(0, limit);
  const last = prefix.charCodeAt(prefix.length - 1);
  const next = text.charCodeAt(prefix.length);
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? prefix.slice(0, -1)
    : prefix;
}

export function buildTaskContext(
  history: unknown,
  options: ContextOptions & { readonly childTask?: boolean; readonly currentMessageID?: string },
): TaskContext {
  if (!options.enabled) return { truncated: false };
  const messages = historySchema.parse(history);
  const dated = messages
    .filter((message) => message.info.time !== undefined)
    .sort((left, right) => (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0));
  const datedIterator = dated.values();
  const ordered = messages.map((message) =>
    message.info.time === undefined ? message : (datedIterator.next().value ?? message),
  );
  let previousAssistant: string | undefined;
  for (const { info, parts } of ordered) {
    if (options.currentMessageID !== undefined && info.id === options.currentMessageID) break;
    switch (info.role) {
      case "user":
        break;
      case "assistant": {
        if (info.summary) break;
        const texts = parts.flatMap((part) =>
          part && !part.injected ? [{ ...part, id: "", messageID: "", sessionID: "" }] : [],
        );
        const { prompt } = inspectMessage(texts);
        if (prompt.trim()) previousAssistant = prompt;
        break;
      }
      default:
        info.role satisfies never;
    }
  }
  if (previousAssistant === undefined) return { truncated: false };
  const complete = { previous_assistant: previousAssistant, truncated: false };
  if (JSON.stringify(complete).length <= options.maxCharacters) return complete;

  const render = (limit: number): TaskContext => ({
    previous_assistant: excerpt(previousAssistant, limit),
    truncated: true,
  });
  let lower = 0;
  let upper = Math.min(previousAssistant.length - 1, options.maxCharacters);
  while (lower < upper) {
    const limit = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(render(limit)).length <= options.maxCharacters) lower = limit;
    else upper = limit - 1;
  }
  return render(lower);
}
