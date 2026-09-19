import type { Hooks } from "@opencode-ai/plugin";
import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  ConfigurationError,
  type RouterOptions,
  splitModel,
} from "./config.js";
import type { Decide } from "./contracts.js";
import { attachmentModalities } from "./modalities.js";
import { type AvailableModel, createRouter, type RouteResult, RoutingError } from "./router.js";

export type Host = {
  readonly models: () => Promise<readonly AvailableModel[]>;
  readonly session: (
    id: string,
  ) => Promise<{ readonly child: boolean; readonly modalities: readonly string[] }>;
  readonly report: (
    sessionID: string,
    result: Extract<RouteResult, { kind: "route" }>,
  ) => Promise<void>;
  readonly apiKey: () => string;
};

export function createHooks(host: Host, options: RouterOptions, decide: Decide): Hooks {
  const route = createRouter(options, decide);
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
      if (
        output.message.model.providerID !== AUTO_PROVIDER ||
        output.message.model.modelID !== AUTO_MODEL
      )
        return;
      const session = await host.session(input.sessionID);
      const texts = output.parts.filter(
        (part) => part.type === "text" && !part.synthetic && !part.ignored,
      );
      const result = await route({
        turn: {
          auto: true,
          overridden: false,
          agent: output.message.agent,
          child: session.child,
          synthetic: texts.length === 0,
          prompt: texts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          modalities: [
            ...new Set(["text", ...session.modalities, ...attachmentModalities(output.parts)]),
          ],
        },
        available: await host.models(),
        apiKey: host.apiKey(),
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
  };
}
