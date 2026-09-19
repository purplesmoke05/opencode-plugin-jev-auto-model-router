import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { startBackends } from "./support/backends.js";
import { HarnessError, isolatedOpenCode } from "./support/opencode.js";

describe.skipIf(process.env["OPENCODE_E2E"] !== "1")(
  "conversation context in real OpenCode",
  () => {
    test("classifies once using only the latest assistant reply and current answer", async () => {
      // Given
      await using backend = startBackends();
      backend.behavior.contextual = true;
      await using cli = await isolatedOpenCode(backend.url, "auto");
      const origin = "IME変換候補の選択状態が更新されない原因を調べて";
      const first = await cli.turn({ model: "mock/fast", prompt: origin });
      const sessionID = z.string().min(1).parse(first[0]?.sessionID);
      // When
      await cli.turn({ sessionID, model: "jev-router/auto", prompt: "IMEですね" });
      // Then
      expect(backend.classifications[0]?.state).toMatchObject({
        current_request: "IMEですね",
        task_context: { previous_assistant: "fixture:fast", truncated: false },
      });
      const state = backend.classifications[0]?.state;
      if (!state || typeof state === "string")
        throw new HarnessError("Expected structured context at the HTTP boundary");
      expect(JSON.stringify(state)).not.toContain(origin);
      expect(JSON.stringify(state.task_context).length).toBeLessThanOrEqual(4000);
      expect(backend.completions.map((request) => request.model)).toEqual(["fast", "strong"]);
      expect(backend.classifications).toHaveLength(1);
    }, 120_000);

    test("sends only the current request when context is explicitly disabled", async () => {
      // Given
      await using backend = startBackends();
      await using cli = await isolatedOpenCode(backend.url, "auto", false);
      const first = await cli.turn({ model: "mock/strong", prompt: "Private earlier task." });
      const sessionID = z.string().min(1).parse(first[0]?.sessionID);
      // When
      await cli.turn({ sessionID, model: "jev-router/auto", prompt: "Current-request-only." });
      // Then
      expect(backend.classifications[0]?.state).toBe("Current-request-only.");
    }, 120_000);
  },
);
