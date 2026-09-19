import type { RouterOptions } from "./config.js";
import type { Decide, TaskContext } from "./contracts.js";

export type RouteTurn = {
  readonly prompt: string;
  readonly agent: string;
  readonly child: boolean;
  readonly synthetic: boolean;
  readonly auto: boolean;
  readonly overridden: boolean;
  readonly retry?: boolean;
  readonly modalities: readonly string[];
};

export type AvailableModel = {
  readonly model: string;
  readonly toolcall: boolean;
  readonly modalities: readonly string[];
};

export type RouteResult =
  | { readonly kind: "skip" }
  | {
      readonly kind: "route";
      readonly model: string;
      readonly variant?: string | undefined;
      readonly reason: string;
      readonly confidence?: number;
      readonly status?: number;
      readonly retryAfter?: string;
      readonly contextCharacters?: number;
      readonly contextMessages?: number;
      readonly contextTruncated?: boolean;
      readonly pinReason?: string;
      readonly pinned?: boolean;
    };

export type RouteContext = {
  readonly turn: RouteTurn;
  readonly available: readonly AvailableModel[];
  readonly apiKey: string;
  readonly context?: TaskContext;
};

export class RoutingError extends Error {
  override readonly name = "RoutingError";
}

export function createRouter(options: RouterOptions, decide: Decide) {
  return async ({ turn, available, apiKey, context }: RouteContext): Promise<RouteResult> => {
    if (turn.retry) return { kind: "skip" };
    let scopeFallback = false;
    switch (options.mode) {
      case "auto":
        if (!turn.auto || turn.overridden) return { kind: "skip" };
        scopeFallback = turn.child || !options.agents.includes(turn.agent);
        break;
      case "force":
        if (turn.synthetic || ["title", "summary", "compaction"].includes(turn.agent))
          return { kind: "skip" };
        break;
      default: {
        const unreachable: never = options.mode;
        return unreachable;
      }
    }
    const candidates = options.candidates.filter((candidate) =>
      available.some(
        (model) =>
          model.model === candidate.model &&
          model.toolcall &&
          turn.modalities.every((modality) => model.modalities.includes(modality)),
      ),
    );
    const fallback = candidates.find((candidate) => candidate.model === options.fallback);
    if (!fallback) {
      const remedy =
        options.mode === "force"
          ? "Disable force mode or configure a compatible fallback."
          : "Select a compatible model manually.";
      throw new RoutingError(
        `Jev Auto: configured fallback is disconnected, lacks tools, or cannot accept these attachments. ${remedy}`,
      );
    }
    const useFallback = (reason: string): Extract<RouteResult, { kind: "route" }> => ({
      kind: "route",
      ...fallback,
      reason,
    });
    if (scopeFallback) return useFallback("scope-fallback");
    if (turn.synthetic) return useFallback("synthetic-fallback");
    if (!turn.prompt.trim()) return useFallback("empty-prompt");
    if (turn.prompt.length > options.maxPromptChars) return useFallback("prompt-too-long");
    if (!apiKey.trim()) return useFallback("missing-key");
    const result = await decide({
      prompt: turn.prompt,
      candidates,
      apiKey,
      timeoutMs: options.timeoutMs,
      ...(options.context.enabled && context ? { context } : {}),
    });
    const contextMetadata =
      options.context.enabled && context
        ? {
            contextCharacters: JSON.stringify(context).length,
            contextMessages: context.previous_assistant ? 1 : 0,
            contextTruncated: context.truncated,
          }
        : {};
    switch (result.kind) {
      case "unavailable":
        return {
          ...result,
          ...useFallback(result.reason),
          ...contextMetadata,
          kind: "route",
          model: fallback.model,
        };
      case "selected": {
        const chosen = candidates.find((candidate) => candidate.model === result.model);
        if (!chosen) return { ...useFallback("invalid-choice"), ...contextMetadata };
        if (result.confidence < options.confidenceThreshold)
          return {
            ...useFallback("low-confidence"),
            ...contextMetadata,
            confidence: result.confidence,
          };
        return {
          kind: "route",
          ...chosen,
          reason: "jev",
          confidence: result.confidence,
          ...contextMetadata,
        };
      }
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  };
}
