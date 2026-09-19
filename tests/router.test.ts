import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/config.js";
import type { DecisionRequest, DecisionResult } from "../src/contracts.js";
import { createRouter, type RouteTurn, RoutingError } from "../src/router.js";

const options = parseOptions({
  candidates: [
    { model: "a/fast", description: "Small fixes" },
    { model: "b/strong", description: "Risky work", variant: "high" },
  ],
  fallback: "b/strong",
});
const turn: RouteTurn = {
  prompt: "Fix a typo",
  agent: "quick",
  child: false,
  synthetic: false,
  auto: true,
  overridden: false,
  modalities: ["text"],
};
const available = [
  { model: "a/fast", toolcall: true, modalities: ["text"] },
  { model: "b/strong", toolcall: true, modalities: ["text", "image"] },
];
const selection: DecisionResult = { kind: "selected", model: "a/fast", confidence: 0.95 };

describe("per-turn routing policy", () => {
  test("routes to the allowlisted Jev choice when confident", async () => {
    // Given
    const router = createRouter(options, async () => selection);
    // When
    const result = await router({ turn, available, apiKey: "test" });
    // Then
    expect(result).toMatchObject({
      kind: "route",
      model: "a/fast",
      reason: "jev",
      confidence: 0.95,
    });
  });

  test.each([
    { ...turn, auto: false },
    { ...turn, overridden: true },
  ])("preserves explicit model choices and earlier plugin overrides %#", async (input) => {
    // Given
    let calls = 0;
    const router = createRouter(options, async () => {
      calls++;
      return selection;
    });
    // When
    const result = await router({ turn: input, available, apiKey: "test" });
    // Then
    expect(result).toEqual({ kind: "skip" });
    expect(calls).toBe(0);
  });

  test.each([
    [{ ...turn, child: true }, "scope-fallback"],
    [{ ...turn, agent: "explore" }, "scope-fallback"],
    [{ ...turn, agent: "title" }, "scope-fallback"],
    [{ ...turn, agent: "summary" }, "scope-fallback"],
    [{ ...turn, agent: "compaction" }, "scope-fallback"],
    [{ ...turn, synthetic: true }, "synthetic-fallback"],
    [{ ...turn, prompt: "" }, "empty-prompt"],
    [{ ...turn, prompt: "a".repeat(12001) }, "prompt-too-long"],
  ] as const)(
    "resolves inherited Auto without sending excluded inputs to Jev: %s",
    async (input, reason) => {
      // Given
      let calls = 0;
      const router = createRouter(options, async () => {
        calls++;
        return selection;
      });
      // When
      const result = await router({ turn: input, available, apiKey: "test" });
      // Then
      expect(result).toMatchObject({ model: "b/strong", variant: "high", reason });
      expect(calls).toBe(0);
    },
  );

  test("uses fallback without an API key", async () => {
    // Given
    let calls = 0;
    const router = createRouter(options, async () => {
      calls++;
      return selection;
    });
    // When
    const result = await router({ turn, available, apiKey: "" });
    // Then
    expect(result).toMatchObject({ model: "b/strong", reason: "missing-key" });
    expect(calls).toBe(0);
  });

  test.each([
    [{ kind: "selected", model: "a/fast", confidence: 0.2 }, "low-confidence"],
    [{ kind: "selected", model: "unlisted/model", confidence: 1 }, "invalid-choice"],
    [{ kind: "unavailable", reason: "timeout" }, "timeout"],
  ] as const)("falls back on an unusable decision: %s", async (decision, reason) => {
    // Given
    const router = createRouter(options, async () => decision);
    // When
    const result = await router({ turn, available, apiKey: "test" });
    // Then
    expect(result).toMatchObject({ model: "b/strong", reason });
  });

  test("excludes incapable models from the decision request", async () => {
    // Given
    let sent: DecisionRequest | undefined;
    const router = createRouter(options, async (request) => {
      sent = request;
      return { kind: "selected", model: "b/strong", confidence: 1 };
    });
    // When
    const result = await router({
      turn: { ...turn, modalities: ["image"] },
      available,
      apiKey: "test",
    });
    // Then
    expect(sent?.candidates.map((candidate) => candidate.model)).toEqual(["b/strong"]);
    expect(result).toMatchObject({ model: "b/strong" });
  });

  test("blocks rather than silently choosing another model if fallback is unavailable", async () => {
    // Given
    const router = createRouter(options, async () => selection);
    // When / Then
    expect(router({ turn, available: [], apiKey: "test" })).rejects.toThrow("fallback");
  });

  test("preserves HTTP 429 metadata without retrying", async () => {
    // Given
    let calls = 0;
    const router = createRouter(options, async () => {
      calls++;
      return { kind: "unavailable", reason: "http-error", status: 429, retryAfter: "60" };
    });
    // When
    const result = await router({ turn, available, apiKey: "test" });
    // Then
    expect(result).toMatchObject({ model: "b/strong", status: 429, retryAfter: "60" });
    expect(calls).toBe(1);
  });
});

