import type { RouterOptions } from "./config.js";
import type { Decide } from "./contracts.js";

export type RouteTurn = {
  readonly prompt: string;
  readonly agent: string;
  readonly child: boolean;
  readonly synthetic: boolean;
  readonly auto: boolean;
  readonly overridden: boolean;
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
    };

export type RouteContext = {
  readonly turn: RouteTurn;
  readonly available: readonly AvailableModel[];
  readonly apiKey: string;
};

export class RoutingError extends Error {
  override readonly name = "RoutingError";
}

export function createRouter(options: RouterOptions, decide: Decide) {
  return async ({ turn, available, apiKey }: RouteContext): Promise<RouteResult> => {
    if (!turn.auto || turn.overridden) return { kind: "skip" };
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
      throw new RoutingError(
        "Jev Auto: configured fallback is disconnected, lacks tools, or cannot accept these attachments. Select a compatible model manually.",
      );
    }
    const useFallback = (reason: string): RouteResult => ({ kind: "route", ...fallback, reason });
    if (turn.child || !options.agents.includes(turn.agent)) return useFallback("scope-fallback");
    if (turn.synthetic) return useFallback("synthetic-fallback");
    if (!turn.prompt.trim()) return useFallback("empty-prompt");
    if (turn.prompt.length > options.maxPromptChars) return useFallback("prompt-too-long");
    if (!apiKey.trim()) return useFallback("missing-key");
    const result = await decide({
      prompt: turn.prompt,
      candidates,
      apiKey,
      timeoutMs: options.timeoutMs,
    });
    switch (result.kind) {
      case "unavailable":
        return { ...result, ...useFallback(result.reason), kind: "route", model: fallback.model };
      case "selected": {
        const chosen = candidates.find((candidate) => candidate.model === result.model);
        if (!chosen) return useFallback("invalid-choice");
        if (result.confidence < options.confidenceThreshold) return useFallback("low-confidence");
        return { kind: "route", ...chosen, reason: "jev", confidence: result.confidence };
      }
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  };
}
