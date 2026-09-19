import { describe, expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import { parseOptions } from "../src/config.js";
import { createHooks, type Host } from "../src/hooks.js";

function setup(child = true) {
  const options = {
    ...parseOptions({
      candidates: [
        { model: "model/fast", description: "Ordinary work" },
        { model: "model/strong", description: "Complex work" },
      ],
      fallback: "model/fast",
    }),
    mode: "force" as const,
  };
  const prompts: string[] = [];
  const access: string[] = [];
  const host: Host = {
    models: async () => {
      access.push("models");
      return options.candidates.map((candidate) => ({
        model: candidate.model,
        toolcall: true,
        modalities: ["text"],
      }));
    },
    session: async () => {
      access.push("session");
      return { child, modalities: [] };
    },
    apiKey: () => "test",
    report: async () => {
      access.push("report");
    },
  };
  const output: Parameters<NonNullable<Hooks["chat.message"]>>[1] = {
    message: {
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 0 },
      agent: "explore",
      model: { providerID: "model", modelID: "strong" },
      tools: { edit: false },
    },
    parts: [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Find where this function is defined.",
      },
    ],
  };
  const hooks = createHooks(host, options, async (request) => {
    prompts.push(request.prompt);
    return { kind: "selected", model: "model/fast", confidence: 1 };
  });
  return { hooks, output, prompts, access };
}

describe("forced model override", () => {
  test("routes an explicitly pinned delegated task without changing its agent or permissions", async () => {
    // Given
    const { hooks, output, prompts } = setup();
    // When
    await hooks["chat.message"]?.(
      { sessionID: "session", model: { providerID: "model", modelID: "strong" } },
      output,
    );
    // Then
    expect(output.message.model).toEqual({ providerID: "model", modelID: "fast" });
    expect(output.message.agent).toBe("explore");
    expect(output.message.tools).toEqual({ edit: false });
    expect(prompts).toHaveLength(1);
  });

  test.each(["title", "summary", "compaction"])(
    "preserves internal agent %s without catalog or session calls",
    async (agent) => {
      // Given
      const { hooks, output, access, prompts } = setup();
      output.message.agent = agent;
      // When
      await hooks["chat.message"]?.({ sessionID: "session" }, output);
      // Then
      expect(output.message.model).toEqual({ providerID: "model", modelID: "strong" });
      expect(access).toEqual([]);
      expect(prompts).toEqual([]);
    },
  );

  test.each([
    "Find the function.\n\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_RUNTIME_FALLBACK_RETRY -->",
    "Find the function.\n\n<!--  OMO_INTERNAL_INITIATOR  -->\n<!--  OMO_RUNTIME_FALLBACK_RETRY  -->",
  ])("preserves OMO retry-selected model for its exact protocol marker", async (text) => {
    // Given
    const { hooks, output, access, prompts } = setup();
    output.parts = [{ type: "text", id: "part", sessionID: "session", messageID: "message", text }];
    // When
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    // Then
    expect(output.message.model).toEqual({ providerID: "model", modelID: "strong" });
    expect(access).toEqual([]);
    expect(prompts).toEqual([]);
  });

  test("preserves synthetic continuation without silently assigning fallback", async () => {
    // Given
    const { hooks, output, access } = setup();
    output.parts = [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Continue",
        synthetic: true,
      },
    ];
    // When
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    // Then
    expect(output.message.model).toEqual({ providerID: "model", modelID: "strong" });
    expect(access).toEqual([]);
  });

  test("does not mistake an ordinary request about retries for an internal retry", async () => {
    // Given
    const { hooks, output, prompts } = setup();
    output.parts = [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Explain the protocol marker <!-- OMO_RUNTIME_FALLBACK_RETRY --> in this source file.",
      },
    ];
    // When
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    // Then
    expect(prompts).toHaveLength(1);
    expect(output.message.model).toEqual({ providerID: "model", modelID: "fast" });
  });

  test("preserves OMO internal notifications without reclassifying them", async () => {
    const { hooks, output, access } = setup(false);
    output.parts = [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Task completed.\n<!-- OMO_INTERNAL_INITIATOR -->",
      },
    ];
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    expect(access).toEqual(["session"]);
    expect(output.message.model).toEqual({ providerID: "model", modelID: "strong" });
  });

  test("explains how to disable forced routing when the fallback cannot handle attachments", async () => {
    const { hooks, output } = setup();
    output.parts.push({
      type: "file",
      id: "file",
      sessionID: "session",
      messageID: "message",
      mime: "image/png",
      url: "data:image/png;base64,AA==",
    });
    await expect(hooks["chat.message"]?.({ sessionID: "session" }, output)).rejects.toThrow(
      "Disable force mode",
    );
  });

  test("routes OMO task-marked child prompts rather than treating them as notifications", async () => {
    const { hooks, output, prompts } = setup();
    output.parts = [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Locate the function.\n<!-- OMO_INTERNAL_INITIATOR -->",
      },
    ];
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    expect(output.message.model).toEqual({ providerID: "model", modelID: "fast" });
    expect(prompts).toEqual(["Locate the function."]);
  });

  test("preserves child no-reply notifications", async () => {
    const { hooks, output, prompts } = setup();
    output.parts = [
      {
        type: "text",
        id: "part",
        sessionID: "session",
        messageID: "message",
        text: "Finished.\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->",
      },
    ];
    await hooks["chat.message"]?.({ sessionID: "session" }, output);
    expect(output.message.model).toEqual({ providerID: "model", modelID: "strong" });
    expect(prompts).toEqual([]);
  });
});
