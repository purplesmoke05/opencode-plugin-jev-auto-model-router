import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { parseOptions } from "../src/config.js";
import { createExecutionHost } from "../src/execution-host.js";
import { parseExecutionSnapshot } from "../src/execution-snapshot.js";
import { createMemorySessionPins } from "../src/session-pins.js";
import { createSessionRouter } from "../src/session-router.js";

const options = parseOptions({
  candidates: [{ model: "a/deepseek", description: "Main" }],
  fallback: "a/deepseek",
});
function data(name = "APIError", status = 503) {
  return {
    statuses: {},
    permissions: [],
    questions: [],
    history: [
      {
        info: {
          id: "u",
          role: "user",
          time: { created: 1 },
          tools: { bash: false },
          system: "Read-only investigation",
          format: { type: "text" },
        },
        parts: [{ type: "file", mime: "image/png" }],
      },
      {
        info: {
          id: "a",
          role: "assistant",
          parentID: "u",
          time: { created: 2, completed: 3 },
          providerID: "a",
          modelID: "deepseek",
          agent: "quick",
          error: {
            name,
            data: {
              statusCode: status,
              isRetryable: false,
              responseHeaders: { "Retry-After": "120" },
            },
          },
        },
        parts: [],
      },
    ],
  };
}

test("attributes failure to the actual assistant model and preserves request restrictions", () => {
  expect(parseExecutionSnapshot("s", data())).toMatchObject({
    model: "a/deepseek",
    retryable: true,
    status: 503,
    retryAfter: "120",
    idle: true,
    failed: true,
    modalities: ["text", "image"],
    requestOptions: {
      tools: { bash: false },
      system: "Read-only investigation",
      format: { type: "text" },
    },
  });
});
test.each([
  ["MessageAbortedError", 503],
  ["UnknownError", 503],
  ["APIError", 400],
  ["APIError", 401],
])("does not retry %s %i", (name, status) => {
  expect(parseExecutionSnapshot("s", data(String(name), Number(status)))?.retryable).toBe(false);
});
test("blocks pending questions and busy sessions", () => {
  expect(parseExecutionSnapshot("s", { ...data(), questions: [{ sessionID: "s" }] })?.blocked).toBe(
    true,
  );
  expect(parseExecutionSnapshot("s", { ...data(), statuses: { s: { type: "busy" } } })?.idle).toBe(
    false,
  );
});
test("sends a synthetic continuation, not a replay, with model variant and tool restrictions", async () => {
  let body: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      body = await request.json();
      return new Response(null, { status: 204 });
    },
  });
  try {
    const host = createExecutionHost(
      { client: createOpencodeClient({ baseUrl: server.url.href }), directory: "/test" },
      options,
    );
    const snapshot = parseExecutionSnapshot("s", data());
    if (!snapshot) throw new Error("Expected snapshot");
    await host.dispatch(snapshot, { model: "b/deepseek", variant: "max" }, crypto.randomUUID());
    expect(body).toMatchObject({
      model: { providerID: "b", modelID: "deepseek" },
      variant: "max",
      agent: "quick",
      tools: { bash: false },
      system: "Read-only investigation",
      format: { type: "text" },
      parts: [{ type: "text", synthetic: true }],
    });
  } finally {
    await server.stop(true);
  }
});

test("validates finite, nonoverlapping execution chains", () => {
  const chain = {
    models: [
      { model: "a/deepseek", variant: "max" },
      { model: "b/deepseek", variant: "max" },
    ],
  };
  expect(parseOptions({ ...options, executionFallbacks: [chain] }).executionFallbacks).toEqual([
    chain,
  ]);
  expect(() => parseOptions({ ...options, executionFallbacks: [chain, chain] })).toThrow();
  expect(() =>
    parseOptions({ ...options, executionFallbacks: [{ models: [{ model: "a/deepseek" }] }] }),
  ).toThrow();
});

test("a late recovery does not replace a different model family's qualified pin", async () => {
  const pins = createMemorySessionPins();
  await pins.claim("session", { model: "openai/gpt", reason: "jev", confidence: 1 });
  const router = createSessionRouter(
    options,
    async () => ({ kind: "selected", model: "a/deepseek", confidence: 1 }),
    pins,
  );
  await router.recover(
    "session",
    { model: "b/deepseek", reason: "execution-fallback", recovery: true },
    ["a/deepseek", "b/deepseek"],
  );
  expect(await pins.load("session")).toMatchObject({ model: "openai/gpt" });
});