describe("forced routing policy", () => {
  test.each([
    { ...turn, auto: false },
    { ...turn, auto: false, child: true },
    { ...turn, overridden: true },
    { ...turn, child: true },
    { ...turn, agent: "explore" },
    { ...turn, retry: false },
  ])("classifies ordinary turns regardless of model or scope %#", async (input) => {
    let calls = 0;
    const router = createRouter(
      parseOptions({ ...options, mode: "force", agents: ["plan"] }),
      async () => {
        calls++;
        return selection;
      },
    );
    const result = await router({ turn: input, available, apiKey: "test" });
    expect(result).toMatchObject({ kind: "route", model: "a/fast", reason: "jev" });
    expect(calls).toBe(1);
  });

  test.each([
    { ...turn, synthetic: true },
    { ...turn, retry: true },
    { ...turn, agent: "title" },
    { ...turn, agent: "summary" },
    { ...turn, agent: "compaction" },
  ])("skips excluded turns without classification or fallback validation %#", async (input) => {
    let calls = 0;
    const router = createRouter(
      parseOptions({ ...options, mode: "force", agents: [input.agent] }),
      async () => {
        calls++;
        return selection;
      },
    );
    const result = await router({ turn: input, available: [], apiKey: "" });
    expect(result).toEqual({ kind: "skip" });
    expect(calls).toBe(0);
  });
});

describe.each(["auto", "force"] as const)("shared %s routing contracts", (mode) => {
  test.each([{ available }, { available: [] }])("preserves flagged retries %#", async (catalog) => {
    let calls = 0;
    const router = createRouter(parseOptions({ ...options, mode }), async () => {
      calls++;
      return selection;
    });
    const input: RouteTurn = { ...turn, retry: true };
    const result = await router({ turn: input, available: catalog.available, apiKey: "test" });
    expect(result).toEqual({ kind: "skip" });
    expect(calls).toBe(0);
  });

  test.each([
    [{ kind: "selected", model: "a/fast", confidence: 0.2 }, "low-confidence"],
    [{ kind: "selected", model: "unlisted/model", confidence: 1 }, "invalid-choice"],
    [{ kind: "unavailable", reason: "timeout" }, "timeout"],
  ] as const)(
    "retains fallback selection when the decision is unusable: %s",
    async (decision, reason) => {
      const router = createRouter(parseOptions({ ...options, mode }), async () => decision);
      const result = await router({ turn, available, apiKey: "test" });
      expect(result).toMatchObject({ kind: "route", model: "b/strong", variant: "high", reason });
    },
  );

  test.each([
    [turn, "", "missing-key"],
    [{ ...turn, prompt: "" }, "test", "empty-prompt"],
    [{ ...turn, prompt: "a".repeat(12001) }, "test", "prompt-too-long"],
  ] as const)(
    "falls back without classification for invalid request inputs %#",
    async (input, apiKey, reason) => {
      let calls = 0;
      const router = createRouter(parseOptions({ ...options, mode }), async () => {
        calls++;
        return selection;
      });
      const result = await router({ turn: input, available, apiKey });
      expect(result).toMatchObject({ model: "b/strong", reason });
      expect(calls).toBe(0);
    },
  );

  test.each([
    { available: [] },
    { available: [{ model: "b/strong", toolcall: false, modalities: ["text"] }] },
    { available: [{ model: "b/strong", toolcall: true, modalities: ["image"] }] },
  ])("blocks when the configured fallback is ineligible %#", async (catalog) => {
    const router = createRouter(parseOptions({ ...options, mode }), async () => selection);
    await expect(
      router({ turn, available: catalog.available, apiKey: "test" }),
    ).rejects.toBeInstanceOf(RoutingError);
  });

  test("filters incompatible candidates before classification", async () => {
    let sent: DecisionRequest | undefined;
    const router = createRouter(parseOptions({ ...options, mode }), async (request) => {
      sent = request;
      return { kind: "selected", model: "b/strong", confidence: 1 };
    });
    const result = await router({
      turn: { ...turn, modalities: ["image"] },
      available,
      apiKey: "test",
    });
    expect(sent?.candidates.map((candidate) => candidate.model)).toEqual(["b/strong"]);
    expect(result).toMatchObject({ model: "b/strong", variant: "high", reason: "jev" });
  });
});

test("respects the configured agent allowlist in auto mode", async () => {
  let calls = 0;
  const router = createRouter(
    parseOptions({ ...options, mode: "auto", agents: ["plan"] }),
    async () => {
      calls++;
      return selection;
    },
  );
  const result = await router({ turn, available, apiKey: "test" });
  expect(result).toMatchObject({ model: "b/strong", reason: "scope-fallback" });
  expect(calls).toBe(0);
});
