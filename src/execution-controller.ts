import type { RouterOptions } from "./config.js";
import type {
  ExecutionHost,
  ExecutionNotice,
  ExecutionSnapshot,
  ExecutionTarget,
} from "./contracts.js";

type Recovery = { readonly target: ExecutionTarget; readonly assistantID: string };
type Session = {
  userID: string;
  active: boolean;
  error: boolean;
  readonly seen: Set<string>;
  readonly attempted: Set<string>;
  pending: (Recovery & { readonly token: string }) | undefined;
  recovery: Recovery | undefined;
};

function metadata(snapshot: ExecutionSnapshot): Pick<ExecutionNotice, "status" | "retryAfter"> {
  return {
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    ...(snapshot.retryAfter === undefined ? {} : { retryAfter: snapshot.retryAfter }),
  };
}

function ready(snapshot: ExecutionSnapshot): boolean {
  return snapshot.idle && snapshot.complete && !snapshot.blocked;
}

function halt(state: Session): void {
  state.active = false;
  state.pending = undefined;
  state.recovery = undefined;
}

export function createExecutionController(
  chains: RouterOptions["executionFallbacks"],
  host: ExecutionHost,
) {
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<void>>();
  let disposed = false;
  const current = (sessionID: string, state: Session) =>
    !disposed && sessions.get(sessionID) === state && state.active;

  async function process(sessionID: string, state: Session): Promise<void> {
    if (!current(sessionID, state) || state.pending || (!state.error && !state.recovery)) return;
    let operation = "inspect";
    let details: Pick<ExecutionNotice, "status" | "retryAfter"> = {};
    try {
      const snapshot = await host.inspect(sessionID);
      if (!current(sessionID, state) || !snapshot) return;
      if (snapshot.sessionID !== sessionID || snapshot.userID !== state.userID) {
        halt(state);
        return;
      }
      if (!ready(snapshot) || state.seen.has(snapshot.assistantID)) return;
      details = metadata(snapshot);
      const recovery = state.recovery;
      if (recovery && snapshot.model !== recovery.target.model) {
        halt(state);
        return;
      }
      if (!snapshot.failed) {
        if (!recovery || snapshot.assistantID === recovery.assistantID) return;
        state.recovery = undefined;
        state.error = false;
        state.seen.add(snapshot.assistantID);
        operation = "recovered";
        await host.recovered(sessionID, recovery.target);
        if (!current(sessionID, state)) return;
        operation = "report";
        await host.report(sessionID, {
          action: "recovered",
          reason: "execution-succeeded",
          to: recovery.target.model,
          ...details,
        });
        return;
      }
      if (!state.error) return;
      const chain = chains.find((entry) =>
        entry.models.some((target) => target.model === snapshot.model),
      );
      if (!chain) return;
      if (!snapshot.retryable) {
        operation = "report";
        await host.report(sessionID, {
          action: "stopped",
          reason: "nonretryable",
          from: snapshot.model,
          ...details,
        });
        halt(state);
        return;
      }
      operation = "models";
      const models = await host.models();
      if (!current(sessionID, state)) return;
      const index = chain.models.findIndex((target) => target.model === snapshot.model);
      const target = chain.models.slice(index + 1).find((entry) => {
        const model = models.find((available) => available.model === entry.model);
        return (
          !state.attempted.has(entry.model) &&
          model?.toolcall &&
          snapshot.modalities.every((modality) => model.modalities.includes(modality)) &&
          (entry.variant === undefined || model.variants?.includes(entry.variant))
        );
      });
      operation = "inspect";
      const latest = await host.inspect(sessionID);
      if (
        !current(sessionID, state) ||
        !latest ||
        !ready(latest) ||
        !latest.failed ||
        !latest.retryable ||
        latest.sessionID !== sessionID ||
        latest.userID !== state.userID ||
        latest.assistantID !== snapshot.assistantID ||
        latest.model !== snapshot.model
      )
        return;
      details = metadata(latest);
      if (target) {
        const model = models.find((entry) => entry.model === target.model);
        if (!latest.modalities.every((modality) => model?.modalities.includes(modality))) return;
      }
      state.seen.add(snapshot.assistantID);
      state.attempted.add(snapshot.model);
      state.error = false;
      state.recovery = undefined;
      if (!target) {
        operation = "report";
        await host.report(sessionID, {
          action: "exhausted",
          reason: "chain-exhausted",
          from: snapshot.model,
          ...details,
        });
        halt(state);
        return;
      }
      const token = crypto.randomUUID();
      state.attempted.add(target.model);
      state.pending = { token, target, assistantID: snapshot.assistantID };
      operation = "dispatch";
      await host.dispatch(latest, target, token);
      if (!current(sessionID, state)) return;
      operation = "report";
      await host.report(sessionID, {
        action: "retry",
        reason: "execution-failed",
        from: snapshot.model,
        to: target.model,
        ...details,
      });
    } catch {
      if (!current(sessionID, state)) return;
      halt(state);
      await Promise.allSettled([
        Promise.resolve().then(() =>
          host.report(sessionID, {
            action: "stopped",
            reason: `${operation}-error`,
            ...details,
          }),
        ),
      ]);
    }
  }

  return {
    begin(sessionID: string, userID: string): void {
      if (disposed || sessions.get(sessionID)?.userID === userID) return;
      sessions.set(sessionID, {
        userID,
        active: true,
        error: false,
        seen: new Set(),
        attempted: new Set(),
        pending: undefined,
        recovery: undefined,
      });
    },
    failure(sessionID: string): void {
      const state = sessions.get(sessionID);
      if (state?.active) state.error = true;
    },
    async idle(sessionID: string): Promise<void> {
      const state = sessions.get(sessionID);
      if (!state || !current(sessionID, state)) return;
      const before = queues.get(sessionID);
      const next = Promise.withResolvers<void>();
      queues.set(sessionID, next.promise);
      await before;
      try {
        await process(sessionID, state);
      } finally {
        next.resolve();
        if (queues.get(sessionID) === next.promise) queues.delete(sessionID);
      }
    },
    acceptRetry(
      sessionID: string,
      token: string,
      userID: string,
      actualTarget: ExecutionTarget,
    ): boolean {
      const state = sessions.get(sessionID);
      const pending = state?.pending;
      if (
        !state ||
        !current(sessionID, state) ||
        !pending ||
        pending.token !== token ||
        pending.target.model !== actualTarget.model ||
        pending.target.variant !== actualTarget.variant
      )
        return false;
      state.pending = undefined;
      state.recovery = pending;
      state.userID = userID;
      return true;
    },
    stop(sessionID: string): void {
      const state = sessions.get(sessionID);
      if (state) halt(state);
    },
    forget(sessionID: string): void {
      sessions.delete(sessionID);
    },
    dispose(): void {
      disposed = true;
      sessions.clear();
    },
  };
}
