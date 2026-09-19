import { afterEach, expect, test } from "bun:test";
import type { DecisionRequest } from "../src/contracts.js";
import { createDecider } from "../src/jev.js";

const request: DecisionRequest = {
  prompt: "Diagnose a concurrent cache failure",
  candidates: [
    { model: "provider/fast", description: "Simple tasks" },
    { model: "provider/deep", description: "Complex reasoning" },
  ],
  apiKey: "local-test-key",
  timeoutMs: 1_000,
};
const route = {
  type: "choice",
  choice: "c1",
  confidence: 0.85,
  probabilities: { c0: 0.15, c1: 0.85 },
} as const;
const servers: Bun.Server<undefined>[] = [];

function serve(fetch: (incoming: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server;
}

function reply(answer: unknown = route) {
  return Response.json({ answers: { route: answer } });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

test("selects only the indexed candidate when Jev returns a valid choice", async () => {
  const server = serve(() => reply());

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({ kind: "selected", model: "provider/deep", confidence: 0.85 });
});

test("sends the exact Choice envelope and Bearer auth when routing a prompt", async () => {
  const received: unknown[] = [];
  const server = serve(async (incoming) => {
    const body: unknown = await incoming.json();
    received.push({
      method: incoming.method,
      authorization: incoming.headers.get("authorization"),
      contentType: incoming.headers.get("content-type"),
      body,
    });
    return reply();
  });

  await createDecider(server.url.href)(request);

  expect(received).toEqual([
    {
      method: "POST",
      authorization: "Bearer local-test-key",
      contentType: "application/json",
      body: {
        model: "jev-latest",
        state: request.prompt,
        questions: {
          route: {
            type: "choice",
            instructions: expect.any(String),
            criteria: {
              c0: "provider/fast: Simple tasks",
              c1: "provider/deep: Complex reasoning",
            },
          },
        },
      },
    },
  ]);
});

test.each([
  ["unknown choice", { ...route, choice: "c2" }],
  ["raw model ID", { ...route, choice: "provider/deep" }],
  ["prototype key", { ...route, choice: "__proto__" }],
  ["noncanonical index", { ...route, choice: "c01" }],
  ["missing confidence", { type: "choice", choice: "c1", probabilities: route.probabilities }],
  ["negative confidence", { ...route, confidence: -0.1 }],
  ["excess confidence", { ...route, confidence: 1.1 }],
  ["string confidence", { ...route, confidence: "0.85" }],
  ["wrong answer type", { ...route, type: "boolean" }],
  ["missing probabilities", { type: "choice", choice: "c1", confidence: 0.85 }],
  ["invalid probabilities", { ...route, probabilities: { c0: -1, c1: 2 } }],
  ["missing answer", null],
])("rejects the response when it has %s", async (_name, answer) => {
  const server = serve(() => reply(answer));

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({ kind: "unavailable", reason: "invalid-response" });
});

test.each([0, 1])("accepts confidence when it equals the boundary %s", async (confidence) => {
  const server = serve(() => reply({ ...route, confidence }));

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({ kind: "selected", model: "provider/deep", confidence });
});

test("rejects malformed JSON when the HTTP response succeeds", async () => {
  const server = serve(() => new Response("not-json"));

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({ kind: "unavailable", reason: "invalid-response" });
});

test.each(["120", "Wed, 21 Oct 2026 07:28:00 GMT"])(
  "reports Retry-After %s without retrying when the server returns 429",
  async (retryAfter) => {
    let calls = 0;
    const server = serve(() => {
      calls += 1;
      return new Response("sensitive error body", {
        status: 429,
        headers: { "Retry-After": retryAfter },
      });
    });

    const result = await createDecider(server.url.href)(request);

    expect({ result, calls }).toEqual({
      result: { kind: "unavailable", reason: "http-error", status: 429, retryAfter },
      calls: 1,
    });
  },
);

test("bounds and sanitizes Retry-After when a server sends untrusted header text", async () => {
  const server = serve(
    () =>
      new Response(null, {
        status: 503,
        headers: { "Retry-After": `12\t${"x".repeat(200)}` },
      }),
  );

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({
    kind: "unavailable",
    reason: "http-error",
    status: 503,
    retryAfter: `12${"x".repeat(126)}`,
  });
});

test("omits Retry-After when an HTTP error has no retry guidance", async () => {
  const server = serve(() => new Response(null, { status: 401 }));

  const result = await createDecider(server.url.href)(request);

  expect(result).toEqual({ kind: "unavailable", reason: "http-error", status: 401 });
});

test("times out when response headers never arrive", async () => {
  const pending = Promise.withResolvers<Response>();
  const server = serve(() => pending.promise);

  try {
    const result = await createDecider(server.url.href)({ ...request, timeoutMs: 100 });

    expect(result).toEqual({ kind: "unavailable", reason: "timeout" });
  } finally {
    pending.resolve(reply());
  }
});

test("times out when headers arrive but the streamed body never completes", async () => {
  const server = serve(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"answers":'));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );

  const result = await createDecider(server.url.href)({ ...request, timeoutMs: 100 });

  expect(result).toEqual({ kind: "unavailable", reason: "timeout" });
});

test("reports a network error when the local endpoint is unreachable", async () => {
  const server = serve(() => reply());
  const endpoint = server.url.href;
  await server.stop(true);

  const result = await createDecider(endpoint)(request);

  expect(result).toEqual({ kind: "unavailable", reason: "network-error" });
});

test("does not forward the key when a server redirects the request", async () => {
  let forwarded = 0;
  const target = serve(() => {
    forwarded += 1;
    return reply();
  });
  const server = serve(() => Response.redirect(target.url.href, 307));

  const result = await createDecider(server.url.href)(request);

  expect({ result, forwarded }).toEqual({
    result: { kind: "unavailable", reason: "network-error" },
    forwarded: 0,
  });
});
