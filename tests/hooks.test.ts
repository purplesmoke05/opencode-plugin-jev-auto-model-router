import { describe, expect, test } from "bun:test";
import type { Config, Hooks } from "@opencode-ai/plugin";
import { parseOptions } from "../src/config.js";
import { createHooks, type Host } from "../src/hooks.js";
import type { RouteResult } from "../src/router.js";

const options = parseOptions({
  candidates: [
    { model: "a/fast", description: "Simple" },
    { model: "b/strong", description: "Complex", variant: "high" },
  ],
  fallback: "b/strong",
});

function fixture() {
  const reports: RouteResult[] = [];
  const host: Host = {
    models: async () =>
      options.candidates.map((c) => ({ model: c.model, toolcall: true, modalities: ["text"] })),
    session: async () => ({ child: false, modalities: [] }),
    report: async (_id, result) => {
      reports.push(result);
    },
    apiKey: () => "test",
  };
  const output: Parameters<NonNullable<Hooks["chat.message"]>>[1] = {
    message: {
      role: "user",
      id: "msg_1",
      sessionID: "ses_1",
      time: { created: 0 },
      agent: "quick",
      model: { providerID: "jev-router", modelID: "auto" },
    },
    parts: [
      { type: "text", id: "prt_1", messageID: "msg_1", sessionID: "ses_1", text: "Fix a typo" },
      {
        type: "text",
        id: "prt_2",
        messageID: "msg_1",
        sessionID: "ses_1",
        text: "private file contents",
        synthetic: true,
      },
    ],
  };
  return { host, reports, output };
}

describe("OpenCode hooks", () => {
  test("registers a selectable Auto without changing existing providers or the default model", async () => {
    // Given
    const { host } = fixture();
    const config: Config = { model: "a/fast", provider: { existing: { name: "Existing" } } };
    const hooks = createHooks(host, options, async () => ({
      kind: "selected",
      model: "a/fast",
      confidence: 1,
    }));
    // When
    await hooks.config?.(config);
    // Then
    expect(config.provider?.["jev-router"]?.models?.["auto"]?.name).toBe("Auto (Jev)");
    expect(config.provider?.["existing"]).toEqual({ name: "Existing" });
    expect(config.model).toBe("a/fast");
  });

  test("rewrites the execution model while excluding synthetic context from Jev", async () => {
    // Given
    const { host, output, reports } = fixture();
    const prompts: string[] = [];
    const hooks = createHooks(host, options, async (request) => {
      prompts.push(request.prompt);
      return { kind: "selected", model: "a/fast", confidence: 1 };
    });
    // When
    await hooks["chat.message"]?.({ sessionID: "ses_1" }, output);
    // Then
    expect(output.message.model).toEqual({ providerID: "a", modelID: "fast" });
    expect(prompts).toEqual(["Fix a typo"]);
    expect(reports).toHaveLength(1);
    expect(output.message.agent).toBe("quick");
  });

  test("clears stale variants and applies the chosen candidate variant", async () => {
    // Given
    const { host, output } = fixture();
    const hooks = createHooks(host, options, async () => ({
      kind: "selected",
      model: "b/strong",
      confidence: 1,
    }));
    // When
    await hooks["chat.message"]?.({ sessionID: "ses_1", variant: "stale" }, output);
    // Then
    const expected = { providerID: "b", modelID: "strong", variant: "high" };
    expect(output.message.model).toEqual(expected);
  });

  test("does not query local session state or Jev for manually selected models", async () => {
    // Given
    const { host, output } = fixture();
    output.message.model = { providerID: "a", modelID: "fast" };
    let calls = 0;
    const hooks = createHooks(
      {
        ...host,
        session: async () => {
          calls++;
          return { child: false, modalities: [] };
        },
      },
      options,
      async () => {
        calls++;
        return { kind: "selected", model: "b/strong", confidence: 1 };
      },
    );
    // When
    await hooks["chat.message"]?.({ sessionID: "ses_1" }, output);
    // Then
    expect(calls).toBe(0);
    expect(output.message.model).toEqual({ providerID: "a", modelID: "fast" });
  });

  test("fails closed on provider ID collision", async () => {
    // Given
    const { host } = fixture();
    const hooks = createHooks(host, options, async () => ({
      kind: "selected",
      model: "a/fast",
      confidence: 1,
    }));
    // When / Then
    await expect(
      hooks.config?.({ provider: { "jev-router": { name: "Someone else" } } }),
    ).rejects.toThrow();
  });
});
