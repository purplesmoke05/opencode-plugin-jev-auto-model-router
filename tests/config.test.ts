import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/config.js";

const options = {
  candidates: [
    { model: "local/fast", description: "Simple edits" },
    { model: "local/strong", description: "Complex changes" },
  ],
  fallback: "local/strong",
};

describe("configuration boundary", () => {
  test("supplies conservative defaults when the allowlist is valid", () => {
    // Given
    const input = structuredClone(options);
    // When
    const parsed = parseOptions(input);
    // Then
    expect(parsed).toMatchObject({
      mode: "auto",
      agents: ["build", "quick"],
      confidenceThreshold: 0.7,
    });
  });

  test.each(["auto", "force"])("accepts explicit routing mode %s", (mode) => {
    const input = { ...options, mode };
    const parsed = parseOptions(input);
    expect(parsed).toMatchObject({ mode });
  });

  test.each([
    { ...options, mode: "forced" },
    { ...options, mode: "FORCE" },
    { ...options, mode: null },
    { ...options, mode: true },
    { ...options, fallback: "other/model" },
    { ...options, candidates: [] },
    { ...options, candidates: [...options.candidates, options.candidates[0]] },
    { ...options, candidates: [{ model: "jev-router/auto", description: "Recursive" }] },
    { ...options, candidates: [{ model: "missing-provider", description: "Invalid" }] },
    { ...options, timeoutMs: 0 },
    { ...options, confidenceThreshold: 2 },
    { ...options, apiKey: "do-not-store-keys-in-config" },
    { ...options, agents: [] },
  ])("rejects unsafe or misspelled settings %#", (input) => {
    // Given: an invalid configuration
    // When / Then
    expect(() => parseOptions(input)).toThrow();
  });

  test("preserves slash-containing model IDs and explicit variants", () => {
    // Given
    const input = {
      candidates: [{ model: "synthetic/hf:org/model", description: "Edits", variant: "high" }],
      fallback: "synthetic/hf:org/model",
    };
    // When
    const parsed = parseOptions(input);
    // Then
    expect(parsed).toMatchObject(input);
  });
});
