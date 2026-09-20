import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { type RouterOptions, splitModel } from "./config.js";
import type { ExecutionHost } from "./contracts.js";
import { parseExecutionSnapshot } from "./execution-snapshot.js";
import { RoutingError } from "./router.js";

export function executionRetryToken(text: string): string | undefined {
  return /<!-- JEV_EXECUTION_FALLBACK:([a-f0-9-]{36}) -->/.exec(text)?.[1];
}

export function createExecutionHost(
  { client, directory }: Pick<PluginInput, "client" | "directory">,
  options: RouterOptions,
): Pick<ExecutionHost, "inspect" | "dispatch" | "report"> {
  const core: unknown = Reflect.get(client, "_client");
  async function request(method: "get" | "post", url: string, body?: unknown): Promise<unknown> {
    if (!core || typeof core !== "object")
      throw new RoutingError("OpenCode SDK transport unavailable");
    const operation: unknown = Reflect.get(core, method);
    if (typeof operation !== "function")
      throw new RoutingError("OpenCode SDK transport method unavailable");
    const raw: unknown = await operation.call(core, {
      url,
      query: { directory },
      ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const response = z
      .object({
        data: z.unknown().optional(),
        error: z.unknown().optional(),
        response: z.instanceof(Response),
      })
      .parse(raw);
    if (response.error !== undefined || !response.response.ok)
      throw new RoutingError(
        `OpenCode execution recovery request failed (${response.response.status})`,
      );
    return response.data;
  }
  return {
    inspect: async (sessionID) => {
      const [history, statuses, permissions, questions] = await Promise.all([
        request("get", `/session/${encodeURIComponent(sessionID)}/message`),
        request("get", "/session/status"),
        request("get", "/permission"),
        request("get", "/question"),
      ]);
      return parseExecutionSnapshot(sessionID, { history, statuses, permissions, questions });
    },
    dispatch: async (snapshot, target, token) => {
      await request("post", `/session/${encodeURIComponent(snapshot.sessionID)}/prompt_async`, {
        ...snapshot.requestOptions,
        agent: snapshot.agent,
        model: splitModel(target.model),
        ...(target.variant ? { variant: target.variant } : {}),
        parts: [
          {
            type: "text",
            synthetic: true,
            text: `The previous model provider request failed. Continue the same user task from the existing conversation and tool results. Do not replay completed actions, broaden the task, or bypass permissions.\n<!-- JEV_EXECUTION_FALLBACK:${token} -->\n<!-- OMO_INTERNAL_INITIATOR -->`,
          },
        ],
      });
    },
    report: async (sessionID, notice) => {
      const jobs: Promise<unknown>[] = [
        client.app.log({
          body: {
            service: "jev-auto-model-router",
            level: notice.action === "recovered" ? "info" : "warn",
            message: "execution fallback",
            extra: { sessionID, ...notice },
          },
        }),
      ];
      if (options.notify)
        jobs.push(
          client.tui.showToast({
            body: {
              title: "Model provider fallback",
              message: `${notice.action}: ${notice.to ?? notice.from ?? notice.reason}${notice.status ? ` · HTTP ${notice.status}` : ""}${notice.status === 429 ? ` · Retry-After: ${notice.retryAfter ?? "not available"}` : ""}`,
              variant: notice.action === "recovered" ? "info" : "warning",
              duration: 6000,
            },
          }),
        );
      await Promise.allSettled(jobs);
    },
  };
}
