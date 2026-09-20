import { expect } from "bun:test";
import type { RouterOptions } from "../../src/config.js";
import type {
  ExecutionHost,
  ExecutionModel,
  ExecutionNotice,
  ExecutionSnapshot,
  ExecutionTarget,
} from "../../src/contracts.js";
import { createExecutionController } from "../../src/execution-controller.js";

export const targets = [{ model: "p/A" }, { model: "p/B", variant: "max" }, { model: "p/C" }];
export const chains: RouterOptions["executionFallbacks"] = [{ models: targets }];

export function snapshot(patch: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    sessionID: "session",
    userID: "user",
    assistantID: "assistant-A",
    model: "p/A",
    agent: "build",
    idle: true,
    blocked: false,
    complete: true,
    failed: true,
    retryable: true,
    modalities: ["text"],
    requestOptions: { tools: { edit: true } },
    ...patch,
  };
}

export function fixture(config = chains) {
  const state = {
    snapshot: snapshot(),
    models: targets.map(
      (target): ExecutionModel => ({
        model: target.model,
        toolcall: true,
        modalities: ["text", "image"],
        variants: ["max"],
      }),
    ),
  };
  const dispatched: { snapshot: ExecutionSnapshot; target: ExecutionTarget; token: string }[] = [];
  const notices: ExecutionNotice[] = [];
  const recovered: ExecutionTarget[] = [];
  const host: ExecutionHost = {
    inspect: async () => state.snapshot,
    models: async () => state.models,
    dispatch: async (snapshot, target, token) => {
      dispatched.push({ snapshot, target, token });
    },
    report: async (_sessionID, notice) => {
      notices.push(notice);
    },
    recovered: async (_sessionID, target) => {
      recovered.push(target);
    },
  };
  function create(overrides: Partial<ExecutionHost> = {}) {
    const controller = createExecutionController(config, { ...host, ...overrides });
    controller.begin("session", "user");
    return controller;
  }
  function accept(controller: ReturnType<typeof create>, userID = "retry-user") {
    const request = dispatched.at(-1);
    if (!request) throw new Error("Expected a dispatch before acceptance");
    expect(controller.acceptRetry("session", request.token, userID, request.target)).toBe(true);
    state.snapshot = snapshot({
      userID,
      model: request.target.model,
      assistantID: `assistant-${userID}`,
    });
    return request;
  }
  return { state, host, dispatched, notices, recovered, create, accept };
}
