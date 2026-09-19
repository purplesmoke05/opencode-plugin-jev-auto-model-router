import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/config.js";
import type { SessionPin, SessionPins } from "../src/contracts.js";
import { createSessionRouter } from "../src/session-router.js";

function fixture(sticky = true) {
  const saved = new Map<string, SessionPin>();
  const pins: SessionPins = {
    load: async (id) => saved.get(id),
    claim: async (id, pin) => {
      const selected = saved.get(id) ?? pin;
      saved.set(id, selected);
      return selected;
    },
    replace: async (id, pin) => {
      saved.set(id, pin);
    },
    forget: async (id) => {
      saved.delete(id);
    },
  };
  const options = parseOptions({
    mode: "force",
    sticky,
    candidates: [
      { model: "p/fast", description: "Basic" },
      { model: "p/strong", description: "Complex" },
    ],
    fallback: "p/fast",
  });
  const input = {
    sessionID: "one",
    apiKey: "test",
    available: options.candidates.map((c) => ({
      model: c.model,
      toolcall: true,
      modalities: ["text"],
    })),
    turn: {
      prompt: "task",
      agent: "quick",
      child: false,
      synthetic: false,
      auto: false,
      overridden: false,
      modalities: ["text"],
    },
  };
  return { pins, options, input };
}

describe("session-sticky model selection", () => {
  test("calls Jev only once and preserves the first model on later turns", async () => {
    const { pins, options, input } = fixture();
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => ({
        kind: "selected",
        model: ++calls === 1 ? "p/strong" : "p/fast",
        confidence: 1,
      }),
      pins,
    );
    await router.route(input);
    const result = await router.route({
      ...input,
      turn: { ...input.turn, prompt: "simple followup" },
    });
    expect(result).toMatchObject({ model: "p/strong", reason: "sticky" });
    expect(calls).toBe(1);
  });

  test("keeps independent model decisions for distinct session IDs", async () => {
    const { pins, options, input } = fixture();
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => ({
        kind: "selected",
        model: ++calls === 1 ? "p/strong" : "p/fast",
        confidence: 1,
      }),
      pins,
    );
    await router.route(input);
    const second = await router.route({
      ...input,
      sessionID: "child",
      turn: { ...input.turn, child: true },
    });
    expect(second).toMatchObject({ model: "p/fast" });
    expect(calls).toBe(2);
  });

  test("does not pin a fallback and retries classification on the next turn", async () => {
    const { pins, options, input } = fixture();
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => {
        calls++;
        return { kind: "unavailable", reason: "timeout" };
      },
      pins,
    );
    await router.route(input);
    const result = await router.route(input);
    expect(result).toMatchObject({ model: "p/fast", reason: "timeout", pinned: false });
    expect(calls).toBe(2);
  });

  test("serializes concurrent first turns within the same session", async () => {
    const { pins, options, input } = fixture();
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => {
        calls++;
        return { kind: "selected", model: "p/fast", confidence: 1 };
      },
      pins,
    );
    await Promise.all([router.route(input), router.route(input), router.route(input)]);
    expect(calls).toBe(1);
  });

  test("uses persisted pins after the router instance is recreated", async () => {
    const { pins, options, input } = fixture();
    await createSessionRouter(
      options,
      async () => ({ kind: "selected", model: "p/strong", confidence: 1 }),
      pins,
    ).route(input);
    let calls = 0;
    const result = await createSessionRouter(
      options,
      async () => {
        calls++;
        return { kind: "selected", model: "p/fast", confidence: 1 };
      },
      pins,
    ).route(input);
    expect(result).toMatchObject({ model: "p/strong", reason: "sticky" });
    expect(calls).toBe(0);
  });

  test("adopts an explicit OMO recovery model without another Jev decision", async () => {
    const { pins, options, input } = fixture();
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => {
        calls++;
        return { kind: "selected", model: "p/fast", confidence: 1 };
      },
      pins,
    );
    await router.route(input);
    await router.recover(input.sessionID, {
      model: "p/strong",
      reason: "runtime-recovery",
      recovery: true,
    });
    const result = await router.route(input);
    expect(result).toMatchObject({ model: "p/strong", reason: "sticky" });
    expect(calls).toBe(1);
  });

  test("does not silently reclassify when a pinned model is unavailable", async () => {
    const { pins, options, input } = fixture();
    const router = createSessionRouter(
      options,
      async () => ({ kind: "selected", model: "p/strong", confidence: 1 }),
      pins,
    );
    await router.route(input);
    await expect(
      router.route({ ...input, available: input.available.filter((m) => m.model !== "p/strong") }),
    ).rejects.toThrow("pinned");
  });

  test("retains per-turn routing when sticky is disabled", async () => {
    const { pins, options, input } = fixture(false);
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => {
        calls++;
        return { kind: "selected", model: "p/fast", confidence: 1 };
      },
      pins,
    );
    await router.route(input);
    await router.route(input);
    expect(calls).toBe(2);
  });

  test("pins only when unrounded confidence reaches 0.99", async () => {
    const { pins, options, input } = fixture();
    const decisions = [0.989, 0.99, 1];
    let calls = 0;
    const router = createSessionRouter(
      options,
      async () => ({
        kind: "selected",
        model: ++calls === 1 ? "p/strong" : "p/fast",
        confidence: decisions[calls - 1] ?? 1,
      }),
      pins,
    );
    const first = await router.route(input);
    expect(first).toMatchObject({ model: "p/strong", pinned: false });
    expect(await pins.load(input.sessionID)).toBeUndefined();
    const second = await router.route(input);
    expect(second).toMatchObject({ model: "p/fast", pinned: true });
    expect(await pins.load(input.sessionID)).toMatchObject({ model: "p/fast", confidence: 0.99 });
    const third = await router.route(input);
    expect(third).toMatchObject({ model: "p/fast", reason: "sticky" });
    expect(calls).toBe(2);
  });
});
