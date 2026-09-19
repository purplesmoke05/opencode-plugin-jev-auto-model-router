import type { Hooks } from "@opencode-ai/plugin";
import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  ConfigurationError,
  type RouterOptions,
  splitModel,
} from "./config.js";
import type { Decide, SessionPins, TaskContext } from "./contracts.js";
import { inspectMessage } from "./message-policy.js";
import { attachmentModalities } from "./modalities.js";
import { type AvailableModel, type RouteResult, RoutingError } from "./router.js";
import { createMemorySessionPins } from "./session-pins.js";
import { createSessionRouter } from "./session-router.js";

export type Host = {
  readonly pins?: SessionPins;
  readonly models: () => Promise<readonly AvailableModel[]>;
  readonly session: (
    id: string,
    currentMessageID?: string,
  ) => Promise<{
    readonly child: boolean;
    readonly modalities: readonly string[];
    readonly context?: TaskContext;
  }>;
  readonly report: (
    sessionID: string,
    result: Extract<RouteResult, { kind: "route" }>,
  ) => Promise<void>;
  readonly apiKey: () => string;
};

export function createHooks(host: Host, options: RouterOptions, decide: Decide): Hooks {
  const sessions = createSessionRouter(options, decide, host.pins ?? createMemorySessionPins());
  return {
    config: async (config) => {
      if (config.provider?.[AUTO_PROVIDER]) {
        throw new ConfigurationError(
          "Provider jev-router is already registered; load this plugin only once.",
        );
      }
      config.provider ??= {};
      config.provider[AUTO_PROVIDER] = {
        name: "Jev Auto Router",
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "virtual-model-no-credential",
          baseURL: "https://jev-router.invalid/v1",
          fetch: async () => {
            throw new RoutingError(
              "Auto reached the provider without routing. Select a real model and check plugin order.",
            );
          },
        },
        models: {
          [AUTO_MODEL]: {
            name: "Auto (Jev)",
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 32000, output: 4096 },
          },
        },
      };
    },
    "chat.message": async (input, output) => {
      const auto =
        output.message.model.providerID === AUTO_PROVIDER &&
        output.message.model.modelID === AUTO_MODEL;
      const forced = options.mode === "force";
      const initial = inspectMessage(output.parts);
      if (initial.retry) {
        if (!auto) {
          const variant =
            "variant" in output.message.model && typeof output.message.model.variant === "string"
              ? output.message.model.variant
              : undefined;
          await sessions.recover(input.sessionID, {
            model: `${output.message.model.providerID}/${output.message.model.modelID}`,
            variant,
            reason: "runtime-recovery",
            recovery: true,
          });
        }
        return;
      }
      if (!forced && !auto) return;
      if (
        forced &&
        ((initial.synthetic && !initial.hasTaskText) ||
          ["title", "summary", "compaction"].includes(output.message.agent))
      )
        return;
      const session = await host.session(input.sessionID, output.message.id);
      const message = inspectMessage(output.parts, forced && session.child);
      if (forced && message.synthetic) return;
      const result = await sessions.route({
        sessionID: input.sessionID,
        turn: {
          auto,
          overridden: false,
          agent: output.message.agent,
          child: session.child,
          ...message,
          modalities: [
            ...new Set(["text", ...session.modalities, ...attachmentModalities(output.parts)]),
          ],
        },
        available: await host.models(),
        apiKey: host.apiKey(),
        ...(session.context ? { context: session.context } : {}),
      });
      switch (result.kind) {
        case "skip":
          return;
        case "route": {
          const model = {
            ...splitModel(result.model),
            ...(result.variant ? { variant: result.variant } : {}),
          };
          output.message.model = model;
          await host.report(input.sessionID, result);
          return;
        }
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") await sessions.forget(event.properties.info.id);
    },
  };
}
