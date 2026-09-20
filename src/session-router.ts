import type { RouterOptions } from "./config.js";
import type { Decide, SessionPin, SessionPins } from "./contracts.js";
import { createRouter, type RouteContext, type RouteResult, RoutingError } from "./router.js";

export function createSessionRouter(options: RouterOptions, decide: Decide, pins: SessionPins) {
  const route = createRouter(options, decide);
  const queues = new Map<string, Promise<void>>();
  async function serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = queues.get(id);
    const next = Promise.withResolvers<void>();
    queues.set(id, next.promise);
    await before;
    try {
      return await action();
    } finally {
      next.resolve();
      if (queues.get(id) === next.promise) queues.delete(id);
    }
  }
  function reuse(pin: SessionPin, context: RouteContext): RouteResult {
    const permitted =
      pin.recovery || options.candidates.some((candidate) => candidate.model === pin.model);
    const available = context.available.find((model) => model.model === pin.model);
    if (
      !permitted ||
      !available?.toolcall ||
      !context.turn.modalities.every((modality) => available.modalities.includes(modality))
    ) {
      throw new RoutingError(
        `Session is pinned to ${pin.model}, which is no longer eligible. Start a new session or disable sticky routing.`,
      );
    }
    return {
      kind: "route",
      model: pin.model,
      variant: pin.variant,
      reason: "sticky",
      pinReason: pin.reason,
      pinned: true,
    };
  }
  return {
    route: (context: RouteContext & { readonly sessionID: string }): Promise<RouteResult> =>
      serialize(context.sessionID, async () => {
        const turn = context.turn;
        if (
          !options.sticky ||
          turn.retry ||
          turn.synthetic ||
          ["title", "summary", "compaction"].includes(turn.agent) ||
          (options.mode === "auto" && (!turn.auto || turn.overridden))
        )
          return route(context);
        const saved = await pins.load(context.sessionID);
        if (saved) return reuse(saved, context);
        const result = await route(context);
        if (result.kind === "skip") return result;
        if (
          result.reason !== "jev" ||
          result.confidence === undefined ||
          result.confidence < options.stickyConfidenceThreshold
        ) {
          return { ...result, pinned: false };
        }
        const winner = await pins.claim(context.sessionID, {
          model: result.model,
          variant: result.variant,
          reason: result.reason,
          confidence: result.confidence,
        });
        const selected = reuse(winner, context);
        return winner.model === result.model && winner.variant === result.variant
          ? { ...result, pinned: true }
          : selected;
      }),
    recover: (sessionID: string, pin: SessionPin, onlyFrom?: readonly string[]) =>
      serialize(sessionID, async () => {
        if (!options.sticky) return;
        const existing = await pins.load(sessionID);
        if (existing && (!onlyFrom || onlyFrom.includes(existing.model)))
          await pins.replace(sessionID, pin);
      }),
    forget: (sessionID: string) => serialize(sessionID, () => pins.forget(sessionID)),
  };
}
