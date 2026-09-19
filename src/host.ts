import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import type { RouterOptions } from "./config.js";
import type { Host } from "./hooks.js";
import { attachmentModalities } from "./modalities.js";
import { RoutingError } from "./router.js";

const catalogSchema = z.object({
  connected: z.array(z.string()),
  all: z.array(
    z.object({
      id: z.string(),
      models: z.record(
        z.string(),
        z.object({
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
          })),
        );
    },
    session: async (id) => {
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
      };
    },
    report: async (sessionID, result) => {
      const metadata = {
        sessionID,
        model: result.model,
        variant: result.variant,
        reason: result.reason,
        confidence: result.confidence,
        status: result.status,
        retryAfter: result.retryAfter,
      };
      const tasks: Promise<unknown>[] = [
        client.app.log({
          body: {
            service: "jev-auto-model-router",
            level: result.reason === "jev" ? "info" : "warn",
            message: "model route selected",
            extra: metadata,
          },
        }),
      ];
      if (options.notify) {
        const detail =
          result.reason === "jev"
            ? `Jev confidence ${Math.round((result.confidence ?? 0) * 100)}%`
            : `Fallback: ${result.reason}`;
        const retry =
          result.status === 429
            ? `\nHTTP 429 · Retry-After: ${result.retryAfter ?? "not present"} · no automatic retry`
            : "";
        tasks.push(
          client.tui.showToast({
            body: {
              title: "Auto (Jev)",
              message: `${result.model}${result.variant ? ` (${result.variant})` : ""}\n${detail}${retry}`,
              variant: result.reason === "jev" ? "info" : "warning",
              duration: 6000,
            },
          }),
        );
      }
      await Promise.allSettled(tasks);
    },
  };
}
