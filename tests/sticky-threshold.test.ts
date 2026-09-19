import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../src/config.js";
import { createSessionPins } from "../src/session-pins.js";

const options = { candidates: [{ model: "p/model", description: "A model" }], fallback: "p/model" };

describe("pin confidence threshold", () => {
  test("defaults to 99 percent independently of the acceptance threshold", () => {
    expect(parseOptions(options)).toMatchObject({
      confidenceThreshold: 0.7,
      stickyConfidenceThreshold: 0.99,
    });
  });
  test.each([-0.1, 1.1, "99", Number.NaN])("rejects an invalid threshold %s", (value) => {
    expect(() => parseOptions({ ...options, stickyConfidenceThreshold: value })).toThrow();
  });
  test("preserves qualifying confidence when a pin is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jev-confidence-"));
    try {
      await createSessionPins(directory).claim("session", {
        model: "p/model",
        reason: "jev",
        confidence: 0.99,
      });
      expect(await createSessionPins(directory).load("session")).toEqual({
        model: "p/model",
        reason: "jev",
        confidence: 0.99,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
