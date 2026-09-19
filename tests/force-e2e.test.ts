import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { createSessionPins } from "../src/session-pins.js";
import { startBackends } from "./support/backends.js";
import { isolatedOpenCode } from "./support/opencode.js";

describe.skipIf(process.env["OPENCODE_E2E"] !== "1")("forced routing in real OpenCode", () => {
  test("keeps classifying below 99 percent, then pins across process restarts", async () => {
    await using backend = startBackends();
    backend.behavior.confidence = 0.9;
    await using cli = await isolatedOpenCode(backend.url, "force");
    const first = await cli.turn({ model: "mock/strong" });
    const sessionID = z.string().min(1).parse(first[0]?.sessionID);
    await createSessionPins(
      join(cli.env.XDG_STATE_HOME, "opencode", "jev-router", "sessions"),
    ).claim(sessionID, {
      model: "mock/strong",
      reason: "timeout",
    });
    backend.behavior.confidence = 0.99;
    await cli.turn({ sessionID, model: "mock/strong" });
    backend.behavior.rateLimited = true;
    await cli.turn({ sessionID, model: "mock/strong" });
    expect(backend.classifications).toHaveLength(2);
    expect(backend.completions.map((request) => request.model)).toEqual(["fast", "fast", "fast"]);
  }, 120_000);

  test("overrides a manually selected real model", async () => {
    // Given
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url, "force");
    // When
    const events = await cli.turn({ model: "mock/strong" });
    // Then
    expect(backend.completions.map((request) => request.model)).toEqual(["fast"]);
    expect(backend.classifications).toHaveLength(1);
    expect(events.some((event) => event.part?.text === "fixture:fast")).toBe(true);
  }, 60_000);

  test("routes an explicitly pinned child without reclassifying the parent tool continuation", async () => {
    // Given
    await using backend = startBackends();
    backend.behavior.delegate = true;
    await using cli = await isolatedOpenCode(backend.url, "force");
    // When
    await cli.turn({ model: "mock/strong" });
    // Then
    expect(backend.classifications).toHaveLength(2);
    expect(backend.completions.map((request) => request.model)).toEqual(["fast", "fast", "fast"]);
    expect(backend.rejected).toEqual([]);
  }, 60_000);

  test("preserves an OMO retry-marked selected model without calling Jev", async () => {
    // Given
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url, "force");
    // When
    await cli.turn({
      model: "mock/strong",
      prompt:
        "Retry the prior request.\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_RUNTIME_FALLBACK_RETRY -->",
    });
    // Then
    expect(backend.classifications).toHaveLength(0);
    expect(backend.completions.map((request) => request.model)).toEqual(["strong"]);
  }, 60_000);

  test("keeps the first model without reclassification on later forced turns", async () => {
    // Given
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url, "force");
    const first = await cli.turn({ model: "mock/strong" });
    const sessionID = z.string().min(1).parse(first[0]?.sessionID);
    backend.behavior.rateLimited = true;
    // When
    await cli.turn({ sessionID, model: "mock/fast" });
    // Then
    expect(backend.classifications).toHaveLength(1);
    expect(backend.completions.map((request) => request.model)).toEqual(["fast", "fast"]);
  }, 120_000);
});
