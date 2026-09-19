import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { startBackends } from "./support/backends.js";
import { isolatedOpenCode } from "./support/opencode.js";

describe.skipIf(process.env["OPENCODE_E2E"] !== "1")("real OpenCode 1.18.31", () => {
  test("registers virtual Auto when the fixture composes the production plugin", async () => {
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url);
    expect((await cli.command(["--version"])).stdout.trim()).toBe("1.18.31");

    const output = await cli.command(["models", "jev-router"]);

    expect(output.stdout.trim()).toBe("jev-router/auto");
    expect(backend.classifications).toHaveLength(0);
    expect(backend.completions).toHaveLength(0);
  }, 60_000);

  test("uses the classifier-selected backend when Auto is explicitly selected", async () => {
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url);

    const events = await cli.turn({ model: "jev-router/auto" });

    expect(backend.completions.map((request) => request.model)).toEqual(["fast"]);
    expect(backend.classifications).toHaveLength(1);
    expect(events.some((event) => event.part?.text === "fixture:fast")).toBe(true);
    expect(events.some((event) => event.type === "step_finish")).toBe(true);
    expect(backend.rejected).toEqual([]);
  }, 60_000);

  test("uses fallback without retry when the classifier returns HTTP 429", async () => {
    await using backend = startBackends();
    backend.behavior.rateLimited = true;
    await using cli = await isolatedOpenCode(backend.url);

    const events = await cli.turn({ model: "jev-router/auto" });

    expect(backend.completions.map((request) => request.model)).toEqual(["strong"]);
    expect(backend.classifications).toHaveLength(1);
    expect(events.some((event) => event.part?.text === "fixture:strong")).toBe(true);
    expect(backend.rejected).toEqual([]);
  }, 60_000);

  test("never calls the classifier when a real model is manually selected", async () => {
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url);

    const events = await cli.turn({ model: "mock/fast" });

    expect(backend.completions.map((request) => request.model)).toEqual(["fast"]);
    expect(backend.classifications).toHaveLength(0);
    expect(events.some((event) => event.part?.text === "fixture:fast")).toBe(true);
    expect(backend.rejected).toEqual([]);
  }, 60_000);

  test("keeps the pin across process restarts without a second classification", async () => {
    await using backend = startBackends();
    await using cli = await isolatedOpenCode(backend.url);
    const first = await cli.turn({ model: "jev-router/auto" });
    const sessionID = z.string().min(1).parse(first[0]?.sessionID);
    backend.behavior.rateLimited = true;

    const events = await cli.turn({ sessionID });

    expect(events.every((event) => event.sessionID === sessionID)).toBe(true);
    expect(backend.classifications).toHaveLength(1);
    expect(backend.completions.map((request) => request.model)).toEqual(["fast", "fast"]);
    expect(backend.rejected).toEqual([]);
  }, 120_000);
});
