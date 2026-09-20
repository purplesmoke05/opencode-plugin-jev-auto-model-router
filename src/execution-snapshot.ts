import { z } from "zod";
import type { ExecutionSnapshot } from "./contracts.js";

const errorSchema = z.object({
  name: z.string(),
  data: z
    .object({
      statusCode: z.number().optional(),
      isRetryable: z.boolean().optional(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
const messagesSchema = z.array(
  z.object({
    info: z.object({
      id: z.string(),
      role: z.enum(["user", "assistant"]),
      parentID: z.string().optional(),
      time: z.object({ created: z.number(), completed: z.number().optional() }),
      modelID: z.string().optional(),
      providerID: z.string().optional(),
      agent: z.string().optional(),
      error: errorSchema.optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      system: z.string().optional(),
      format: z.unknown().optional(),
    }),
    parts: z.array(z.object({ type: z.string(), mime: z.string().optional() })),
  }),
);

export type ExecutionData = {
  readonly history: unknown;
  readonly statuses: unknown;
  readonly permissions: unknown;
  readonly questions: unknown;
};

export function parseExecutionSnapshot(
  sessionID: string,
  data: ExecutionData,
): ExecutionSnapshot | undefined {
  const messages = messagesSchema
    .parse(data.history)
    .sort((a, b) => a.info.time.created - b.info.time.created);
  const user = messages.findLast((message) => message.info.role === "user");
  const assistant = messages.findLast((message) => message.info.role === "assistant");
  if (
    !user ||
    !assistant ||
    assistant.info.parentID !== user.info.id ||
    !assistant.info.providerID ||
    !assistant.info.modelID ||
    !assistant.info.agent
  )
    return;
  const statuses = z.record(z.string(), z.object({ type: z.string() })).parse(data.statuses);
  const pending = z.array(z.object({ sessionID: z.string() }));
  const blocked = [...pending.parse(data.permissions), ...pending.parse(data.questions)].some(
    (item) => item.sessionID === sessionID,
  );
  const error = assistant.info.error;
  const status = error?.data?.statusCode;
  const retryable =
    error?.name === "APIError" &&
    (error.data?.isRetryable === true ||
      status === 429 ||
      (status !== undefined && status >= 500 && status <= 599));
  const rawRetryAfter = Object.entries(error?.data?.responseHeaders ?? {}).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  const retryAfter = rawRetryAfter?.replace(/\p{Cc}/gu, "").slice(0, 128);
  const modalities = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "file") return [];
      if (part.mime?.startsWith("image/")) return ["image"];
      if (part.mime?.startsWith("audio/")) return ["audio"];
      if (part.mime?.startsWith("video/")) return ["video"];
      if (part.mime === "application/pdf") return ["pdf"];
      if (part.mime === "text/plain" || part.mime === "application/x-directory") return [];
      return ["unsupported-attachment"];
    }),
  );
  return {
    sessionID,
    userID: user.info.id,
    assistantID: assistant.info.id,
    model: `${assistant.info.providerID}/${assistant.info.modelID}`,
    agent: assistant.info.agent,
    idle: !statuses[sessionID] || statuses[sessionID]?.type === "idle",
    blocked,
    complete: assistant.info.time.completed !== undefined,
    failed: Boolean(error),
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    modalities: [...new Set(["text", ...modalities])],
    requestOptions: {
      ...(user.info.tools ? { tools: user.info.tools } : {}),
      ...(user.info.system ? { system: user.info.system } : {}),
      ...(user.info.format === undefined ? {} : { format: user.info.format }),
    },
  };
}
