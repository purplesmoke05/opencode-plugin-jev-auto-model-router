import { expect, test } from "bun:test";
import { startBackends } from "./support/backends.js";

test.each([
  ["GET", "/"],
  ["HEAD", "/"],
  ["GET", "/health"],
  ["HEAD", "/health"],
])(
  "keeps routing evidence clean when an unauthenticated probe sends %s %s",
  async (method, path) => {
    await using backend = startBackends();

    const response = await fetch(new URL(path, backend.url), {
      method,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.status).toBe(403);
    expect(backend.rejected).toEqual([]);
    expect(backend.unattributed).toEqual([`${method} ${path}`]);
    expect(backend.classifications).toEqual([]);
    expect(backend.completions).toEqual([]);
  },
);

test.each([
  ["GET", "/", "Bearer e2e-dummy", 403],
  ["HEAD", "/health", "Bearer e2e-dummy", 403],
  ["POST", "/wrong", "Bearer e2e-dummy", 404],
  ["GET", "/", "Bearer wrong-key", 403],
  ["GET", "/", "", 403],
  ["POST", "/", null, 403],
  ["PUT", "/health", null, 403],
  ["GET", "/jev", null, 403],
  ["HEAD", "/v1/chat/completions", null, 403],
  ["POST", "/jev", null, 403],
  ["POST", "/v1/chat/completions", null, 403],
  ["POST", "/jev", "Bearer wrong-key", 403],
  ["POST", "/v1/chat/completions", "Bearer wrong-key", 403],
] as const)(
  "retains a routing rejection when receiving %s %s with authorization %s",
  async (method, path, authorization, status) => {
    await using backend = startBackends();

    const response = await fetch(new URL(path, backend.url), {
      method,
      headers: authorization === null ? {} : { authorization },
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.status).toBe(status);
    expect(backend.rejected).toEqual([`${method} ${path}`]);
    expect(backend.unattributed).toEqual([]);
    expect(backend.classifications).toEqual([]);
    expect(backend.completions).toEqual([]);
  },
);

test.each([
  ["/jev", "not-json"],
  ["/jev", JSON.stringify({ model: "wrong" })],
  ["/v1/chat/completions", "not-json"],
  ["/v1/chat/completions", JSON.stringify({ model: "wrong" })],
])(
  "retains a routing rejection when authenticated %s receives malformed body %s",
  async (path, body) => {
    await using backend = startBackends();

    const response = await fetch(new URL(path, backend.url), {
      method: "POST",
      headers: { authorization: "Bearer e2e-dummy", "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.status).toBe(400);
    expect(backend.rejected).toHaveLength(1);
    expect(backend.unattributed).toEqual([]);
    expect(backend.classifications).toEqual([]);
    expect(backend.completions).toEqual([]);
  },
);

test("preserves exact routing evidence when two root probes overlap valid requests", async () => {
  await using backend = startBackends();
  const classification = {
    model: "jev-latest",
    state: "Reply with a greeting",
    questions: { route: { type: "choice", criteria: { c0: "fast", c1: "strong" } } },
  } satisfies (typeof backend.classifications)[number];
  const completion = {
    model: "fast",
    stream: true,
    messages: [{ role: "user" }],
  } satisfies (typeof backend.completions)[number];

  const responses = await Promise.all([
    ...["/", "/"].map((path) =>
      fetch(new URL(path, backend.url), { signal: AbortSignal.timeout(1_000) }),
    ),
    ...[
      { path: "/jev", body: classification },
      { path: "/v1/chat/completions", body: completion },
    ].map(({ path, body }) =>
      fetch(new URL(path, backend.url), {
        method: "POST",
        headers: { authorization: "Bearer e2e-dummy", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1_000),
      }),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([403, 403, 200, 200]);
  expect(backend.unattributed).toEqual(["GET /", "GET /"]);
  expect(backend.rejected).toEqual([]);
  expect(backend.classifications).toEqual([classification]);
  expect(backend.completions).toEqual([completion]);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
});
