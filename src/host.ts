import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import type { RouterOptions } from "./config.js";
import { buildTaskContext } from "./context.js";
import { createExecutionHost } from "./execution-host.js";
import type { Host } from "./hooks.js";
import { attachmentModalities } from "./modalities.js";
import { RoutingError } from "./router.js";
import { createSessionPins } from "./session-pins.js";

const catalogSchema = z.object({
  connected: z.array(z.string()),
  all: z.array(
    z.object({
      id: z.string(),
      models: z.record(
        z.string(),
        z.object({
          variants: z.record(z.string(), z.unknown()).optional(),
          capabilities: z.object({
            toolcall: z.boolean(),
            input: z.record(z.string(), z.boolean()),
          }),
        }),
      ),
    }),
  ),
});

export function createHost(
  input: Pick<PluginInput, "client" | "directory">,
  options: RouterOptions,
): Host {
  const { client, directory } = input;
  return {
    execution: createExecutionHost(input, options),
    pins: createSessionPins(
      join(
        process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
        "opencode",
        "jev-router",
        "sessions-confidence",
      ),
    ),
    apiKey: () => process.env["TYPESAFE_API_KEY"] ?? "",
    models: async () => {
      const response = await client.provider.list({ query: { directory } });
      const parsed = catalogSchema.safeParse(response.data);
      if (!parsed.success)
        throw new RoutingError("Jev Auto: cannot read the connected model catalog.");
      const connected = new Set(parsed.data.connected);
      return parsed.data.all
        .filter((provider) => connected.has(provider.id))
        .flatMap((provider) =>
          Object.entries(provider.models).map(([id, model]) => ({
            model: `${provider.id}/${id}`,
            toolcall: model.capabilities.toolcall,
            modalities: Object.entries(model.capabilities.input)
              .filter(([, supported]) => supported)
              .map(([modality]) => modality),
            ...(model.variants ? { variants: Object.keys(model.variants) } : {}),
          })),
        );
    },
    session: async (id, currentMessageID) => {
      const session = await client.session.get({ path: { id }, query: { directory } });
      if (!session.data) throw new RoutingError("Jev Auto: cannot verify session scope.");
      const history = await client.session.messages({ path: { id }, query: { directory } });
      if (!history.data)
        throw new RoutingError("Jev Auto: cannot verify attachment compatibility.");
      return {
        child: Boolean(session.data.parentID),
        modalities: [
          ...new Set(history.data.flatMap((message) => attachmentModalities(message.parts))),
        ],
        ...(options.context.enabled
          ? {
              context: buildTaskContext(history.data, {
                ...options.context,
                childTask: Boolean(session.data.parentID),
                ...(currentMessageID ? { currentMessageID } : {}),
              }),
            }
          : {}),
      };
    },
    report: async (sessionID, result) => {
      const metadata = {
        sessionID,
        mode: options.mode,
        model: result.model,
        variant: result.variant,
        reason: result.reason,
        confidence: result.confidence,
        status: result.status,
        retryAfter: result.retryAfter,
        contextCharacters: result.contextCharacters,
        contextMessages: result.contextMessages,
        contextTruncated: result.contextTruncated,
        pinReason: result.pinReason,
        pinned: result.pinned,
      };
      const tasks: Promise<unknown>[] = [
        client.app.log({
          body: {
            service: "jev-auto-model-router",
            level: result.reason === "jev" || result.reason === "sticky" ? "info" : "warn",
            message: "model route selected",
            extra: metadata,
          },
        }),
      ];
      if (options.notify) {
        const detail =
          result.reason === "jev"
            ? `Jev confidence ${Math.floor((result.confidence ?? 0) * 10000) / 100}%`
            : result.reason === "sticky"
              ? "Pinned for this session · no Jev request"
              : `Fallback: ${result.reason}`;
        const retry =
          result.status === 429
            ? `\nHTTP 429 · Retry-After: ${result.retryAfter ?? "not present"} · no automatic retry`
            : "";
        const pinStatus =
          result.reason === "sticky" || result.pinned === undefined
            ? ""
            : result.pinned
              ? " · pinned"
              : " · not pinned yet";
        tasks.push(
          client.tui.showToast({
            body: {
              title: options.mode === "force" ? "Auto (Jev) · Force" : "Auto (Jev)",
              message: `${result.model}${result.variant ? ` (${result.variant})` : ""}\n${detail}${pinStatus}${retry}`,
              variant: result.reason === "jev" || result.reason === "sticky" ? "info" : "warning",
              duration: 6000,
            },
          }),
        );
      }
      await Promise.allSettled(tasks);
    },
  };
}
