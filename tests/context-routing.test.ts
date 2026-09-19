import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/config.js";
import type { DecisionRequest, TaskContext } from "../src/contracts.js";
import { createDecider } from "../src/jev.js";
import { createRouter } from "../src/router.js";

const rawOptions = {
  candidates: [
    { model: "example/fast", description: "Routine" },
    { model: "example/strong", description: "Complex" },
  ],
  fallback: "example/fast",
};
const context: TaskContext = {
  previous_assistant: "Which input method are you using?",
  truncated: false,
};

describe("context-aware routing", () => {
  test("provides bounded context defaults and an explicit opt-out", () => {
    expect(parseOptions(rawOptions)).toMatchObject({
      context: { enabled: true, maxCharacters: 4000 },
    });
    expect(parseOptions({ ...rawOptions, context: { enabled: false } })).toMatchObject({
      context: { enabled: false },
    });
  });

  test.each([
    { maxCharacters: 0 },
    { maxCharacters: 24001 },
    { maxMessages: 0 },
    { maxMessages: 33 },
    { rawToolOutput: true },
  ])("rejects invalid context bounds %#", (settings) => {
    expect(() => parseOptions({ ...rawOptions, context: settings })).toThrow();
  });

  test("passes conversation context alongside a short current request", async () => {
    // Given
    let captured: DecisionRequest | undefined;
    const router = createRouter(parseOptions(rawOptions), async (request) => {
      captured = request;
      return { kind: "selected", model: "example/strong", confidence: 0.9 };
    });
    // When
    const result = await router({
      turn: {
        prompt: "IMEですね",
        agent: "quick",
        child: false,
        auto: true,
        overridden: false,
        synthetic: false,
        modalities: ["text"],
      },
      available: rawOptions.candidates.map((candidate) => ({
        model: candidate.model,
        toolcall: true,
        modalities: ["text"],
      })),
      apiKey: "test",
      context,
    });
    // Then
    expect(captured?.prompt).toBe("IMEですね");
    expect(captured?.context).toEqual(context);
    expect(result).toMatchObject({
      model: "example/strong",
      contextMessages: 1,
      contextTruncated: false,
    });
  });

  test("sends structured state with the original task to the real HTTP boundary", async () => {
    // Given
    let state: unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body: unknown = await request.json();
        if (body && typeof body === "object" && "state" in body) state = body.state;
        return Response.json({
          answers: {
            route: { type: "choice", choice: "c1", confidence: 1, probabilities: { c0: 0, c1: 1 } },
          },
        });
      },
    });
    try {
      // When
      const result = await createDecider(server.url.href)({
        prompt: "IMEですね",
        context,
        candidates: rawOptions.candidates,
        apiKey: "test",
        timeoutMs: 1000,
      });
      // Then
      expect(state).toEqual({ current_request: "IMEですね", task_context: context });
      expect(result).toEqual({ kind: "selected", model: "example/strong", confidence: 1 });
    } finally {
      await server.stop(true);
    }
  });

  test("never forwards supplied history when context is disabled", async () => {
    let captured: DecisionRequest | undefined;
    const router = createRouter(
      parseOptions({ ...rawOptions, context: { enabled: false } }),
      async (request) => {
        captured = request;
        return { kind: "selected", model: "example/fast", confidence: 1 };
      },
    );
    await router({
      turn: {
        prompt: "Current",
        agent: "quick",
        child: false,
        auto: true,
        overridden: false,
        synthetic: false,
        modalities: ["text"],
      },
      available: rawOptions.candidates.map((candidate) => ({
        model: candidate.model,
        toolcall: true,
        modalities: ["text"],
      })),
      apiKey: "test",
      context,
    });
    expect(captured?.context).toBeUndefined();
  });

  test("retains configured fallback and reports the actual low confidence with context metadata", async () => {
    const router = createRouter(parseOptions(rawOptions), async () => ({
      kind: "selected",
      model: "example/strong",
      confidence: 0.2,
    }));
    const result = await router({
      turn: {
        prompt: "Current",
        agent: "quick",
        child: false,
        auto: true,
        overridden: false,
        synthetic: false,
        modalities: ["text"],
      },
      available: rawOptions.candidates.map((candidate) => ({
        model: candidate.model,
        toolcall: true,
        modalities: ["text"],
      })),
      apiKey: "test",
      context,
    });
    expect(result).toMatchObject({
      model: "example/fast",
      reason: "low-confidence",
      confidence: 0.2,
      contextMessages: 1,
    });
  });
});
