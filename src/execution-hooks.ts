import type { Hooks } from "@opencode-ai/plugin";
import { z } from "zod";
import type { RouterOptions } from "./config.js";
import { ConfigurationError } from "./config.js";
import type { ExecutionHost } from "./contracts.js";
import { createExecutionController } from "./execution-controller.js";
import { executionRetryToken } from "./execution-host.js";
import { inspectMessage } from "./message-policy.js";
import { RoutingError } from "./router.js";

const STOP_MARKER = "<!-- JEV_EXECUTION_FALLBACK_STOP -->";
const envelope = z.object({ type: z.string(), properties: z.record(z.string(), z.unknown()) });
const infoSchema = z.object({
  id: z.string().optional(),
  sessionID: z.string().optional(),
  error: z.unknown().optional(),
});

export function withExecutionFallbacks(
  hooks: Hooks,
  options: RouterOptions,
  host: ExecutionHost,
): Hooks {
  const controller = createExecutionController(options.executionFallbacks, host);
  const skippedCommands = new Set<string>();
  const work = new Set<Promise<void>>();
  function drive(id: string) {
    const task = controller.idle(id).catch(async (error: unknown) => {
      controller.stop(id);
      await Promise.allSettled([
        host.report(id, {
          action: "stopped",
          reason: error instanceof Error ? "recovery-error" : "unknown-error",
        }),
      ]);
    });
    work.add(task);
    void task.then(() => {
      work.delete(task);
    });
  }
  return {
    ...hooks,
    config: async (config) => {
      await hooks.config?.(config);
      config.command ??= {};
      if (config.command["jev-fallback-stop"])
        throw new ConfigurationError("Command jev-fallback-stop is already registered");
      config.command["jev-fallback-stop"] = {
        description: "Stop pending model-provider fallback retries",
        template: `${STOP_MARKER}\nProvider retries have been stopped for this request. Acknowledge briefly without doing more work.`,
      };
    },
    "chat.message": async (input, output) => {
      const texts = output.parts.filter((part) => part.type === "text");
      const token = texts
        .filter((part) => part.synthetic)
        .map((part) => executionRetryToken(part.text))
        .find(Boolean);
      if (token) {
        const variant =
          "variant" in output.message.model && typeof output.message.model.variant === "string"
            ? output.message.model.variant
            : undefined;
        if (
          !controller.acceptRetry(input.sessionID, token, output.message.id, {
            model: `${output.message.model.providerID}/${output.message.model.modelID}`,
            variant,
          })
        ) {
          throw new RoutingError(
            "Provider retry cancelled because the session changed or was stopped",
          );
        }
        return;
      }
      controller.stop(input.sessionID);
      const skipped =
        skippedCommands.delete(input.sessionID) ||
        texts.some(
          (part) =>
            part.text.includes(STOP_MARKER) ||
            /^\s*(?:stop|cancel|停止|中止|やめて)[.!。！]?\s*$/i.test(part.text),
        );
      const foreignRetry = inspectMessage(output.parts).retry;
      await hooks["chat.message"]?.(input, output);
      if (!skipped && !foreignRetry) controller.begin(input.sessionID, output.message.id);
    },
    "command.execute.before": async (input, output) => {
      if (["stop-continuation", "jev-fallback-stop"].includes(input.command.toLowerCase())) {
        controller.stop(input.sessionID);
        skippedCommands.add(input.sessionID);
      }
      await hooks["command.execute.before"]?.(input, output);
    },
    event: async (input) => {
      await hooks.event?.(input);
      const event = envelope.parse(input.event);
      const info = infoSchema.safeParse(event.properties["info"]);
      const id =
        typeof event.properties["sessionID"] === "string"
          ? event.properties["sessionID"]
          : info.success
            ? (info.data.sessionID ?? info.data.id)
            : undefined;
      if (!id) return;
      switch (event.type) {
        case "session.error":
          controller.failure(id);
          drive(id);
          break;
        case "message.updated":
          if (info.success && info.data.error) controller.failure(id);
          drive(id);
          break;
        case "session.idle":
          drive(id);
          break;
        case "session.status": {
          const status = z.object({ type: z.string() }).safeParse(event.properties["status"]);
          if (status.success && status.data.type === "idle") drive(id);
          break;
        }
        case "permission.asked":
        case "permission.updated":
        case "question.asked":
          controller.stop(id);
          break;
        case "session.deleted":
          controller.forget(id);
          skippedCommands.delete(id);
          break;
      }
    },
    dispose: async () => {
      controller.dispose();
      await Promise.allSettled(work);
      await hooks.dispose?.();
    },
  };
}
